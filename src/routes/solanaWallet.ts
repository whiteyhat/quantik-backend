import { Router, Request, Response } from "express";
import { getDb } from "../db/schema";
import { getUserIdAsync } from "../middleware/auth";
import { isPgEnabled, pgQueryOne, pgExec } from "../db/postgres";
import nacl from "tweetnacl";

const router = Router();

async function getRequiredUserId(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdAsync(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return userId;
}

/**
 * Verify a Solana message signature.
 * The frontend signs a message like "Sign to connect to Quantik: {walletAddress} at {timestamp}"
 * using the wallet's private key. We verify ownership without holding the private key.
 */
function verifySolanaSignature(
  message: string,
  signatureBase64: string,
  walletAddressBase58: string
): boolean {
  try {
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = Uint8Array.from(Buffer.from(signatureBase64, "base64"));

    // Decode base58 public key (32 bytes)
    const bs58Chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let decoded = BigInt(0);
    for (const char of walletAddressBase58) {
      const idx = bs58Chars.indexOf(char);
      if (idx < 0) return false;
      decoded = decoded * BigInt(58) + BigInt(idx);
    }
    const pubKeyBytes = new Uint8Array(32);
    let temp = decoded;
    for (let i = 31; i >= 0; i--) {
      pubKeyBytes[i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }

    return nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
  } catch (err) {
    console.error("[solanaWallet:verify] signature verification error:", err instanceof Error ? err.message : err);
    return false;
  }
}

// ── POST /api/solana/link-wallet ──────────────────────────────────────────
// Links a Solana wallet to the current Clerk user.
// Body: { walletAddress: string, signature: string, message: string }
router.post("/link-wallet", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    const { walletAddress, signature, message } = req.body as {
      walletAddress?: string;
      signature?: string;
      message?: string;
    };

    if (!walletAddress || !signature || !message) {
      res.status(400).json({ error: "walletAddress, signature, and message are required" });
      return;
    }

    // Validate message format: must contain the wallet address to prevent replay attacks
    if (!message.includes(walletAddress)) {
      res.status(400).json({ error: "Message does not reference the wallet address" });
      return;
    }

    // Verify ownership
    const isValid = verifySolanaSignature(message, signature, walletAddress);
    if (!isValid) {
      res.status(403).json({ error: "Signature verification failed" });
      return;
    }

    // Store in DB — one wallet per user (D-01, D-02)
    if (isPgEnabled()) {
      await pgExec(
        "UPDATE users SET solana_wallet_address = $1 WHERE id = $2",
        [walletAddress, userId]
      );
    } else {
      const db = getDb();
      db.prepare("UPDATE users SET solana_wallet_address = ? WHERE id = ?")
        .run(walletAddress, userId);
    }

    res.json({ success: true, walletAddress });
  } catch (err) {
    console.error("[solanaWallet:link] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to link wallet" });
  }
});

// ── DELETE /api/solana/link-wallet ────────────────────────────────────────
// Unlinks the Solana wallet from the current Clerk user (D-04).
router.delete("/link-wallet", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    if (isPgEnabled()) {
      await pgExec(
        "UPDATE users SET solana_wallet_address = NULL WHERE id = $1",
        [userId]
      );
    } else {
      const db = getDb();
      db.prepare("UPDATE users SET solana_wallet_address = NULL WHERE id = ?").run(userId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("[solanaWallet:unlink] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to unlink wallet" });
  }
});

// ── GET /api/solana/wallet-status ─────────────────────────────────────────
// Returns the current wallet link status for the Clerk user.
router.get("/wallet-status", async (req: Request, res: Response) => {
  try {
    const userId = await getRequiredUserId(req, res);
    if (!userId) return;

    let walletAddress: string | null = null;

    if (isPgEnabled()) {
      const row = await pgQueryOne<{ solana_wallet_address: string | null }>(
        "SELECT solana_wallet_address FROM users WHERE id = $1",
        [userId]
      );
      walletAddress = row?.solana_wallet_address ?? null;
    } else {
      const db = getDb();
      const row = db
        .prepare("SELECT solana_wallet_address FROM users WHERE id = ?")
        .get(userId) as { solana_wallet_address: string | null } | undefined;
      walletAddress = row?.solana_wallet_address ?? null;
    }

    res.json({ linked: !!walletAddress, walletAddress });
  } catch (err) {
    console.error("[solanaWallet:status] error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to get wallet status" });
  }
});

export default router;
