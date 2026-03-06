export { PortfolioManager } from "./portfolio";
export type { Position } from "./portfolio";

export { CorrelationMonitor } from "./correlation";

export { CircuitBreaker, ensureCircuitBreakerTable } from "./circuitBreaker";
export type { CircuitBreakerState, CircuitBreakerStatus } from "./circuitBreaker";

// ── RiskApproval ───────────────────────────────────────────────

import { PortfolioManager } from "./portfolio";
import { CorrelationMonitor } from "./correlation";
import { CircuitBreaker } from "./circuitBreaker";
import type { CircuitBreakerStatus } from "./circuitBreaker";

export interface RiskApproval {
  approved: boolean;
  adjustedSize: number;
  reason: string;
  circuitBreakerStatus: CircuitBreakerStatus;
}

const portfolio = new PortfolioManager();
const correlation = new CorrelationMonitor();
const circuitBreaker = new CircuitBreaker();

/**
 * Run all risk checks in sequence for a proposed position.
 * Returns first failure, or approval with (potentially adjusted) size.
 */
export async function approvePosition(
  slug: string,
  sizeUsdc: number,
  category?: string
): Promise<RiskApproval> {
  // 1. Circuit breaker check
  const cbStatus = await circuitBreaker.checkAndTrip();
  if (cbStatus.triggered) {
    return {
      approved: false,
      adjustedSize: 0,
      reason: `Circuit breaker TRIGGERED (${(cbStatus.drawdownPct * 100).toFixed(1)}% daily drawdown). All trading halted.`,
      circuitBreakerStatus: cbStatus,
    };
  }

  // 2. Exposure limit (50% total deployed)
  if (!(await portfolio.checkExposureLimit(sizeUsdc))) {
    return {
      approved: false,
      adjustedSize: 0,
      reason: `Exposure limit exceeded. Max 50% of portfolio can be deployed.`,
      circuitBreakerStatus: cbStatus,
    };
  }

  // 3. Position limit (5% per market)
  if (!(await portfolio.checkPositionLimit(slug, sizeUsdc))) {
    const totalCapital = await portfolio.getTotalCapital();
    const maxSize = totalCapital * 0.05;
    const existing = portfolio.getOpenPositions()
      .filter((p) => p.slug === slug)
      .reduce((sum, p) => sum + p.sizeUsdc, 0);
    const adjustedSize = Math.max(maxSize - existing, 0);

    if (adjustedSize <= 0) {
      return {
        approved: false,
        adjustedSize: 0,
        reason: `Position limit reached for ${slug}. Max 5% of portfolio per market.`,
        circuitBreakerStatus: cbStatus,
      };
    }

    // Approve with reduced size
    return {
      approved: true,
      adjustedSize,
      reason: `Position size reduced from $${sizeUsdc.toFixed(2)} to $${adjustedSize.toFixed(2)} (5% cap per market).`,
      circuitBreakerStatus: cbStatus,
    };
  }

  // 4. Theme/correlation limit (20% per theme)
  const theme = category ?? correlation.categorize(slug);
  const totalCapital = await portfolio.getTotalCapital();
  if (!correlation.checkThemeLimit(theme, sizeUsdc, totalCapital)) {
    return {
      approved: false,
      adjustedSize: 0,
      reason: `Theme exposure limit exceeded for "${theme}". Max 20% of portfolio per category.`,
      circuitBreakerStatus: cbStatus,
    };
  }

  // All checks passed
  return {
    approved: true,
    adjustedSize: sizeUsdc,
    reason: "All risk checks passed.",
    circuitBreakerStatus: cbStatus,
  };
}

/** Singleton accessors for route handlers */
export function getPortfolioManager(): PortfolioManager {
  return portfolio;
}

export function getCorrelationMonitor(): CorrelationMonitor {
  return correlation;
}

export function getCircuitBreaker(): CircuitBreaker {
  return circuitBreaker;
}
