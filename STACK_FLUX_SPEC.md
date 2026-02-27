# Flux Backend Build Specification

## Task
Build the Flux Backend as requested by Carlos.

## Data Source Priority
1. PRIMARY: Polymarket CLI → `polymarket clob orderbook <tokenId>`
2. FALLBACK: Direct CLOB API → fetch from https://clob.polymarket.com/orderbook/{tokenId}
3. If both fail → return Grade D with soft_veto: true (never hard block)

## Implementation Details
1. Create/Update `src/flux/index.ts`:
   - If `FLUX_MOCK=true` → return deterministic mock data
   - Try CLI: `runCli(["clob", "orderbook", tokenId])` using existing `runCli` from `src/cli.ts`
   - If CLI fails → try direct CLOB API fetch
   - Compute: `spread = (best_ask - best_bid) * 100` (as percentage)
   - Slippage for $10: walk order book to fill $10, compute average vs best price
   - Slippage for $50: same for $50 position
   - Liquidity grade: A(>$50K depth), B(>$10K), C(>$1K), D(<$1K)
   - Whale: single order >$500 AND >5% of total book depth → `whale_detected: true`
   - Depth imbalance: `yes_depth / total_depth` (0.5 = balanced, >0.7 = imbalanced YES)
   - Grade degradation: query last 3 `flux_results` from SQLite, compare grades
   - Soft veto: grade D OR spread >5% → `soft_veto: true`

2. Interface `FluxResult`:
```typescript
interface FluxResult {
  marketSlug: string; scoredAt: number;
  liquidity_grade: "A"|"B"|"C"|"D"; spread: number;
  slippage_10: number; slippage_50: number;
  whale_detected: boolean; whale_signals: number;
  depth_imbalance: number; depth_yes_pct: number;
  grade_degrading: boolean; soft_veto: boolean;
  total_liquidity: number; confidence: number;
  data_source: "cli"|"api"|"mock";
}
```

3. Database: Add `flux_results` table to `src/db/schema.ts`
4. Routes: Add `GET /api/flux/:slug`, `POST /api/flux/run`, `GET /api/flux/status` to `src/routes/flux.ts`
5. Initialization: Register flux router in `src/index.ts`

## Post-Execution Steps
When done, verify compilation, commit, and push:
```bash
npx tsc --noEmit
git add -A
git commit -m "feat: Flux Liquidity Agent — CLI primary, CLOB API fallback, slippage, whale detection, grade tracking"
git push
openclaw system event --text "Done: Flux backend built and pushed — CLI primary, CLOB fallback" --mode now
```
