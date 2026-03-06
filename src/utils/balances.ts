import { runCli } from "../cli";

const WALLET_ADDRESS = "0x7EE996AbE9355a126F010EfF93487e84b2cE4b53";
const POLYGON_RPC_URLS = ["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"];
const USDC_BRIDGED_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_NATIVE_CONTRACT  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

async function polygonRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(8000) });
  const json = await res.json() as any;
  if (!json.result) throw new Error(json.error?.message ?? "No result");
  return json.result;
}

export async function getUsdcBalance(address: string = WALLET_ADDRESS): Promise<number> {
  const paddedAddr = address.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedAddr}`;
  for (const rpcUrl of POLYGON_RPC_URLS) {
    try {
      const [uBH, uNH] = await Promise.all([
        polygonRpcCall(rpcUrl, "eth_call", [{ to: USDC_BRIDGED_CONTRACT, data: callData }, "latest"]),
        polygonRpcCall(rpcUrl, "eth_call", [{ to: USDC_NATIVE_CONTRACT, data: callData }, "latest"]),
      ]);
      const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);
      return Number(safeBigInt(uBH) + safeBigInt(uNH)) / 1e6;
    } catch { continue; }
  }
  return 0;
}

export async function getClobBalance(): Promise<number> {
  try {
    const raw = await runCli(["clob", "balance", "--asset-type", "collateral"]);
    if (raw && typeof raw === "object") return Number((raw as any).balance ?? 0);
  } catch {}
  return 0;
}

export async function getPolBalance(address: string = WALLET_ADDRESS): Promise<number> {
  for (const rpcUrl of POLYGON_RPC_URLS) {
    try {
      const pH = await polygonRpcCall(rpcUrl, "eth_getBalance", [address, "latest"]);
      const safeBigInt = (h: string) => (!h || h === "0x" || h === "0X") ? 0n : BigInt(h);
      return Number(safeBigInt(pH)) / 1e18;
    } catch { continue; }
  }
  return 0;
}
