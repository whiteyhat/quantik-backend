import { runCli } from "../cli";

interface ScanMarket {
  slug: string;
  volume: number;
  yes_price: number;
}

const scanState = new Map<string, number>();

export function startHotScanner(): void {
  // Run every 60s
  setInterval(async () => {
    try {
      // Mocking fetch of top 50 markets by volume
      // In reality, this would be a CLI call sorted by volume
      const res: any = await runCli(["markets", "list", "--active"]);
      let markets = Array.isArray(res) ? res : (res.markets || []);
      
      // Sort by volume descending if volume exists
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
            // Emit event for pipeline trigger - placeholder
            // eventBus.emit("pipeline:trigger", m.slug);
          }
        }
        scanState.set(m.slug, currentPrice);
      }
    } catch (err) {
      console.error("[HotScanner] Error during scan:", err);
    }
  }, 60000);

  console.log("[HotScanner] Started 60s polling for top 50 markets.");
}
