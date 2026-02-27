import { runCli } from "../cli";

export async function detectCombinatorial(slug: string): Promise<{detected: boolean; details?: string; profit?: number}> {
  try {
    const parts = slug.split('-');
    if (parts.length < 2) return { detected: false };
    
    // Assume prefix is everything but the last part
    const prefix = parts.slice(0, -1).join('-');
    
    const res: any = await runCli(["markets", "list"]);
    const allMarkets = Array.isArray(res) ? res : (res.markets || []);
    
    const related = allMarkets.filter((m: any) => m.slug && m.slug.startsWith(prefix));
    if (related.length < 2) return { detected: false };

    let sum = 0;
    for (const m of related) {
      // Polymarket returns tokens or outcomePrices. Let's assume there is a yes_price or outcomePrices[0]
      const price = typeof m.yes_price === 'number' ? m.yes_price : 
                   (m.tokens && m.tokens[0] && typeof m.tokens[0].price === 'number') ? m.tokens[0].price : 0;
      sum += price;
    }

    if (sum > 0 && (sum < 0.96 || sum > 1.04)) {
      return {
        detected: true,
        details: `Sum of mutually exclusive markets (${related.length} markets): ${sum.toFixed(3)}`,
        profit: sum < 0.96 ? 0.96 - sum : sum - 1.04
      };
    }

    return { detected: false };
  } catch (err) {
    console.error("Combinatorial arb detection failed:", err);
    return { detected: false };
  }
}
