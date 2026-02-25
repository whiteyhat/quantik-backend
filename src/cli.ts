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

export async function runCli(args: string[]): Promise<any> {
  const fullArgs = ["-o", "json", ...args];

  return new Promise((resolve, reject) => {
    execFile(
      POLYMARKET_BIN,
      fullArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new CliError(
              `polymarket ${args.join(" ")} failed: ${stderr || error.message}`,
              (error as any).code ?? 1,
              stderr
            )
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch {
          // If stdout isn't JSON, return raw string
          resolve(stdout.trim());
        }
      }
    );
  });
}
