import * as core from '@actions/core';
import * as artifact from '@actions/artifact';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readFile } from 'fs/promises';
import { encrypt } from './encrypt';
import { OAuthToken, refreshToken } from './oauth';

const CHECK_PROMPT = 'This is a no-op health check. Do not generate code, do not modify files, and do not use tools. Reply only with "OK".';

interface Secret {
  readonly name: string;
  readonly value: string;
}

export type CLIInstallCommand = string[];

export type CLIRunCommand = [
  command: string,
  args?: string[]
];

export interface GeminiAuthConfig {
  selectedType: 'oauth-personal' | 'api-key';
}

export interface GeminiSecurityConfig {
  auth: GeminiAuthConfig;
}

export interface GeminiSettings {
  security: GeminiSecurityConfig;
}

export interface GeminiClientConfig {
  configDir: string;
  settings: GeminiSettings;
  tokenEnv: string;
  packageName: string;
  runCmd: CLIRunCommand;
}

export interface QwenAuthConfig {
  selectedType: 'qwen-oauth' | 'api-key';
}

export interface QwenSecurityConfig {
  auth: QwenAuthConfig;
}

export interface QwenSettings {
  security: QwenSecurityConfig;
  $version: number;
}

export interface QwenClientConfig {
  configDir: string;
  settings: QwenSettings;
  tokenEnv: string;
  packageName: string;
  runCmd: CLIRunCommand;
}

export type AgentConfig = GeminiClientConfig | QwenClientConfig;

const AGENTS = [ 'gemini', 'qwen' ];

export async function readTextFile(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<string> {
  return await readFile(filePath, { encoding });
}

function logCommand(command: string, args: string[]) {
  const quoteArg = (arg: string) => {
    // If no spaces or special chars, return as-is
    if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;

    // Escape existing double quotes and backslashes
    const escaped = arg.replace(/(["\\])/g, '\\$1');
    return `"${escaped}"`;
  };

  const cmdLine = [command, ...args.map(quoteArg)].join(' ');
  console.log('> ' + cmdLine);
}

async function runCommand(
  command: string,
  args: string[],
  { stdin, hideError }: { stdin?: string; hideError?: boolean } = {}
): Promise<string> {
  logCommand(command, args);

  return new Promise((resolve, reject) => {
    let output = '';
    let error = '';
    let settled = false;

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const succeed = (result: string) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    // 🔴 THIS IS THE CRITICAL PART
    child.on('error', (err) => {
      fail(err);
    });

    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    child.stdout.on('data', (data) => {
      const text = data.toString().replace(/\r/g, '\n');
      process.stdout.write(text);
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      if (!hideError) {
        const text = data.toString().replace(/\r/g, '\n');
        process.stdout.write(text);
      }
      error += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`${command} exited with code ${code}\n${error}`));
      } else {
        succeed(output.trim());
      }
    });
  });
}

export function getAgentConfig(agent: string): AgentConfig {
  const home = os.homedir();

  if (agent === 'gemini') {
    return {
      configDir: path.join(home, '.gemini'),
      settings: {
        security: {
          auth: {
            selectedType: 'oauth-personal',
          },
        },
      },
      tokenEnv: 'PROMPTOPS_GEMINI_TOKEN',
      packageName: '@google/gemini-cli',
      runCmd: ['gemini', ['-y']],
    };
  }

  if (agent === 'qwen') {
    return {
      configDir: path.join(home, '.qwen'),
      settings: {
        security: {
          auth: {
            selectedType: 'qwen-oauth',
          },
        },
        $version: 2,
      },
      tokenEnv: 'PROMPTOPS_QWEN_TOKEN',
      packageName: '@qwen-code/qwen-code',
      runCmd: ['qwen', ['-y']],
    };
  }

  throw new Error(`Unsupported agent: ${agent}`);
}

async function setupConfig(agent: string, config: AgentConfig): Promise<void> {
  const token = process.env[config.tokenEnv];

  if (!token) {
    throw new Error(`Missing required secret: ${config.tokenEnv}`);
  }

  const tokenData = JSON.parse(token) as OAuthToken;

  if (tokenData.refresh_token === undefined) {
    throw new Error('Missing refresh token');
  }

  const updatedToken = agent === 'gemini' ? await refreshToken(agent, tokenData.refresh_token) : token;

  fs.mkdirSync(config.configDir, { recursive: true });

  fs.writeFileSync(
    path.join(config.configDir, 'settings.json'),
    JSON.stringify(config.settings, null, 2),
  );

  fs.writeFileSync(
    path.join(config.configDir, 'oauth_creds.json'),
    updatedToken,
  );

  core.info(`Config initialized in ${config.configDir}`);
}

export async function installAgent(agent: string, config: AgentConfig) {
  const { packageName } = config;

  let installedVersion = '';

  core.info(`Checking if ${agent} CLI is installed...`);

  // 1️⃣ Check if CLI is installed
  try {
    installedVersion = (await runCommand(agent, ['--version'], { hideError: true })).trim();
    core.info(`${agent} installed version: ${installedVersion}`);
  } catch {
    core.info(`${agent} CLI not found locally`);
  }

  // 2️⃣ Get latest version from npm
  let latestVersion = '';
  try {
    latestVersion = (await runCommand('npm', ['view', packageName, 'version'])).trim();
    core.info(`${agent} latest npm version: ${latestVersion}`);
  } catch (err) {
    core.warning(`Failed to get latest npm version for ${agent}: ${(err as any).message}`);
  }

  // 3️⃣ Decide whether to install/update
  if (!installedVersion) {
    core.info(`${agent} CLI not installed. Installing...`);
    await runCommand('npm', ['install', '-g', packageName]);
  } else if (latestVersion && installedVersion !== latestVersion) {
    core.info(`${agent} CLI is outdated (installed: ${installedVersion}, latest: ${latestVersion}). Updating...`);
    await runCommand('npm', ['install', '-g', `${packageName}@${latestVersion}`]);
  } else {
    core.info(`${agent} CLI is up-to-date`);
  }
}

async function runAgent(config: AgentConfig, prompt: string, model: string): Promise<string> {
  const cmd = config.runCmd[0] as string;
  const args = config.runCmd[1] as string[];
  const modelArgs = (model === '') || (model === '-') ? [] : ['-m', model];
  return runCommand(cmd, [...args, ...modelArgs], { stdin: prompt });
}

async function setupGit() {
  await runCommand('git', ['config', 'user.name', 'github-actions']);
  await runCommand('git', ['config', 'user.email', 'github-actions@github.com']);
}

async function prepareBranch(branch: string) {
  // -B makes it safe if branch already exists
  await runCommand('git', ['checkout', '-B', branch]);
}

async function commitChanges(message: string): Promise<boolean> {
  await runCommand('git', ['add', '.']);

  const status = await runCommand(
    'git',
    ['status', '--porcelain'],
  );

  if (!status.trim()) {
    console.log('No changes detected, skipping commit');
    return false;
  }

  await runCommand('git', ['commit', '-m', message]);
  return true;
}

async function push(branch: string) {
  await runCommand('git', ['push', '-u', 'origin', branch]);
}

async function createPullRequest(branch: string): Promise<string> {
  const output = await runCommand('gh', [
    'pr',
    'create',
    '--title',
    'PromptOps agent output',
    '--body',
    'Automated PR generated by PromptOps',
    '--head',
    branch,
    '--base',
    'main',
  ]);

  // gh pr create prints the PR URL to stdout
  const match = output.match(
    /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/
  );

  if (!match) {
    throw new Error(
      `PR was created but URL could not be parsed from output:\n${output}`
    );
  }

  return match[0];
}

/**
 * Upload a GitHub Actions artifact
 */
export async function createArtifact(
  name: string,
  files: string[],
): Promise<void> {
  if (files.length === 0) {
    throw new Error('No files provided for artifact upload');
  }

  // Convert to absolute paths
  const absoluteFiles = files.map((file) => {
    const absPath = path.resolve(file);

    if (!fs.existsSync(absPath)) {
      throw new Error(`Artifact file does not exist: ${absPath}`);
    }

    return absPath;
  });

  // Root must be a COMMON parent directory
  const rootDirectory = path.dirname(absoluteFiles[0]);

  const client = new artifact.DefaultArtifactClient();

  await client.uploadArtifact(
    name,
    absoluteFiles,
    rootDirectory,
  );
}

async function runPrompt(): Promise<void> {
  try {
    const raw = core.getInput('task', { required: true });

    let task;
    try {
      task = JSON.parse(raw);
    } catch {
      throw new Error('Invalid JSON in task input');
    }

    const { prompt, agent, model, taskLocalId } = task;

    if ([prompt, agent, model, taskLocalId].some(v => v === undefined)) {
      throw new Error('Missing required fields in Github Actions parameters');
    }

    const branch = `promptops/${taskLocalId}`;

    const config = getAgentConfig(agent);
    await setupConfig(agent, config);
    await installAgent(agent, config);

    await setupGit();
    await prepareBranch(branch);

    console.log('Prompt:');
    console.log(prompt);
    console.log();

    // const output =
    await runAgent(config, prompt, model);
    // core.setOutput('result', output);
    const committed = await commitChanges('Add agent output');

    let prUrl: string | undefined = undefined;

    if (committed) {
      await push(branch);
      prUrl = await createPullRequest(branch);
    }

    const apiKey = process.env['PROMPTOPS_API_KEY'];
    if (!apiKey) {
      throw new Error('PROMPTOPS_API_KEY is not set');
    }

    const outputPath = 'result.json';
    const content = await readTextFile(path.join(config.configDir, 'oauth_creds.json'));
    const data = JSON.stringify({ secrets: [{ name: config.tokenEnv, value: content }], prUrl });

    await fs.promises.writeFile(
      outputPath,
      encrypt(data, apiKey),
    );

    await createArtifact(
      'promptops-result',
      [outputPath]
    );

  } catch (error: any) {
    core.setFailed(error.message);
  }
}

async function runRefresh(): Promise<void> {
  const result: Secret[] = [];
  const apiKey = process.env['PROMPTOPS_API_KEY'];
  if (!apiKey) {
    throw new Error('PROMPTOPS_API_KEY is not set');
  }

  for (const agent of AGENTS) {
    try {
      const config = getAgentConfig(agent);
      await setupConfig(agent, config);
      const value = await readTextFile(path.join(config.configDir, 'oauth_creds.json'));
      result.push({ name: config.tokenEnv, value });
    } catch (err) {
      console.error(`Failed to refresh ${agent} token`, err);
    }
  }

  if (result.length !== 0) {
    const outputPath = 'result.json';
    const data = JSON.stringify(result);

    await fs.promises.writeFile(
      outputPath,
      encrypt(data, apiKey),
    );

    await createArtifact(
      'promptops-result',
      [outputPath]
    );
  }
}

async function run() {
  const eventName = process.env.GITHUB_EVENT_NAME;

  if (eventName === 'schedule') {
    await runRefresh();
  } else {
    await runPrompt();
  }
}

run();
