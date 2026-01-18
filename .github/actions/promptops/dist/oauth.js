"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshToken = refreshToken;
function objectToUrlEncoded(data) {
    return Object.keys(data)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
        .join('&');
}
async function refreshOAuthToken({ tokenEndpoint, clientId, clientSecret, refreshToken, }) {
    const body = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
    };
    const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: objectToUrlEncoded(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token refresh failed: ${res.status} ${text}`);
    }
    return { refresh_token: refreshToken, ...res.json() };
}
const GEMINI_OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_OAUTH_CLIENT_SECRET = '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';
async function refreshGeminiToken(refreshToken) {
    const updateToken = await refreshOAuthToken({
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        clientId: GEMINI_OAUTH_CLIENT_ID,
        clientSecret: GEMINI_OAUTH_CLIENT_SECRET,
        refreshToken,
    });
    return JSON.stringify(updateToken, null, 2);
}
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
async function refreshQwenToken(refreshToken) {
    console.log('refreshQwenToken:', refreshToken);
    const updateToken = await refreshOAuthToken({
        tokenEndpoint: 'https://chat.qwen.ai/api/v1/oauth2/token',
        clientId: QWEN_OAUTH_CLIENT_ID,
        refreshToken,
    });
    console.log(updateToken);
    const tokenToSave = {
        ...updateToken,
        expires_at: Date.now() + updateToken.expires_in * 1000,
    };
    return JSON.stringify(tokenToSave, null, 2);
}
async function refreshToken(agent, refreshToken) {
    if (agent === 'gemini') {
        return await refreshGeminiToken(refreshToken);
    }
    if (agent === 'qwen') {
        return await refreshQwenToken(refreshToken);
    }
    throw new Error(`Unsupported agent: ${agent}`);
}
