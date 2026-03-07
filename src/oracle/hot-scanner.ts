import { existsSync } from "fs";
import { runCli } from "../cli";

interface ScanMarket {
  slug: string;
  volume: number;
  yes_price: number;
}

const scanState = new Map<string, number>();

export async function runHotScan(): Promise<void> {
  const cliPath = process.env.POLYMARKET_CLI;
  if (!cliPath || !existsSync(cliPath)) return;

  try {
    const res: any = await runCli(["markets", "list", "--active", "true"]);
    let markets = Array.isArray(res) ? res : (res.markets || []);

    markets.sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0));
    markets = markets.slice(0, 50);

    for (const m of markets) {
      if (!m.slug) continue;
      const currentPrice = typeof m.yes_price === 'number' ? m.yes_price :
                          (m.tokens && m.tokens[0] && typeof m.tokens[0].price === 'number') ? m.tokens[0].price : 0.5;

      const prevPrice = scanState.get(m.slug);
      if (prevPrice !== undefined) {
        const move = Math.abs(currentPrice - prevPrice);
        if (move > 0.03) {
          console.log(`[HotScanner] Market ${m.slug} moved ${(move * 100).toFixed(1)}¢ in 60s!`);
        }
      }
      scanState.set(m.slug, currentPrice);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[HotScanner] Error during scan:", msg);
  }
}

export function startHotScanner(): void {
  setInterval(() => runHotScan().catch(console.error), 60000);
  console.log("[HotScanner] Started 60s polling for top 50 markets.");
}
