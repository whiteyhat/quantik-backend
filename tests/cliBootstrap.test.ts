describe("Polymarket CLI bootstrap", () => {
  const originalHome = process.env.HOME;
  const originalCli = process.env.POLYMARKET_CLI;

  beforeEach(() => {
    jest.resetModules();
    process.env.HOME = "/tmp/quantik-home";
    process.env.POLYMARKET_CLI = "/missing/polymarket";
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.POLYMARKET_CLI = originalCli;
  });

  test("serializes concurrent install attempts behind one in-flight promise", async () => {
    let installed = false;

    const execMock = jest.fn((cmd: string, opts: unknown, callback?: (err: Error | null, stdout?: string, stderr?: string) => void) => {
      const cb = typeof opts === "function" ? opts : callback;
      if (!cb) throw new Error("callback required");

      if (cmd.includes("install.sh")) {
        installed = true;
        setImmediate(() => cb(null, "", ""));
        return {} as never;
      }

      const err = new Error("not found");
      setImmediate(() => cb(err, "", ""));
      return {} as never;
    });

    const execFileMock = jest.fn((_bin: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout?: string, stderr?: string) => void) => {
      setImmediate(() => callback(null, '{"ok":true}', ""));
      return {} as never;
    });

    jest.doMock("child_process", () => ({
      exec: execMock,
      execFile: execFileMock,
    }));
    jest.doMock("fs", () => ({
      existsSync: (target: string) => installed && target === "/tmp/quantik-home/.local/bin/polymarket",
    }));

    const { runCli } = require("../src/cli") as typeof import("../src/cli");

    await Promise.all([
      runCli(["wallet", "balance"]),
      runCli(["wallet", "balance"]),
    ]);

    expect(execMock.mock.calls.filter(([cmd]: [string, ...unknown[]]) => cmd.includes("install.sh"))).toHaveLength(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][0]).toBe("/tmp/quantik-home/.local/bin/polymarket");
  });
});
