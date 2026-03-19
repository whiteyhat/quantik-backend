import { runCli, runCliWithWallet } from "../cli";
import { tryLoadActiveAgentContext } from "./agentKey";
import {
  AUTOPILOT_MIN_POL_BALANCE,
  AUTOPILOT_MIN_USDC_BALANCE,
  buildAutopilotFundingMessage,
} from "./autopilotFunding";

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
  clobBalance: number;
  usdcStatus: UsdcBalanceStatus;
  polStatus: UsdcBalanceStatus;
  fundingStatus: FundingStatus;
  fundingMessage: string;
  ready: boolean;
}

async function polygonRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(7000) });
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

// ── In-memory balance cache — prevents transient RPC failures from showing errors ──
interface CachedSnapshot { snapshot: UsdcBalanceSnapshot; ts: number }
const usdcCache = new Map<string, CachedSnapshot>();
const CACHE_TTL_MS = 90_000; // 90 seconds

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
  const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);

  // Each USDC contract race is independently fallible — partial result (one fails) is still valid
  const [bridgedResult, nativeResult] = await Promise.all([
    polygonRpcRace("eth_call", [{ to: USDC_BRIDGED_CONTRACT, data: callData }, "latest"]).catch(() => null),
    polygonRpcRace("eth_call", [{ to: USDC_NATIVE_CONTRACT, data: callData }, "latest"]).catch(() => null),
  ]);

  if (bridgedResult !== null || nativeResult !== null) {
    const balance = Number(
      safeBigInt(bridgedResult?.result ?? "0x") + safeBigInt(nativeResult?.result ?? "0x")
    ) / 1e6;
    const fresh: UsdcBalanceSnapshot = {
      balance,
      status: "live",
      rpcUrl: bridgedResult?.rpcUrl ?? nativeResult?.rpcUrl ?? null,
      error: null,
    };
    usdcCache.set(address, { snapshot: fresh, ts: Date.now() });
    return fresh;
  }

  // Both races failed — return cached value if still within TTL to avoid showing an error
  const cached = usdcCache.get(address);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  return {
    balance: 0,
    status: "rpc_unavailable",
    rpcUrl: null,
    error: "All Polygon RPC requests failed",
  };
}

export async function getClobBalance(privateKey?: string): Promise<number> {
  try {
    const key = privateKey ?? (await tryLoadActiveAgentContext())?.privateKey;
    const args = ["clob", "balance", "--asset-type", "collateral"];
    const raw = key ? await runCliWithWallet(args, key) : await runCli(args);
    if (raw && typeof raw === "object") return Number((raw as any).balance ?? 0);
  } catch {}
  return 0;
}

export async function getPolBalance(address?: string | null): Promise<number> {
  const snapshot = await getPolBalanceSnapshot(address);
  return snapshot.balance;
}

// ── In-memory POL balance cache ──
interface CachedPolSnapshot { snapshot: PolBalanceSnapshot; ts: number }
const polCache = new Map<string, CachedPolSnapshot>();

export async function getPolBalanceSnapshot(address: string | null | undefined): Promise<PolBalanceSnapshot> {
  if (!address) {
    return {
      balance: 0,
      status: "no_address",
      rpcUrl: null,
      error: "No wallet address available",
    };
  }

  const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);

  try {
    const { result, rpcUrl } = await polygonRpcRace("eth_getBalance", [address, "latest"]);
    const fresh: PolBalanceSnapshot = {
      balance: Number(safeBigInt(result)) / 1e18,
      status: "live",
      rpcUrl,
      error: null,
    };
    polCache.set(address, { snapshot: fresh, ts: Date.now() });
    return fresh;
  } catch {
    const cached = polCache.get(address);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.snapshot;
    }
    return {
      balance: 0,
      status: "rpc_unavailable",
      rpcUrl: null,
      error: "All Polygon RPC requests failed",
    };
  }
}

export async function getWalletFundingSnapshot(
  address: string | null | undefined,
  privateKey?: string | null
): Promise<WalletFundingSnapshot> {
  if (!address) {
    return {
      address: null,
      onChainUsdc: 0,
      pol: 0,
      clobBalance: 0,
      usdcStatus: "no_address",
      polStatus: "no_address",
      fundingStatus: "no_wallet",
      fundingMessage: "No wallet assigned to this agent yet.",
      ready: false,
    };
  }

  const hasExplicitPrivateKey = privateKey !== undefined;
  const [usdc, pol, clobBalance] = await Promise.all([
    getUsdcBalanceSnapshot(address),
    getPolBalanceSnapshot(address),
    getClobBalance(privateKey ?? undefined).catch(async () => {
      if (hasExplicitPrivateKey) return 0;
      const agentCtx = await tryLoadActiveAgentContext();
      return getClobBalance(agentCtx?.privateKey).catch(() => 0);
    }),
  ]);

  if (usdc.status !== "live" || pol.status !== "live") {
    if (hasExplicitPrivateKey && clobBalance > 0) {
      return {
        address,
        onChainUsdc: usdc.balance,
        pol: pol.balance,
        clobBalance,
        usdcStatus: usdc.status,
        polStatus: pol.status,
        fundingStatus: "ready",
        fundingMessage: "Using live Polymarket collateral balance while Polygon balance checks are temporarily unavailable.",
        ready: true,
      };
    }
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      clobBalance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "unavailable",
      fundingMessage: "Unable to verify live POL and USDC.e balances right now.",
      ready: false,
    };
  }

  const polReady = pol.balance >= AUTOPILOT_MIN_POL_BALANCE;
  const usdcReady = usdc.balance >= AUTOPILOT_MIN_USDC_BALANCE;

  if (!polReady && !usdcReady) {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      clobBalance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "funding_required",
      fundingMessage: buildAutopilotFundingMessage(pol.balance, usdc.balance),
      ready: false,
    };
  }

  if (!polReady) {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      clobBalance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "funding_required",
      fundingMessage: buildAutopilotFundingMessage(pol.balance, usdc.balance),
      ready: false,
    };
  }

  if (!usdcReady) {
    return {
      address,
      onChainUsdc: usdc.balance,
      pol: pol.balance,
      clobBalance,
      usdcStatus: usdc.status,
      polStatus: pol.status,
      fundingStatus: "funding_required",
      fundingMessage: buildAutopilotFundingMessage(pol.balance, usdc.balance),
      ready: false,
    };
  }

  return {
    address,
    onChainUsdc: usdc.balance,
    pol: pol.balance,
    clobBalance,
    usdcStatus: usdc.status,
    polStatus: pol.status,
    fundingStatus: "ready",
    fundingMessage: buildAutopilotFundingMessage(pol.balance, usdc.balance),
    ready: true,
  };
}
