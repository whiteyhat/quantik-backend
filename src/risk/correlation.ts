import { getDb } from "../db/schema";

// ── Types ──────────────────────────────────────────────────────

interface ExecutionRow {
  slug: string;
  side: string;
  amount: number;
  fill_price: number | null;
  status: string;
}

// ── Category mapping (slug prefix → theme) ─────────────────────

const CATEGORY_MAP: Record<string, string> = {
  btc: "crypto",
  eth: "crypto",
  sol: "crypto",
  bitcoin: "crypto",
  ethereum: "crypto",
  crypto: "crypto",
  defi: "crypto",
  nft: "crypto",
  election: "politics",
  president: "politics",
  senate: "politics",
  congress: "politics",
  trump: "politics",
  biden: "politics",
  vote: "politics",
  nba: "sports",
  nfl: "sports",
  mlb: "sports",
  fifa: "sports",
  ufc: "sports",
  tennis: "sports",
  super: "sports",
  ai: "tech",
  apple: "tech",
  google: "tech",
  openai: "tech",
  tesla: "tech",
  spacex: "tech",
  fed: "macro",
  rate: "macro",
  inflation: "macro",
  gdp: "macro",
  recession: "macro",
};

const MAX_THEME_PCT = 0.20; // 20% max per theme

// ── CorrelationMonitor ─────────────────────────────────────────

export class CorrelationMonitor {
  /** Categorize a market slug into a theme */
  categorize(slug: string): string {
    const parts = slug.toLowerCase().split("-");
    for (const part of parts) {
      if (CATEGORY_MAP[part]) return CATEGORY_MAP[part];
    }
    return "general";
  }

  /** Returns exposure (USDC) grouped by theme category */
  getThemeExposure(): Map<string, number> {
    const db = getDb();
    const rows = db
      .prepare<[], ExecutionRow>(
        "SELECT slug, side, amount, fill_price, status FROM executions WHERE status IN ('placed', 'paper', 'submitted') AND pnl IS NULL"
      )
      .all();

    const themes = new Map<string, number>();
    for (const row of rows) {
      const theme = this.categorize(row.slug);
      themes.set(theme, (themes.get(theme) ?? 0) + row.amount);
    }
    return themes;
  }

  /** Check if adding more USDC to a category stays within 20% limit */
  checkThemeLimit(category: string, additionalUsdc: number, totalCapital: number): boolean {
    const themes = this.getThemeExposure();
    const currentExposure = themes.get(category) ?? 0;
    const maxAllowed = totalCapital * MAX_THEME_PCT;
    return (currentExposure + additionalUsdc) <= maxAllowed;
  }

  /** Detect correlation between two markets (0-1 score based on shared keywords) */
  detectCorrelation(slug1: string, slug2: string): number {
    const words1 = new Set(slug1.toLowerCase().split("-"));
    const words2 = new Set(slug2.toLowerCase().split("-"));

    // Count shared keywords
    let shared = 0;
    for (const w of words1) {
      if (words2.has(w)) shared++;
    }

    const totalUnique = new Set([...words1, ...words2]).size;
    if (totalUnique === 0) return 0;

    // Jaccard similarity as correlation proxy
    const jaccard = shared / totalUnique;

    // Boost if same category
    const cat1 = this.categorize(slug1);
    const cat2 = this.categorize(slug2);
    const categoryBoost = cat1 === cat2 && cat1 !== "general" ? 0.2 : 0;

    return Math.min(jaccard + categoryBoost, 1);
  }
}
