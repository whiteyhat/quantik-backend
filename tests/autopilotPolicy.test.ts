import { buildAutopilotPolicyEnvelope, deriveAutopilotPolicy } from "../src/services/autopilotPolicy";

describe("autopilot policy derivation", () => {
  test("guardian observer fixed_safe stays conservative", () => {
    const derived = deriveAutopilotPolicy({
      personality: "guardian",
      decision_style: "observer",
      trading_instinct: "value_hunter",
      time_patience: "longterm",
      money_approach: "fixed_safe",
      protection_mindset: "tight",
      market_sense: "fixed_rules",
    });

    expect(derived).toEqual({
      cadenceMinutes: 360,
      cooldownMinutes: 1800,
      maxTradesPerDay: 1,
      maxBetUsdc: 10,
      minSigma: 0.82,
      minKelly: 0.04,
      kellyMultiplier: 0.15,
      maxPositionFraction: 0.03,
      dailyLossLimitPct: 0.05,
      useAuraSentiment: false,
    });
  });

  test("balanced analyst smart_scaling produces mid-range posture", () => {
    const derived = deriveAutopilotPolicy({
      personality: "balanced",
      decision_style: "analyst",
      trading_instinct: "trend_chaser",
      time_patience: "swing",
      money_approach: "smart_scaling",
      protection_mindset: "flexible",
      market_sense: "mood_reader",
    });

    expect(derived).toEqual({
      cadenceMinutes: 45,
      cooldownMinutes: 270,
      maxTradesPerDay: 8,
      maxBetUsdc: 25,
      minSigma: 0.72,
      minKelly: 0.03,
      kellyMultiplier: 0.25,
      maxPositionFraction: 0.08,
      dailyLossLimitPct: 0.08,
      useAuraSentiment: true,
    });
  });

  test("adventurer speed_demon aggressive plus overrides produces effective policy", () => {
    const policy = buildAutopilotPolicyEnvelope(
      {
        personality: "adventurer",
        decision_style: "gut",
        trading_instinct: "speed_demon",
        time_patience: "lightning",
        money_approach: "aggressive",
        protection_mindset: "hands_off",
        market_sense: "mood_reader",
      },
      {
        cadenceMinutes: 20,
        cooldownMinutes: null,
        maxTradesPerDay: 18,
        maxBetUsdc: 75,
        updatedAt: 123,
      }
    );

    expect(policy.derived).toEqual({
      cadenceMinutes: 8,
      cooldownMinutes: 30,
      maxTradesPerDay: 16,
      maxBetUsdc: 50,
      minSigma: 0.6,
      minKelly: 0.02,
      kellyMultiplier: 0.5,
      maxPositionFraction: 0.15,
      dailyLossLimitPct: 0.12,
      useAuraSentiment: true,
    });
    expect(policy.effective).toEqual({
      cadenceMinutes: 20,
      cooldownMinutes: 30,
      maxTradesPerDay: 18,
      maxBetUsdc: 75,
      minSigma: 0.6,
      minKelly: 0.02,
      kellyMultiplier: 0.5,
      maxPositionFraction: 0.15,
      dailyLossLimitPct: 0.12,
      useAuraSentiment: true,
    });
  });
});
