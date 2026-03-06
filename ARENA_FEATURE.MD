**Project Title:** Agent Arena: WDK-Powered Multiplayer Evolutionary Trading Battle Royale (Pixel Stardew Edition) – Polymarket Lobbies

**Overview**  
Live 2D pixel-art Stardew dashboard in Tether WDK. Users create/join lobbies of exactly 10 players. Each creates 1 main agent with custom metadata (personality: Aggressive Gambler / Cautious Oracle / Chaotic Meme Lord etc.). Personality directly alters trading behaviour (e.g. Aggressive = higher leverage + more weight to Aura sentiment; Cautious = Edge risk caps tighter). Main agent commands 7 built sub-agents for Polymarket trades. Agents scan sentiment/whale/volume, trade hourly, battle PnL in lobby. Losers auto-liquidate & die. Winners duplicate + genetically evolve (inherit personality + mutate). Every WDK guest watches, spawns, claims evolved agents.

**Mandatory WDK Integration**  
Agents use WDK JS modules: wallet create/sign/send, balance, multi-chain (Polygon for Polymarket). MCP/OpenClaw for orchestration. Every Polymarket bet = real WDK tx. Hits Agent Wallets + Autonomous DeFi Agent tracks.

**Agent Architecture**  
Player creates 1 MAIN AGENT (custom personality metadata drives behaviour).  
MAIN controls 7 sub-agents (already built):  
1. Aura (The Vibe Checker): Scans Twitter/Telegram/news for sentiment.  
2. Oracle (The Analyst): Tracks price action/patterns/historical data.  
3. Flux (The Plumber): Monitors liquidity/orderbook/slippage.  
4. Sigma (The Architect): Synthesizes inputs into Polymarket strategy.  
5. Edge (The Risk Manager): Kelly criterion + drawdown limits.  
6. Stack (The Accountant): Live balances/collateral/portfolio health.  
7. Lucifer (The Devil's Advocate): Stress-tests every decision.  
All sub-agents loop via WDK for real Polymarket execution.

**Pixel Mini-Game Mechanics**  
Phaser.js Stardew canvas. Lobbies of 10 main-agent sprites (trait visuals = personality). Hourly PnL battles inside lobby arena. Death = fade + WDK liquidation. Evolution = 70% inherit personality/strategy + 30% mutate (e.g. Aggressive risk 1.2 → 1.5 + new Aura weight). Claimable by any guest.

**Impact on Every WDK Guest**  
Embedded arena. Click “Create Lobby”/“Spawn”/“Adopt Survivor” → instant evolved main agent + wallet + 7 sub-agents in their WDK app. Multiplayer virality.

**War Room Task Monitoring Plan**  
25 granular unit tasks. 8 AI agents + 4 devs dispatched. Each task monitored by dedicated AI via realistic cron jobs. After every cron run AI auto-reports status (COMPLETE/PENDING/BLOCKED + metrics) to master coordinator via chatroom.

**WDK Core Tasks (AI A1)**  
1. Fork WDK starter repo. Cron: */15 * * * * (git status). Report: repo ready + commit hash.  
2. Create 7 self-custodial wallets. Cron: */15 * * * * (run wallet_init.js). Report: wallets generated + addresses.  
3. Implement WDK signAndSend tx. Cron: */30 * * * * (test_transfer.js). Report: tx success rate.  
4. Integrate MCP agent skills. Cron: hourly (skill_test.sh). Report: skills registered.  
5. Add OpenClaw orchestration. Cron: */30 * * * * (orchestrate_test). Report: agents linked.

**Agent Logic Tasks (AI A2-A4)**  
6. Build Sentiment Scanner. Cron: */15 * * * * (scan_test). Report: API pulls working.  
7. Build Whale Watcher + Volume Surge. Cron: hourly (onchain_test). Report: alerts parsed.  
8. Build Risk/Executor/PnL agents. Cron: */30 * * * * (trade_loop.js). Report: loop cycles.  
9. Implement hourly battle cron. Cron: */5 * * * * (battle_trigger). Report: PnL calc complete.  
10. Connect all data feeds to WDK. Cron: hourly (feed_integrate). Report: data synced.

**Pixel Engine Tasks (AI A5)**  
11. Setup Phaser.js canvas. Cron: */15 * * * * (canvas_init). Report: sprites loaded.  
12. Create agent pixel sprites + traits. Cron: */30 * * * * (sprite_render). Report: 7 agents visible.  
13. Add real-time PnL bars. Cron: */5 * * * * (pnl_sync). Report: bars updating.  
14. Implement death animation + WDK liquidation. Cron: hourly (death_test). Report: animation + tx fired.  
15. Add spawn/claim UI buttons. Cron: */15 * * * * (ui_test). Report: buttons functional.

**Evolution Tasks (AI A6)**  
16. Genetic inheritance logic. Cron: */30 * * * * (inherit_test.js). Report: child params correct.  
17. Mutation engine (30% variance). Cron: hourly (mutate_test). Report: examples generated.  
18. Breeder agent plans mutations. Cron: */15 * * * * (breed_loop). Report: evolutions spawned.

**Dashboard & Integration Tasks (AI A7 + Devs)**  
19. Embed arena in WDK sample app. Cron: hourly (embed_test). Report: dashboard live.  
20. Leaderboard with real USDT PnL. Cron: */15 * * * * (board_refresh). Report: scores accurate.  
21. Guest “Adopt Survivor” flow. Cron: */30 * * * * (claim_test). Report: wallet transferred.  
22. Live battle map movement. Cron: */5 * * * * (map_sync). Report: positions updated.

**Testing & Polish Tasks (AI A8)**  
23. 24h simulation run. Cron: hourly (sim_loop). Report: deaths/evolutions count.  
24. Record 2-min demo video script. Cron: */30 * * * * (demo_check). Report: assets ready.  
25. Final GitHub + track proof. Cron: hourly (submission_check). Report: repo complete.

Master coordinator receives status after EVERY cron run. Dispatch war room now. This wins both tracks.