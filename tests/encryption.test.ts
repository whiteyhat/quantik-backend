import { decrypt, encrypt, isEncryptionEnabled } from "../src/infra/encryption";

describe("encryption helpers", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;
  const originalClerkSecretKey = process.env.CLERK_SECRET_KEY;

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
    process.env.CLERK_SECRET_KEY = originalClerkSecretKey;
  });

  test("encrypts and decrypts using ENCRYPTION_KEY when configured", () => {
    process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.CLERK_SECRET_KEY = "";

    const ciphertext = encrypt("top-secret");

    expect(ciphertext).not.toBe("top-secret");
    expect(decrypt(ciphertext)).toBe("top-secret");
    expect(isEncryptionEnabled()).toBe(true);
  });

  test("falls back to a derived key from backend secrets when ENCRYPTION_KEY is missing", () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_runtime_fallback";

    const ciphertext = encrypt("temporary-wallet-bundle");

    expect(ciphertext).not.toBe("temporary-wallet-bundle");
    expect(decrypt(ciphertext)).toBe("temporary-wallet-bundle");
    expect(isEncryptionEnabled()).toBe(true);
  });
});
