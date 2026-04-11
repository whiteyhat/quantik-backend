// ─────────────────────────────────────────────────────────────────────────────
// ERC-8004 Configuration — Provider, Signer, Contract Instances
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the ethers v6 pattern from polymarket-prep.service.ts.
// Connects to Sepolia testnet for hackathon deployment.
// All three ERC-8004 registries (Identity, Reputation, Validation) are
// instantiated lazily from environment variables.
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import IDENTITY_ABI from "./abis/IdentityRegistry.json";
import REPUTATION_ABI from "./abis/ReputationRegistry.json";
import VALIDATION_ABI from "./abis/ValidationRegistry.json";

// ── Configuration from environment ──────────────────────────────────────────

export const ERC8004_CONFIG = {
  rpcUrl: process.env.ERC8004_RPC_URL || "https://sepolia.infura.io/v3/demo",
  identityRegistry: process.env.ERC8004_IDENTITY_REGISTRY || "",
  reputationRegistry: process.env.ERC8004_REPUTATION_REGISTRY || "",
  validationRegistry: process.env.ERC8004_VALIDATION_REGISTRY || "",
  privateKey: process.env.ERC8004_PRIVATE_KEY || "",
};

// ── Provider & Signer ───────────────────────────────────────────────────────

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(ERC8004_CONFIG.rpcUrl);
}

export function getSigner(): ethers.Wallet {
  return new ethers.Wallet(ERC8004_CONFIG.privateKey, getProvider());
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
  return !!(ERC8004_CONFIG.privateKey && ERC8004_CONFIG.identityRegistry);
}
