// ── Kraken CLI wrapper — mirrors src/cli.ts pattern ─────────────
import { exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

const execAsync = promisify(exec);

// Resolved path to the kraken binary. May be a full path (env var) or
// just "kraken" (resolved via PATH). Updated by ensureKrakenInstalled().
let KRAKEN_BIN = process.env.KRAKEN_CLI || "kraken";

// Tracks whether we've already confirmed the binary exists this process.
let cliReady: boolean | null = null;
let cliReadyPromise: Promise<void> | null = null;

export class KrakenCliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "KrakenCliError";
  }
}

// ── resolveKrakenPath ────────────────────────────────────────────
// Checks KRAKEN_CLI env var, then PATH, then common install locations.

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

export async function resolveKrakenPath(): Promise<string | null> {
  // 1. If KRAKEN_BIN is an absolute path and exists on disk, use it
  if (KRAKEN_BIN.startsWith("/") && existsSync(KRAKEN_BIN)) {
    return KRAKEN_BIN;
  }

  // 2. If KRAKEN_BIN is a command name, check if it's on PATH
  if (!KRAKEN_BIN.startsWith("/") && (await commandExists(KRAKEN_BIN))) {
    return KRAKEN_BIN;
  }

  // 3. Check common install candidate paths
  const home = process.env.HOME || "/root";
  const candidates = [
    `${home}/.cargo/bin/kraken`,
    `${home}/.local/bin/kraken`,
    `/usr/local/bin/kraken`,
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ── ensureKrakenInstalled ────────────────────────────────────────
// Unlike Polymarket CLI, Kraken CLI is a Rust binary that requires
// manual install. We only check — never auto-install.

export async function ensureKrakenInstalled(): Promise<void> {
  if (cliReady === true) return;
  if (cliReadyPromise) {
    await cliReadyPromise;
    return;
  }

  cliReadyPromise = (async () => {
    const resolvedPath = await resolveKrakenPath();
    if (resolvedPath) {
      KRAKEN_BIN = resolvedPath;
      cliReady = true;
      return;
    }

    throw new Error(
      "Kraken CLI not found. Install: curl --proto '=https' --tlsv1.2 -LsSf https://github.com/krakenfx/kraken-cli/releases/latest/download/kraken-cli-installer.sh | sh"
    );
  })();

  try {
    await cliReadyPromise;
  } finally {
    cliReadyPromise = null;
  }
}

// ── execKraken ──────────────────────────────────────────────────
// Spawns kraken binary with -o json flag and parses NDJSON output.

export function execKraken(args: string[]): Promise<unknown> {
  const cmd = `${KRAKEN_BIN} ${args.join(" ")} -o json`;

  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as NodeJS.ErrnoException).code === "number"
              ? (error as { code: number }).code
              : 1;
          reject(
            new KrakenCliError(
              `kraken ${args.join(" ")} failed: ${stderr?.trim() || error.message}`,
              code,
              stderr || ""
            )
          );
          return;
        }

        try {
          const lines = stdout
            .trim()
            .split("\n")
            .filter(Boolean);
          const parsed = lines.map((line) => JSON.parse(line));
          resolve(parsed.length === 1 ? parsed[0] : parsed);
        } catch {
          // If NDJSON parsing fails, return raw output
          resolve(stdout.trim());
        }
      }
    );
  });
}

// ── High-level wrapper functions ────────────────────────────────

export async function krakenPaperBuy(
  pair: string,
  amount: number
): Promise<unknown> {
  await ensureKrakenInstalled();
  return execKraken(["paper", "buy", pair, String(amount)]);
}

export async function krakenPaperSell(
  pair: string,
  amount: number
): Promise<unknown> {
  await ensureKrakenInstalled();
  return execKraken(["paper", "sell", pair, String(amount)]);
}

export async function krakenPaperBalance(): Promise<unknown> {
  await ensureKrakenInstalled();
  return execKraken(["paper", "balance"]);
}

export async function krakenTicker(pair: string): Promise<unknown> {
  await ensureKrakenInstalled();
  return execKraken(["ticker", pair]);
}
