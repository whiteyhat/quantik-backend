// ── Kraken CLI wrapper tests ─────────────────────────────────────
import { exec } from "child_process";

// Mock child_process before importing the module
jest.mock("child_process", () => ({
  exec: jest.fn(),
  execFile: jest.fn(),
}));

jest.mock("fs", () => ({
  existsSync: jest.fn(() => false),
}));

import { existsSync } from "fs";

// We need to reset modules between tests to clear cached state
const loadModule = () => {
  jest.resetModules();
  // Re-apply mocks after resetModules
  jest.mock("child_process", () => ({
    exec: jest.fn(),
    execFile: jest.fn(),
  }));
  jest.mock("fs", () => ({
    existsSync: jest.fn(() => false),
  }));
  return require("../src/kraken/cli");
};

describe("Kraken CLI wrapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env
    delete process.env.KRAKEN_CLI;
  });

  describe("KrakenCliError", () => {
    it("should extend Error with exitCode and stderr", () => {
      const { KrakenCliError } = loadModule();
      const err = new KrakenCliError("test error", 42, "some stderr");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("KrakenCliError");
      expect(err.message).toBe("test error");
      expect(err.exitCode).toBe(42);
      expect(err.stderr).toBe("some stderr");
    });
  });

  describe("resolveKrakenPath", () => {
    it("should return null when no kraken binary is found", async () => {
      const { resolveKrakenPath } = loadModule();
      const mockExec = require("child_process").exec;
      // command -v fails for everything
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = cb || _opts;
          (callback as Function)(new Error("not found"), "", "");
        }
      );
      const mockExists = require("fs").existsSync;
      mockExists.mockReturnValue(false);

      const result = await resolveKrakenPath();
      expect(result).toBeNull();
    });

    it("should return path when binary exists at candidate location", async () => {
      const { resolveKrakenPath } = loadModule();
      const mockExec = require("child_process").exec;
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = cb || _opts;
          (callback as Function)(new Error("not found"), "", "");
        }
      );
      const mockExists = require("fs").existsSync;
      mockExists.mockImplementation((p: string) => {
        return p.includes(".cargo/bin/kraken");
      });

      const result = await resolveKrakenPath();
      expect(result).toContain(".cargo/bin/kraken");
    });
  });

  describe("execKraken", () => {
    it("should parse single-line NDJSON output", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      // First call: ensureKrakenInstalled -> resolveKrakenPath -> command -v kraken
      // Second call: actual exec
      let callCount = 0;
      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          callCount++;
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            // Actual kraken command — return single-line JSON
            callback(null, JSON.stringify({ status: "ok", price: 50000 }) + "\n", "");
          }
        }
      );

      const result = await mod.execKraken(["ticker", "BTCUSD"]);
      expect(result).toEqual({ status: "ok", price: 50000 });
    });

    it("should parse multi-line NDJSON output into array", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            const lines = [
              JSON.stringify({ asset: "BTC", balance: 0.5 }),
              JSON.stringify({ asset: "ETH", balance: 10 }),
            ].join("\n") + "\n";
            callback(null, lines, "");
          }
        }
      );

      const result = await mod.execKraken(["paper", "balance"]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ asset: "BTC", balance: 0.5 });
      expect(result[1]).toEqual({ asset: "ETH", balance: 10 });
    });

    it("should throw KrakenCliError on exec failure", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            const err = Object.assign(new Error("command failed"), { code: 1 });
            callback(err, "", "connection refused");
          }
        }
      );

      await expect(mod.execKraken(["paper", "buy", "BTCUSD", "0.1"])).rejects.toThrow();
    });
  });

  describe("krakenPaperBuy", () => {
    it("should call exec with correct args: paper buy PAIR AMOUNT -o json", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      const calls: string[] = [];
      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          calls.push(cmd);
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            callback(null, JSON.stringify({ orderId: "abc123" }) + "\n", "");
          }
        }
      );

      await mod.krakenPaperBuy("BTCUSD", 0.1);

      // Find the actual kraken command (not the command -v call)
      const krakenCmd = calls.find((c) => c.includes("paper") && c.includes("buy"));
      expect(krakenCmd).toBeDefined();
      expect(krakenCmd).toContain("paper");
      expect(krakenCmd).toContain("buy");
      expect(krakenCmd).toContain("BTCUSD");
      expect(krakenCmd).toContain("0.1");
      expect(krakenCmd).toContain("-o json");
    });
  });

  describe("krakenPaperSell", () => {
    it("should call exec with correct args: paper sell PAIR AMOUNT -o json", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      const calls: string[] = [];
      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          calls.push(cmd);
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            callback(null, JSON.stringify({ orderId: "sell456" }) + "\n", "");
          }
        }
      );

      await mod.krakenPaperSell("ETHUSD", 0.5);

      const krakenCmd = calls.find((c) => c.includes("paper") && c.includes("sell"));
      expect(krakenCmd).toBeDefined();
      expect(krakenCmd).toContain("paper");
      expect(krakenCmd).toContain("sell");
      expect(krakenCmd).toContain("ETHUSD");
      expect(krakenCmd).toContain("0.5");
      expect(krakenCmd).toContain("-o json");
    });
  });

  describe("krakenPaperBalance", () => {
    it("should call exec with correct args: paper balance -o json", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      const calls: string[] = [];
      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          calls.push(cmd);
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            callback(null, JSON.stringify({ usd: 10000 }) + "\n", "");
          }
        }
      );

      await mod.krakenPaperBalance();

      const krakenCmd = calls.find((c) => c.includes("paper") && c.includes("balance"));
      expect(krakenCmd).toBeDefined();
      expect(krakenCmd).toContain("paper");
      expect(krakenCmd).toContain("balance");
      expect(krakenCmd).toContain("-o json");
    });
  });

  describe("krakenTicker", () => {
    it("should call exec with correct args: ticker PAIR -o json", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;

      const calls: string[] = [];
      mockExec.mockImplementation(
        (cmd: string, opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof opts === "function" ? opts : cb) as Function;
          calls.push(cmd);
          if (cmd.includes("command -v")) {
            callback(null, "/usr/local/bin/kraken\n", "");
          } else {
            callback(null, JSON.stringify({ pair: "BTCUSD", last: 50000 }) + "\n", "");
          }
        }
      );

      await mod.krakenTicker("BTCUSD");

      const krakenCmd = calls.find((c) => c.includes("ticker") && c.includes("BTCUSD"));
      expect(krakenCmd).toBeDefined();
      expect(krakenCmd).toContain("ticker");
      expect(krakenCmd).toContain("BTCUSD");
      expect(krakenCmd).toContain("-o json");
    });
  });

  describe("ensureKrakenInstalled", () => {
    it("should throw with install instructions when binary not found", async () => {
      const mod = loadModule();
      const mockExec = require("child_process").exec;
      const mockExists = require("fs").existsSync;

      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
          const callback = (typeof _opts === "function" ? _opts : cb) as Function;
          callback(new Error("not found"), "", "");
        }
      );
      mockExists.mockReturnValue(false);

      await expect(mod.ensureKrakenInstalled()).rejects.toThrow("kraken-cli-installer.sh");
    });
  });
});
