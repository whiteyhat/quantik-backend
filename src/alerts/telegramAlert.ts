/**
 * telegramAlert.ts — Quantik Telegram Signal Alert Engine
 * Sends formatted signal alerts to Carlos with inline Execute/Skip buttons.
 */

import { getDb } from "../db/schema";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID ?? "-5238563355";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScanResult {
  id: string;
  slug: string;
  question: string;
  recommendation: "BET YES" | "BET NO" | "SKIP" | "VETO";
  sigma_confidence: number;
  kelly_fraction: number;
  kelly_amount: number;
  oracle_prob: number;
  market_price: number;
  edge: number;
  sigma_thesis: string;
  clause_risk_level: string;
  clause_summary: string;
}

// ── Core HTTP helper ───────────────────────────────────────────────────────

async function tgPost(method: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${TELEGRAM_API}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram ${method} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Alert formatting ───────────────────────────────────────────────────────

function formatSignalAlert(r: ScanResult): string {
  const side = r.recommendation === "BET YES" ? "YES" : "NO";
  const confPct  = Math.round(r.sigma_confidence * 100);
  const kellyFmt = r.kelly_fraction.toFixed(3);
  const oraclePct = Math.round(r.oracle_prob * 100);
  const mktPct    = Math.round(r.market_price * 100);
  const edgePct   = Math.round(r.edge * 100);

  return [
    `🎯 *QUANTIK SIGNAL*`,
    ``,
    `Market: ${escMd(r.question)} (\`${r.slug}\`)`,
    `Recommendation: *${r.recommendation}*`,
    `Confidence: ${confPct}% | Kelly: ${kellyFmt}`,
    `Probability: Oracle ${oraclePct}% vs Market ${mktPct}%`,
    `Edge: ${edgePct}%`,
    ``,
    `Thesis: ${escMd(r.sigma_thesis)}`,
    `Risk: *${escMd(r.clause_risk_level)}* — ${escMd(r.clause_summary)}`,
    ``,
    `_Expires: 30 min_`,
  ].join("\n");
}

function escMd(text: string): string {
  // Escape MarkdownV2 special chars
  return (text ?? "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ── Inline keyboard ────────────────────────────────────────────────────────

function buildInlineKeyboard(r: ScanResult) {
  const side = r.recommendation === "BET YES" ? "YES" : "NO";
  return {
    inline_keyboard: [
      [
        { text: "✅ Execute", callback_data: `exec:${r.slug}:${side}:${r.kelly_amount.toFixed(2)}` },
        { text: "❌ Skip",    callback_data: `skip:${r.slug}` },
      ],
      [
        { text: "📊 Details",  callback_data: `details:${r.slug}` },
        { text: "🔕 Mute 1hr", callback_data: `mute:3600` },
      ],
    ],
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function sendSignalAlert(result: ScanResult): Promise<boolean> {
  try {
    await tgPost("sendMessage", {
      chat_id: CHAT_ID,
      text: formatSignalAlert(result),
      parse_mode: "MarkdownV2",
      reply_markup: buildInlineKeyboard(result),
    });
    return true;
  } catch (err) {
    console.error("[telegramAlert] sendSignalAlert failed:", err);
    return false;
  }
}

export async function sendStatusUpdate(message: string): Promise<boolean> {
  try {
    await tgPost("sendMessage", {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    return true;
  } catch (err) {
    console.error("[telegramAlert] sendStatusUpdate failed:", err);
    return false;
  }
}

export async function handleCallback(callbackData: string): Promise<void> {
  const db = getDb();
  const [action, ...parts] = callbackData.split(":");

  if (action === "exec") {
    const [slug, side, amount] = parts;
    console.log(`[telegramAlert] EXECUTE signal: ${slug} ${side} $${amount}`);
    // Mark as executed in pipeline_runs
    db.prepare(
      `UPDATE pipeline_runs SET signal_state = 'TRADE', alert_sent = 2 WHERE market_slug = ? AND alert_sent = 1 ORDER BY created_at DESC LIMIT 1`
    ).run(slug);
    // Trigger paper execution if available
    try {
      const executionResp = await fetch(`http://localhost:${process.env.PORT ?? 3001}/api/execution/paper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, direction: side, size: parseFloat(amount) }),
      });
      if (!executionResp.ok) {
        console.warn(`[telegramAlert] paper execution returned ${executionResp.status}`);
      }
    } catch (e) {
      console.warn("[telegramAlert] paper execution call failed:", e);
    }
    await sendStatusUpdate(`⚡ Executing trade: <b>${slug}</b> → ${side} @ $${amount}`);

  } else if (action === "skip") {
    const [slug] = parts;
    console.log(`[telegramAlert] SKIP signal: ${slug}`);
    db.prepare(
      `UPDATE pipeline_runs SET signal_state = 'SKIP' WHERE market_slug = ? AND alert_sent = 1 ORDER BY created_at DESC LIMIT 1`
    ).run(slug);
    await sendStatusUpdate(`⏭ Skipped: <b>${slug}</b>`);

  } else if (action === "details") {
    const [slug] = parts;
    // Fetch latest pipeline run for this slug
    const run = db.prepare(
      `SELECT * FROM pipeline_runs WHERE market_slug = ? ORDER BY created_at DESC LIMIT 1`
    ).get(slug) as Record<string, unknown> | undefined;

    if (!run) {
      await sendStatusUpdate(`❓ No pipeline data found for <b>${slug}</b>`);
      return;
    }

    const snippet = JSON.stringify({
      oracle: safeJson(run.oracle_output as string),
      edge:   safeJson(run.edge_output as string),
      sigma:  safeJson(run.sigma_output as string),
      clause: safeJson(run.clause_output as string),
    }, null, 2).slice(0, 3800);

    await sendStatusUpdate(`<b>📊 Details: ${slug}</b>\n\n<pre>${snippet}</pre>`);

  } else if (action === "mute") {
    const [secs] = parts;
    const muteUntil = Date.now() + (parseInt(secs, 10) * 1000);
    db.prepare(`INSERT OR REPLACE INTO settings_kv (key, value) VALUES ('mute_until', ?)`).run(String(muteUntil));
    await sendStatusUpdate(`🔕 Alerts muted for ${Math.round(parseInt(secs) / 60)} minutes`);
  }
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

// ── DB migration helper ────────────────────────────────────────────────────

export function ensureAlertColumns(): void {
  const db = getDb();

  // Add alert_sent to pipeline_runs if missing
  const prCols = db.prepare("PRAGMA table_info(pipeline_runs)").all() as Array<{ name: string }>;
  if (!prCols.some((c) => c.name === "alert_sent")) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN alert_sent INTEGER DEFAULT 0");
  }

  // settings_kv for mute state
  db.exec(`CREATE TABLE IF NOT EXISTS settings_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}

// ── Alert Poller ───────────────────────────────────────────────────────────

export class AlertPoller {
  async pollAndAlert(): Promise<void> {
    const db = getDb();

    // Check mute
    const muteRow = db.prepare(`SELECT value FROM settings_kv WHERE key = 'mute_until'`).get() as { value: string } | undefined;
    if (muteRow && parseInt(muteRow.value, 10) > Date.now()) {
      return; // Muted
    }

    // Query pipeline_runs joined with edge_results for high-confidence signals
    // Derive signal state from decision/sigma_output (orchestrator doesn't set signal_state directly)
    const rows = db.prepare(`
      SELECT
        pr.id,
        pr.market_slug       AS slug,
        pr.market_question   AS question,
        pr.confidence        AS sigma_confidence,
        pr.decision,
        pr.signal_state,
        pr.sigma_output,
        pr.clause_output,
        pr.oracle_output,
        pr.edge_output,
        er.net_edge          AS edge,
        er.fractional_kelly  AS kelly_fraction,
        er.position_size     AS kelly_amount,
        er.direction
      FROM pipeline_runs pr
      LEFT JOIN edge_results er ON er.marketSlug = pr.market_slug
      WHERE pr.alert_sent = 0
        AND pr.confidence >= 0.65
        AND COALESCE(er.fractional_kelly, 0) >= 0.30
        AND (
          pr.signal_state = 'TRADE'
          OR pr.decision IN ('BUY_YES','BUY_NO','TRADE','BET_YES','BET_NO')
        )
      ORDER BY pr.created_at DESC
      LIMIT 10
    `).all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const sigmaData = safeJson(row.sigma_output as string) as Record<string, unknown> | null;
      const clauseData = safeJson(row.clause_output as string) as Record<string, unknown> | null;
      const oracleData = safeJson(row.oracle_output as string) as Record<string, unknown> | null;

      const recommendation = (row.direction as string) === "YES" ? "BET YES" : "BET NO";

      // Skip vetoed signals
      if (clauseData?.["veto"] === 1 || clauseData?.["veto"] === true) {
        db.prepare("UPDATE pipeline_runs SET alert_sent = -1 WHERE id = ?").run(row.id as string);
        continue;
      }

      const result: ScanResult = {
        id:               row.id as string,
        slug:             row.slug as string,
        question:         row.question as string ?? row.slug as string,
        recommendation:   recommendation as ScanResult["recommendation"],
        sigma_confidence: (row.sigma_confidence as number) ?? 0,
        kelly_fraction:   (row.kelly_fraction as number) ?? 0,
        kelly_amount:     (row.kelly_amount as number) ?? 0,
        oracle_prob:      (oracleData?.["calibrated_prob"] as number) ?? (row.sigma_confidence as number) ?? 0,
        market_price:     (oracleData?.["market_implied"] as number) ?? 0.5,
        edge:             (row.edge as number) ?? 0,
        sigma_thesis:     (sigmaData?.["thesis"] as string) ?? (sigmaData?.["reasoning"] as string) ?? "No thesis available",
        clause_risk_level:(clauseData?.["riskLevel"] as string) ?? "unknown",
        clause_summary:   (clauseData?.["resolutionCriteria"] as string) ?? "No clause data",
      };

      const sent = await sendSignalAlert(result);
      if (sent) {
        db.prepare("UPDATE pipeline_runs SET alert_sent = 1 WHERE id = ?").run(row.id as string);
        console.log(`[AlertPoller] Alert sent for ${result.slug}`);
      }
    }
  }
}
