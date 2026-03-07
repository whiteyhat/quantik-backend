// ── AES-256-GCM Encryption — API key encryption at rest ──────────────────────
//
// Encrypts sensitive values (Polymarket private keys, API tokens) before
// storing in the database. Uses a server-side encryption key from env.
//
// ENV: ENCRYPTION_KEY — 32-byte hex string (64 chars). Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-char hex string (32 bytes). " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(keyHex, "hex");
}

/** Returns true if ENCRYPTION_KEY is configured */
export function isEncryptionEnabled(): boolean {
  const key = process.env.ENCRYPTION_KEY;
  return !!key && key.length === 64;
}

/**
 * Encrypt a plaintext string.
 * Returns: base64 string in format: iv:ciphertext:authTag
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();

  return `${iv.toString("base64")}:${encrypted}:${authTag.toString("base64")}`;
}

/**
 * Decrypt a string encrypted by encrypt().
 * Input: base64 string in format: iv:ciphertext:authTag
 */
export function decrypt(encryptedStr: string): string {
  const key = getEncryptionKey();
  const parts = encryptedStr.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format — expected iv:ciphertext:authTag");
  }

  const iv = Buffer.from(parts[0], "base64");
  const encrypted = parts[1];
  const authTag = Buffer.from(parts[2], "base64");

  if (iv.length !== IV_LENGTH || authTag.length !== TAG_LENGTH) {
    throw new Error("Invalid IV or auth tag length");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
