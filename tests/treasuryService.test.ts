// TDD GREEN PHASE: Tests define and verify treasury service behavior.
// Run `npx jest tests/treasuryService.test.ts`
import crypto from "crypto";

// Mock environment before imports
const MOCK_SECRET = crypto.randomBytes(32).toString("hex");

describe("treasuryService", () => {
  beforeEach(() => {
    process.env.TREASURY_ENCRYPTION_SECRET = MOCK_SECRET;
  });
  afterEach(() => {
    delete process.env.TREASURY_ENCRYPTED_KEY;
    delete process.env.TREASURY_ENCRYPTION_SECRET;
  });

  describe("encryptTreasuryKey + decryptTreasuryKeypair", () => {
    it("round-trips: encrypted then decrypted returns same public key", async () => {
      const { encryptTreasuryKey, decryptTreasuryKeypair } = await import("../src/solana/treasuryService");
      const { Keypair } = await import("@solana/web3.js");
      // Use Keypair.generate() for a valid ed25519 key pair
      const original = Keypair.generate();
      process.env.TREASURY_ENCRYPTED_KEY = encryptTreasuryKey(original.secretKey);
      const recovered = decryptTreasuryKeypair();
      expect(recovered.publicKey.toBase58()).toBe(original.publicKey.toBase58());
    });

    it("decryptTreasuryKeypair throws when TREASURY_ENCRYPTED_KEY not set", async () => {
      const { decryptTreasuryKeypair } = await import("../src/solana/treasuryService");
      expect(() => decryptTreasuryKeypair()).toThrow("TREASURY_ENCRYPTED_KEY not set");
    });

    it("getTreasuryPublicKey returns base58 string matching keypair publicKey", async () => {
      const { encryptTreasuryKey, decryptTreasuryKeypair, getTreasuryPublicKey } = await import("../src/solana/treasuryService");
      const { Keypair } = await import("@solana/web3.js");
      const original = Keypair.generate();
      process.env.TREASURY_ENCRYPTED_KEY = encryptTreasuryKey(original.secretKey);
      expect(getTreasuryPublicKey()).toBe(decryptTreasuryKeypair().publicKey.toBase58());
    });
  });

  describe("getDbcClient", () => {
    it("returns same instance on repeated calls (singleton)", async () => {
      process.env.SOLANA_RPC_URL = "https://api.devnet.solana.com";
      const { getDbcClient } = await import("../src/solana/dbcClient");
      const client1 = getDbcClient();
      const client2 = getDbcClient();
      expect(client1).toBe(client2);
    });

    it("throws if SOLANA_RPC_URL not set", async () => {
      delete process.env.SOLANA_RPC_URL;
      // Reset module to clear singleton
      jest.resetModules();
      const { getDbcClient } = await import("../src/solana/dbcClient");
      expect(() => getDbcClient()).toThrow("SOLANA_RPC_URL not set");
    });
  });
});
