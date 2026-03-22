import { Keypair } from "@solana/web3.js";
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // AES-256 = 32 bytes
const IV_LENGTH = 12;  // GCM recommended IV = 12 bytes

function getEncryptionKey(): Buffer {
  const secret = process.env.TREASURY_ENCRYPTION_SECRET;
  if (!secret) throw new Error("TREASURY_ENCRYPTION_SECRET not set in environment");
  const keyBytes = Buffer.from(secret, "hex");
  if (keyBytes.length !== KEY_LENGTH) throw new Error("TREASURY_ENCRYPTION_SECRET must be 32 bytes (64 hex chars)");
  return keyBytes;
}

// Encrypts a treasury keypair's secret key bytes for storage.
// Returns format: "{iv_hex}:{authTag_hex}:{ciphertext_hex}"
export function encryptTreasuryKey(secretKeyBytes: Uint8Array): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretKeyBytes)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

// Decrypts TREASURY_ENCRYPTED_KEY → Solana Keypair. Never logged. Never stored raw.
export function decryptTreasuryKeypair(): Keypair {
  const encrypted = process.env.TREASURY_ENCRYPTED_KEY;
  if (!encrypted) throw new Error("TREASURY_ENCRYPTED_KEY not set in environment");
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("TREASURY_ENCRYPTED_KEY must be in format iv:authTag:ciphertext");
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return Keypair.fromSecretKey(new Uint8Array(decrypted));
}

// Returns the treasury public key as base58 string (safe to log or store in DB).
export function getTreasuryPublicKey(): string {
  return decryptTreasuryKeypair().publicKey.toBase58();
}
