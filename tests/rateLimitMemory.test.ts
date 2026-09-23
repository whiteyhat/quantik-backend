import { hitMemoryWindow } from "../src/infra/rateLimit";

describe("in-memory rate limit window", () => {
  const config = { windowMs: 60_000, max: 3, keyPrefix: "test" };

  it("counts requests inside the window and stops recording once over the limit", () => {
    const key = "rl:test:client-a";
    expect([0, 1, 2].map((i) => hitMemoryWindow(key, config, 1_000 + i))).toEqual([0, 1, 2]);
    // 4th and 5th requests are over the limit and must not extend the block
    expect(hitMemoryWindow(key, config, 1_010)).toBe(3);
    expect(hitMemoryWindow(key, config, 1_020)).toBe(3);
  });

  it("frees capacity once old requests leave the window", () => {
    const key = "rl:test:client-b";
    for (let i = 0; i < 3; i++) hitMemoryWindow(key, config, 1_000 + i);
    // At t=61_000 the request from t=1_000 has aged out; 1_001 and 1_002 remain
    expect(hitMemoryWindow(key, config, 61_000)).toBe(2);
  });

  it("keeps clients independent", () => {
    for (let i = 0; i < 3; i++) hitMemoryWindow("rl:test:client-c", config, 5_000);
    expect(hitMemoryWindow("rl:test:client-d", config, 5_000)).toBe(0);
  });
});
