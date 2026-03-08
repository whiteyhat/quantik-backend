import path from "path";
import { execFileSync } from "child_process";

describe("generateWalletCredentials", () => {
  test("returns a WDK-derived EVM wallet contract", () => {
    const cwd = path.join(__dirname, "..");
    const script = [
      "import { generateWalletCredentials } from './src/wallet/generate.ts';",
      "(async () => {",
      "const wallet = await generateWalletCredentials();",
      "console.log(JSON.stringify(wallet));",
      "})();",
    ].join(" ");

    const stdout = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["tsx", "-e", script],
      { cwd, encoding: "utf8" }
    );

    const wallet = JSON.parse(stdout.trim()) as {
      address: string;
      privateKey: string;
      seedPhrase: string;
    };

    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.privateKey).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(wallet.seedPhrase.trim().split(/\s+/).length).toBeGreaterThanOrEqual(12);
  });
});
