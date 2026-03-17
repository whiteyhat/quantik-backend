import { Queue, Worker, QueueEvents } from "bullmq";
import { getRedis, isRedisEnabled } from "./redis";

// ── Queue Definitions ─────────────────────────────────────────────────────────
// All scheduled jobs go through BullMQ when Redis is available.
// When Redis is not set, the system falls back to setInterval (legacy mode).

export const QUEUE_NAMES = {
  SCANNER: "scanner",          // Market scanner (5min cycle)
  ORCHESTRATOR: "orchestrator",// Orchestrator scheduler (10min cycle)
  HOT_SCANNER: "hot-scanner",  // Hot markets scanner (60s cycle)
  FILL_MONITOR: "fill-monitor",// Paper order fill monitor (30s cycle)
  PNL_SETTLER: "pnl-settler",  // PnL settlement (30min cycle)
  ALERT_POLLER: "alert-poller",// Telegram alert poller (60s cycle)
  RESOLUTION: "resolution",    // Resolution monitor (5min cycle)
  POSITION_UPDATE: "position-update", // Live position P&L emitter (30s cycle)
  BYO_HEALTH: "byo-health",           // BYO agent heartbeat monitor (60s cycle)
  ARENA_SNAPSHOTS: "arena-snapshots",  // Arena rank snapshots (60min cycle)
} as const;

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();

function getConnectionOpts() {
  return { connection: getRedis() };
}

// ── Queue Factory ─────────────────────────────────────────────────────────────

export function getQueue(name: QueueName): Queue {
  if (!queues.has(name)) {
    const queue = new Queue(name, {
      ...getConnectionOpts(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
      },
    });
    queues.set(name, queue);
  }
  return queues.get(name)!;
}

// ── Worker Factory ────────────────────────────────────────────────────────────

interface WorkerConfig {
  name: QueueName;
  processor: () => Promise<void>;
  concurrency?: number;
}

export function createWorker(config: WorkerConfig): Worker {
  const worker = new Worker(
    config.name,
    async () => {
      await config.processor();
    },
    {
      ...getConnectionOpts(),
      concurrency: config.concurrency ?? 1,
      // Lock must outlive the longest possible job execution. Default is 30s,
      // which is too tight for queues that run every 30s — any slight delay
      // causes the lock to expire before the job completes, producing
      // "Missing lock" errors. BullMQ auto-renews at lockDuration/2 (45s here).
      lockDuration: 90000,
      limiter: {
        max: 1,
        duration: 1000,
      },
    }
  );

  worker.on("completed", (job) => {
    if (job) {
      console.log(`[bullmq] ${config.name} job ${job.id} completed`);
    }
  });

  worker.on("failed", (job, err) => {
    console.error(`[bullmq] ${config.name} job ${job?.id} failed:`, err.message);
  });

  // Catch worker-level errors (e.g. "Missing lock" on stalled jobs) to prevent
  // unhandled rejections from surfacing as crashes.
  worker.on("error", (err) => {
    console.error(`[bullmq] ${config.name} worker error:`, err.message);
  });

  workers.set(config.name, worker);
  return worker;
}

// ── Schedule Repeatable Jobs ──────────────────────────────────────────────────

interface ScheduleConfig {
  name: QueueName;
  intervalMs: number;
  processor: () => Promise<void>;
  concurrency?: number;
  immediate?: boolean; // run once immediately on startup
}

export async function scheduleRepeatable(config: ScheduleConfig): Promise<void> {
  const queue = getQueue(config.name);

  // Remove any existing repeatable jobs for this queue
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  // Add new repeatable job
  await queue.add(
    config.name,
    {},
    {
      repeat: { every: config.intervalMs },
      jobId: `${config.name}-repeatable`,
    }
  );

  // Create worker
  createWorker({
    name: config.name,
    processor: config.processor,
    concurrency: config.concurrency,
  });

  // Run immediately if requested
  if (config.immediate) {
    config.processor().catch((err) => {
      console.error(`[bullmq] ${config.name} immediate run failed:`, err.message);
    });
  }

  console.log(`[bullmq] Scheduled ${config.name} every ${config.intervalMs / 1000}s`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

export async function closeQueues(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  for (const [, worker] of workers) {
    closePromises.push(worker.close());
  }
  for (const [, queue] of queues) {
    closePromises.push(queue.close());
  }

  await Promise.allSettled(closePromises);
  workers.clear();
  queues.clear();
}
