# Project: backend

## Tech Stack
Node.js, Express, TypeScript

## File Structure
```
├── data/
│   └── fee_config.json
├── src/
│   ├── aura/
│   │   ├── index.ts
│   │   └── keywords.ts
│   ├── clause/
│   │   └── index.ts
│   ├── db/
│   │   ├── queries.ts
│   │   └── schema.ts
│   ├── edge/
│   │   ├── arb.ts
│   │   ├── correlation.ts
│   │   ├── fees.ts
│   │   ├── index.ts
│   │   └── kelly.ts
│   ├── flux/
│   ├── oracle/
│   │   ├── arb-detector.ts
│   │   ├── hot-scanner.ts
│   │   ├── index.ts
│   │   ├── longshot.ts
│   │   └── prompt.ts
│   ├── orchestrator/
│   │   └── index.ts
│   ├── routes/
│   │   ├── agentStatus.ts
│   │   ├── aura.ts
│   │   ├── chat.ts
│   │   ├── clause.ts
│   │   ├── edge.ts
│   │   ├── markets.ts
│   │   ├── oracle.ts
│   │   ├── orchestrator.ts
│   │   ├── pipeline.ts
│   │   ├── portfolio.ts
│   │   ├── risk.ts
│   │   ├── sentryWebhook.ts
│   │   ├── settings.ts
│   │   ├── sigma.ts
│   │   ├── stream.ts
│   │   ├── trade.ts
│   │   └── wallet.ts
│   ├── sigma/
│   │   └── index.ts
│   ├── cli.ts
│   └── index.ts
├── .env.example
├── Dockerfile
├── package.json
├── quantik.db
├── quantik.db-shm
├── quantik.db-wal
├── railway.json
├── STACK_FLUX_SPEC.md
└── tsconfig.json
```

## Key Files
- package.json (708 bytes)
- tsconfig.json (441 bytes)
- Dockerfile (577 bytes)
- .env.example (540 bytes)
- src/ (36 files)
