import { execFile, exec } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

const execAsync = promisify(exec);

// Resolved path to the polymarket binary. May be a full path (env var) or
// just "polymarket" (resolved via PATH). Updated by ensureCliInstalled().
let POLYMARKET_BIN = process.env.POLYMARKET_CLI || "polymarket";

// Tracks whether we've already confirmed/installed the binary this process.
let cliReady: boolean | null = null;
let cliReadyPromise: Promise<void> | null = null;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "CliError";
  }
}

// ── ensureCliInstalled ────────────────────────────────────────────────────────
// Checks that the polymarket binary is present. If not, installs it via the
// official install script (same method used in the Dockerfile).
// This is a no-op if the binary already exists.

async function ensureCliInstalled(): Promise<void> {
  if (cliReady === true) return;
  if (cliReadyPromise) {
    await cliReadyPromise;
    return;
  }

  cliReadyPromise = (async () => {
    const resolvedPath = await resolveCliPath();
    if (resolvedPath) {
      POLYMARKET_BIN = resolvedPath;
      cliReady = true;
      return;
    }

    console.warn(`[cli] Polymarket binary not found at "${POLYMARKET_BIN}" — installing...`);

    try {
      await execAsync(
        "curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh",
        { timeout: 120_000 }
      );
      console.log("[cli] Polymarket CLI installed successfully");
    } catch (installErr) {
      const msg = installErr instanceof Error ? installErr.message : String(installErr);
      throw new Error(`Failed to install Polymarket CLI: ${msg}`);
    }

    const installedPath = await resolveCliPath();
    if (!installedPath) {
      const home = process.env.HOME || "/root";
      throw new Error(
        `Polymarket CLI install completed but binary not found at "${home}/.local/bin/polymarket" or on PATH`
      );
    }

    POLYMARKET_BIN = installedPath;
    cliReady = true;
  })();

  try {
    await cliReadyPromise;
  } finally {
    cliReadyPromise = null;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

async function resolveCliPath(): Promise<string | null> {
  if (POLYMARKET_BIN.startsWith("/") && existsSync(POLYMARKET_BIN)) {
    return POLYMARKET_BIN;
  }

  if (!POLYMARKET_BIN.startsWith("/") && await commandExists(POLYMARKET_BIN)) {
    return POLYMARKET_BIN;
  }

  const home = process.env.HOME || "/root";
  const installedPath = `${home}/.local/bin/polymarket`;
  if (existsSync(installedPath)) {
    return installedPath;
  }

  if (POLYMARKET_BIN !== "polymarket" && await commandExists("polymarket")) {
    return "polymarket";
  }

  return null;
}

// ── runCli ───────────────────────────────────────────────────────────────────

function execCli(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const fullArgs = ["-o", "json", ...args];

  return new Promise((resolve, reject) => {
    execFile(
      POLYMARKET_BIN,
      fullArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 60_000, env },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as NodeJS.ErrnoException).code === "number"
              ? (error as { code: number }).code
              : 1;
          const parts = [stderr?.trim(), stdout?.trim()].filter(Boolean).join(" | stderr: ");
          const detail = parts || error.message;
          console.error(`[cli] polymarket ${args.join(" ")} stderr: ${stderr?.trim() || "(empty)"}`);
          console.error(`[cli] polymarket ${args.join(" ")} stdout: ${stdout?.trim() || "(empty)"}`);
          reject(new CliError(`polymarket ${args.join(" ")} failed: ${detail}`, code, stderr || ""));
          return;
        }

        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch {
          resolve(stdout.trim());
        }
      }
    );
  });
}

export async function runCli(args: string[]): Promise<unknown> {
  await ensureCliInstalled();
  return execCli(args, process.env as NodeJS.ProcessEnv);
}

/**
 * Run the CLI with a wallet private key injected into the subprocess env only.
 * The key is NEVER written to process.env — it exists solely in the child process.
 */
export async function runCliWithWallet(args: string[], privateKey: string): Promise<unknown> {
  await ensureCliInstalled();
  const env: NodeJS.ProcessEnv = { ...process.env, POLYMARKET_PRIVATE_KEY: privateKey };
  const result = await execCli(args, env);
  // Overwrite the private key string reference (best-effort in JS)
  (env as Record<string, unknown>)["POLYMARKET_PRIVATE_KEY"] = undefined;
  return result;
}
