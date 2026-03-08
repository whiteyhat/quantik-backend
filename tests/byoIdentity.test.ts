import {
  normalizeClaimedByoIdentity,
  normalizeLegacyByoIdentity,
  resolveByoIdentity,
  validateExternalHttpsUrl,
} from "../src/routes/byoIdentity";

describe("BYO identity helpers", () => {
  test("resolveByoIdentity uses remote identity when payload is valid", async () => {
    let calledUrl = "";
    const mockFetch = jest.fn(async (input: string | URL | Request) => {
      calledUrl = String(input);
      return new Response(
        JSON.stringify({
          name: "  OpenClaw Alpha  ",
          description: "  External agent identity  ",
          emoji: "🐺",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await resolveByoIdentity("https://agent.example.com", mockFetch);

    expect(calledUrl).toBe("https://agent.example.com/identity");
    expect(result.identity_source).toBe("remote");
    expect(result.name).toBe("OpenClaw Alpha");
    expect(result.description).toBe("External agent identity");
    expect(result.avatar).toBe("🐺");
  });

  test("resolveByoIdentity falls back to random identity when payload is invalid", async () => {
    const mockFetch = jest.fn(async () => {
      return new Response(JSON.stringify({ foo: "bar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await resolveByoIdentity("https://agent.example.com", mockFetch);

    expect(result.identity_source).toBe("random_fallback");
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.avatar.length).toBeGreaterThan(0);
  });

  test("validateExternalHttpsUrl rejects private/internal and non-https URLs", () => {
    expect(validateExternalHttpsUrl("http://agent.example.com", "agent_url")).toEqual({
      ok: false,
      error: "agent_url must use HTTPS",
    });

    expect(validateExternalHttpsUrl("https://localhost:9000", "agent_url")).toEqual({
      ok: false,
      error: "agent_url must not point to a private/internal address",
    });
  });

  test("normalizeLegacyByoIdentity supports manual legacy config", () => {
    const normalized = normalizeLegacyByoIdentity({
      name: "LegacyBot",
      description: "Manual BYO identity",
      avatar: "🦊",
    });

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.identity.name).toBe("LegacyBot");
      expect(normalized.identity.description).toBe("Manual BYO identity");
      expect(normalized.identity.avatar).toBe("🦊");
    }
  });

  test("normalizeClaimedByoIdentity accepts OpenClaw claim payloads", () => {
    const normalized = normalizeClaimedByoIdentity({
      name: "  OpenClaw Claimed  ",
      description: "  Claimed from callback  ",
      emoji: "🦞",
    });

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.identity.name).toBe("OpenClaw Claimed");
      expect(normalized.identity.description).toBe("Claimed from callback");
      expect(normalized.identity.avatar).toBe("🦞");
    }
  });
});
