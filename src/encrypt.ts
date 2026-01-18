import crypto from 'crypto';

/**
 * Encrypts a string value using AES-256-GCM
 * @param value - The string to encrypt
 * @param keyHex - 64-character hexadecimal key (0-f)
 * @returns Encrypted string in format: iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(value: string, keyHex: string): string {
  // Validate key format
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error('Key must be 64 hexadecimal characters (0-f)');
  }

  // Convert hex key to buffer (32 bytes for AES-256)
  const key = Buffer.from(keyHex, 'hex');
  
  // Generate random IV (12 bytes is recommended for GCM)
  const iv = crypto.randomBytes(12);
  
  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt the data
  let encrypted = cipher.update(value, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Get authentication tag
  const authTag = cipher.getAuthTag();
  
  // Return IV:authTag:encrypted (all in hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}