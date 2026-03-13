import { runCli } from "../cli";

const POLYGON_RPC_URLS = ["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"];
const USDC_BRIDGED_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_NATIVE_CONTRACT  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

export type UsdcBalanceStatus = "live" | "rpc_unavailable" | "no_address";
export type FundingStatus = "ready" | "funding_required" | "unavailable" | "no_wallet";

export interface UsdcBalanceSnapshot {
  balance: number;
  status: UsdcBalanceStatus;
  rpcUrl: string | null;
  error: string | null;
}

export interface PolBalanceSnapshot {
  balance: number;
  status: UsdcBalanceStatus;
  rpcUrl: string | null;
  error: string | null;
}

export interface WalletFundingSnapshot {
  address: string | null;
  onChainUsdc: number;
  pol: number;
  usdcStatus: UsdcBalanceStatus;
  polStatus: UsdcBalanceStatus;
  fundingStatus: FundingStatus;
  fundingMessage: string;
  ready: boolean;
}

async function polygonRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
  const json = await res.json() as any;
  if (!json.result) throw new Error(json.error?.message ?? "No result");
  return json.result;
}

// Race all RPC providers — first successful response wins, avoiding sequential 8s timeouts
async function polygonRpcRace(method: string, params: unknown[]): Promise<{ result: string; rpcUrl: string }> {
  const races = POLYGON_RPC_URLS.map(async (rpcUrl) => {
    const result = await polygonRpcCall(rpcUrl, method, params);
    return { result, rpcUrl };
  });
  return Promise.any(races);
}

export async function getUsdcBalance(address?: string | null): Promise<number> {
  const snapshot = await getUsdcBalanceSnapshot(address);
  return snapshot.balance;
}

export async function getUsdcBalanceSnapshot(address: string | null | undefined): Promise<UsdcBalanceSnapshot> {
  if (!address) {
    return {
      balance: 0,
      status: "no_address",
      rpcUrl: null,
      error: "No wallet address available",
    };
  }

  const paddedAddr = address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedAddr}`;

  try {
    // Race all RPCs for bridged USDC, race all RPCs for native USDC — both in parallel
    const [bridgedRace, nativeRace] = await Promise.all([
      polygonRpcRace("eth_call", [{ to: USDC_BRIDGED_CONTRACT, data: callData }, "latest"]),
      polygonRpcRace("eth_call", [{ to: USDC_NATIVE_CONTRACT, data: callData }, "latest"]),
    ]);
    const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);
    return {
      balance: Number(safeBigInt(bridgedRace.result) + safeBigInt(nativeRace.result)) / 1e6,
      status: "live",
      rpcUrl: bridgedRace.rpcUrl,
      error: null,
    };
  } catch (err) {
    return {
      balance: 0,
      status: "rpc_unavailable",
      rpcUrl: null,
      error: err instanceof Error ? err.message : "All Polygon RPC requests failed",
    };
  }
}

export async function getClobBalance(): Promise<number> {
  try {
    const raw = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    if (raw && typeof raw === "object") return Number((raw as any).balance ?? 0);
  } catch {}
  return 0;
}

export async function getPolBalance(address?: string | null): Promise<number> {
  const snapshot = await getPolBalanceSnapshot(address);
  return snapshot.balance;
}

export async function getPolBalanceSnapshot(address: string | null | undefined): Promise<PolBalanceSnapshot> {
  if (!address) {
    return {
      balance: 0,
      status: "no_address",
      rpcUrl: null,
      error: "No wallet address available",
    };
  }

  try {
    const { result, rpcUrl } = await polygonRpcRace("eth_getBalance", [address, "latest"]);
    const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);
    return {
      balance: Number(safeBigInt(result)) / 1e18,
      status: "live",
      rpcUrl,
      error: null,
    };
  } catch {
    return {
      balance: 0,
      status: "rpc_unavailable",
      rpcUrl: null,
      error: "All Polygon RPC requests failed",
    };
  }
}

export async function getWalletFundingSnapshot(address: string | null | undefined): Promise<WalletFundingSnapshot> {
  if (!address) {
    return {
      address: null,
      onChainUsdc: 0,
      pol: 0,
      usdcStatus: "no_address",
      polStatus: "no_address",
      fundingStatus: "no_wallet",
      fundingMessage: "No wallet assigned to this agent yet.",
      ready: false,
    };
  }

  const [usdc, pol] = await Promise.all([
    getUsdcBalanceSnapshot(address),
    getPolBalanceSnapshot(address),
  ]);

  if (usdc.status !== "live" || pol.status !== "live") {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "unavailable",
      fundingMessage: "Unable to verify live POL and USDC.e balances right now.",
      ready: false,
    };
  }

  if (pol.balance <= 0 && usdc.balance <= 0) {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "funding_required",
      fundingMessage: "Deposit POL for Polygon fees and USDC.e for Polymarket trades before enabling autopilot.",
      ready: false,
    };
  }

  if (pol.balance <= 0) {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "funding_required",
      fundingMessage: "Deposit POL to cover Polygon fees before enabling autopilot.",
      ready: false,
    };
  }

  if (usdc.balance <= 0) {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "funding_required",
      fundingMessage: "Deposit USDC.e to fund Polymarket trades before enabling autopilot.",
      ready: false,
    };
  }

  return {
    address,
    onChainUsdc: usdc.balance,
    pol: pol.balance,
    usdcStatus: usdc.status,
    polStatus: pol.status,
    fundingStatus: "ready",
    fundingMessage: "Wallet has both POL and USDC.e required for autonomous trading.",
    ready: true,
  };
}
