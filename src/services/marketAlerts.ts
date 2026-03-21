import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/schema";
import { isPgEnabled, pgExec, pgQuery } from "../db/postgres";
import { emitNotification, type PriceUpdateEventItem } from "../infra/socket";

interface MarketAlertRow {
  id: string;
  user_id: string;
  slug: string;
  question: string | null;
  direction: "above" | "below";
  threshold: number;
  enabled: number | boolean;
  last_state: string | null;
  last_triggered_at: number | null;
}

function nextState(direction: "above" | "below", price: number, threshold: number): "above" | "below" {
  if (direction === "above") {
    return price >= threshold ? "above" : "below";
  }
  return price <= threshold ? "below" : "above";
}

function normalizeEnabled(value: number | boolean): boolean {
  return value === true || value === 1;
}

async function loadEnabledAlerts(slugs: string[]): Promise<MarketAlertRow[]> {
  if (slugs.length === 0) return [];

  if (isPgEnabled()) {
    return pgQuery<MarketAlertRow>(
      `SELECT id, user_id, slug, question, direction, threshold, enabled, last_state, last_triggered_at
         FROM market_alerts
        WHERE enabled = 1
          AND slug = ANY($1::text[])`,
      [slugs]
    );
  }

  const db = getDb();
  const placeholders = slugs.map(() => "?").join(", ");
  return db.prepare(
    `SELECT id, user_id, slug, question, direction, threshold, enabled, last_state, last_triggered_at
       FROM market_alerts
      WHERE enabled = 1
        AND slug IN (${placeholders})`
  ).all(...slugs) as MarketAlertRow[];
}

async function updateAlertState(id: string, state: string, triggeredAt: number | null): Promise<void> {
  const now = Date.now();

  if (isPgEnabled()) {
    await pgExec(
      `UPDATE market_alerts
          SET last_state = $1, last_triggered_at = $2, updated_at = $3
        WHERE id = $4`,
      [state, triggeredAt, now, id]
    );
  } else {
    const db = getDb();
    db.prepare(
      `UPDATE market_alerts
          SET last_state = ?, last_triggered_at = ?, updated_at = ?
        WHERE id = ?`
    ).run(state, triggeredAt, now, id);
  }
}

export async function evaluateMarketAlerts(priceUpdates: PriceUpdateEventItem[]): Promise<void> {
  if (priceUpdates.length === 0) return;

  const updateMap = new Map(priceUpdates.map((item) => [item.slug, item]));
  const alerts = await loadEnabledAlerts(Array.from(updateMap.keys()));
  if (alerts.length === 0) return;

  const stateUpdates: Promise<void>[] = [];

  for (const alert of alerts) {
    if (!normalizeEnabled(alert.enabled)) continue;
    const update = updateMap.get(alert.slug);
    if (!update) continue;

    const state = nextState(alert.direction, update.yes, alert.threshold);
    const shouldTrigger =
      (alert.direction === "above" && state === "above" && alert.last_state !== "above") ||
      (alert.direction === "below" && state === "below" && alert.last_state !== "below");

    if (shouldTrigger) {
      const notificationTimestamp = Date.now();
      emitNotification(alert.user_id, {
        id: `market-alert-${alert.id}-${notificationTimestamp}`,
        level: "info",
        title: "Market alert triggered",
        message: `${alert.question ?? alert.slug} crossed ${Math.round(alert.threshold * 100)}¢ ${alert.direction}. Now ${Math.round(update.yes * 100)}¢.`,
        category: "market-alert",
        timestamp: notificationTimestamp,
        action: {
          label: "Open market",
          href: `/market/${alert.slug}`,
        },
      });
      stateUpdates.push(updateAlertState(alert.id, state, notificationTimestamp));
      continue;
    }

    if (alert.last_state !== state) {
      stateUpdates.push(updateAlertState(alert.id, state, alert.last_triggered_at ?? null));
    }
  }

  await Promise.all(stateUpdates);
}

export function newMarketAlertId(): string {
  return uuidv4();
}
