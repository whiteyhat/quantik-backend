import { execFile } from "child_process";

const POLYMARKET_BIN = process.env.POLYMARKET_CLI || "polymarket";

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

export async function runCli(args: string[]): Promise<unknown> {
  const fullArgs = ["-o", "json", ...args];

  return new Promise((resolve, reject) => {
    execFile(
      POLYMARKET_BIN,
      fullArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof (error as NodeJS.ErrnoException).code === "number"
              ? (error as { code: number }).code
              : 1;
          reject(
            new CliError(
              `polymarket ${args.join(" ")} failed: ${stderr || stdout?.trim() || error.message}`,
              code,
              stderr || stdout?.trim() || ""
            )
          );
          return;
        }

        try {
          const parsed: unknown = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch {
          // If stdout isn't JSON, return raw string
          resolve(stdout.trim());
        }
      }
    );
  });
}
