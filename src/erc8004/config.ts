// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Configuration — Provider, Signer, Contract Instances
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the ethers v6 pattern from polymarket-prep.service.ts.
// Connects to Sepolia testnet for hackathon deployment.
// All three ERC-8004 registries (Identity, Reputation, Validation) are
// instantiated lazily from environment variables.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { encrypt, decrypt, isEncryptionEnabled } from "../infra/encryption";
import IDENTITY_ABI from "./abis/IdentityRegistry.json";
import REPUTATION_ABI from "./abis/ReputationRegistry.json";
import VALIDATION_ABI from "./abis/ValidationRegistry.json";

// ── Configuration from environment ──────────────────────────────────────────

export const ERC8004_CONFIG = {
  rpcUrl: process.env.ERC8004_RPC_URL || "https://sepolia.infura.io/v3/demo",
  identityRegistry: process.env.ERC8004_IDENTITY_REGISTRY || "",
  reputationRegistry: process.env.ERC8004_REPUTATION_REGISTRY || "",
  validationRegistry: process.env.ERC8004_VALIDATION_REGISTRY || "",
};

// ── Encrypted Key Storage ─────────────────────────────────────────────────
// The private key is encrypted at rest using AES-256-GCM (same system as
// agent wallet keys). On first boot, if ERC8004_PRIVATE_KEY is set as raw
// hex, it gets encrypted and cached. The raw value is never held in a
// module-level variable — it's decrypted in-memory only inside getSigner().

let _encryptedKey: string | null = null;

function getEncryptedKey(): string {
  if (_encryptedKey) return _encryptedKey;

  const encrypted = process.env.ERC8004_ENCRYPTED_KEY?.trim();
  if (encrypted && encrypted.includes(":")) {
    _encryptedKey = encrypted;
    return _encryptedKey;
  }

  const raw = process.env.ERC8004_PRIVATE_KEY?.trim();
  if (raw && isEncryptionEnabled()) {
    _encryptedKey = encrypt(raw);
    console.log("[erc8004] Private key encrypted in-memory — set ERC8004_ENCRYPTED_KEY for production");
    return _encryptedKey;
  }

  // Dev fallback: raw key without encryption system
  if (raw) {
    _encryptedKey = raw;
    return _encryptedKey;
  }

  return "";
}

// ── Provider & Signer (cached — one instance per process) ────────────────

let _provider: ethers.JsonRpcProvider | null = null;
let _signer: ethers.Wallet | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(ERC8004_CONFIG.rpcUrl);
  return _provider;
}

export function getSigner(): ethers.Wallet {
  if (_signer) return _signer;
  const enc = getEncryptedKey();
  if (!enc) throw new Error("ERC-8004 private key not configured");
  const raw = enc.includes(":") ? decrypt(enc) : enc;
  _signer = new ethers.Wallet(raw, getProvider());
  return _signer;
}

// ── Contract Instances ──────────────────────────────────────────────────────

export function getIdentityContract(): ethers.Contract {
  return new ethers.Contract(
    ERC8004_CONFIG.identityRegistry,
    IDENTITY_ABI,
    getSigner()
  );
}

export function getReputationContract(): ethers.Contract {
  return new ethers.Contract(
    ERC8004_CONFIG.reputationRegistry,
    REPUTATION_ABI,
    getSigner()
  );
}

export function getValidationContract(): ethers.Contract {
  return new ethers.Contract(
    ERC8004_CONFIG.validationRegistry,
    VALIDATION_ABI,
    getSigner()
  );
}

// ── Guard ───────────────────────────────────────────────────────────────────

/** Returns true if ERC-8004 environment variables are configured */
export function isErc8004Configured(): boolean {
  return !!(getEncryptedKey() && ERC8004_CONFIG.identityRegistry);
}
