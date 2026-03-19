export const AUTOPILOT_MIN_POL_BALANCE = 3;
export const AUTOPILOT_MIN_USDC_BALANCE = 10;

export const AUTOPILOT_POL_REQUIREMENT = `>= ${AUTOPILOT_MIN_POL_BALANCE} POL`;
export const AUTOPILOT_USDC_REQUIREMENT = `>= ${AUTOPILOT_MIN_USDC_BALANCE} USDC.e`;

export function buildAutopilotFundingMissingItems(polBalance: number, usdcBalance: number): string[] {
  const items: string[] = [];

  if (polBalance < AUTOPILOT_MIN_POL_BALANCE) {
    items.push(`POL balance ${polBalance.toFixed(4)} is below ${AUTOPILOT_POL_REQUIREMENT}`);
  }

  if (usdcBalance < AUTOPILOT_MIN_USDC_BALANCE) {
    items.push(`USDC.e balance ${usdcBalance.toFixed(2)} is below ${AUTOPILOT_USDC_REQUIREMENT}`);
  }

  return items;
}

export function buildAutopilotFundingMessage(polBalance: number, usdcBalance: number): string {
  const polReady = polBalance >= AUTOPILOT_MIN_POL_BALANCE;
  const usdcReady = usdcBalance >= AUTOPILOT_MIN_USDC_BALANCE;

  if (!polReady && !usdcReady) {
    return `Deposit ${AUTOPILOT_POL_REQUIREMENT} for Polygon fees and ${AUTOPILOT_USDC_REQUIREMENT} for Polymarket trades before enabling autopilot.`;
  }

  if (!polReady) {
    return `Deposit ${AUTOPILOT_POL_REQUIREMENT} to cover Polygon fees before enabling autopilot.`;
  }

  if (!usdcReady) {
    return `Deposit ${AUTOPILOT_USDC_REQUIREMENT} to fund Polymarket trades before enabling autopilot.`;
  }

  return `Wallet meets the ${AUTOPILOT_POL_REQUIREMENT} and ${AUTOPILOT_USDC_REQUIREMENT} autopilot requirements.`;
}
