/**
 * telegramAlert.ts — Quantik Telegram Signal Alert Engine
 * Sends informational FYI alerts to Carlos. No buttons, no approval required.
 */

import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";

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
  // Execution metadata
  orderId?: string;
  executionStatus?: "placed" | "failed" | "paper";
  pnlToday?: number;
  tradesToday?: number;
}

// ── Core HTTP helper ───────────────────────────────────────────────────────

async function getTelegramConfig() {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM settings_kv WHERE key IN ('telegram_chat_id', 'telegram_bot_token')").all() as any[];
    const settings: any = {};
    rows.forEach(r => settings[r.key] = r.value);
    return {
      botToken: settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: settings.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || "-5238563355"
    };
  } catch {
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || "-5238563355"
    };
  }
}

async function tgPost(method: string, body: Record<string, unknown>): Promise<unknown> {
  const config = await getTelegramConfig();
  if (!config.botToken) throw new Error("Telegram bot token missing");
  const url = `https://api.telegram.org/bot${config.botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, chat_id: body.chat_id || config.chatId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram ${method} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Alert formatting ───────────────────────────────────────────────────────

/** Build a visual confidence bar: ████████░░ 80% */
function confidenceBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/** Map risk level to a readable label with icon */
function riskBadge(level: string): string {
  const normalized = (level ?? "").toUpperCase();
  if (normalized === "HIGH") return "🔴 HIGH";
  if (normalized === "MEDIUM") return "🟡 MEDIUM";
  if (normalized === "LOW") return "🟢 LOW";
  return "⚪ N/A";
}

/** Detect raw pipeline debug strings and convert to readable thesis */
function cleanThesis(raw: string): string {
  if (!raw) return "No thesis available";
  // Detect scanner inline synthesis: "Oracle(pipeline)=0.04 market=0.05 kelly=3.2%..."
  const pipelineMatch = raw.match(
    /Oracle\(pipeline\)=([\d.]+)\s+market=([\d.]+)\s+kelly=([\d.]+)%\s*aura_sentiment=([-\d.]+)\.\s*(.+)/
  );
  if (pipelineMatch) {
    const [, oracleStr, marketStr, kellyStr, auraStr, decision] = pipelineMatch;
    const oracle = (parseFloat(oracleStr) * 100).toFixed(0);
    const market = (parseFloat(marketStr) * 100).toFixed(0);
    const kelly = kellyStr;
    const aura = parseFloat(auraStr);
    const auraLabel = aura > 0.05 ? "bullish" : aura < -0.05 ? "bearish" : "neutral";
    const dir = decision.includes("YES") ? "YES" : "NO";
    return `Oracle sees ${oracle}% vs market at ${market}% → ${kelly}% Kelly edge on ${dir}. Sentiment: ${auraLabel}.`;
  }
  // Detect "Scanner signal: BET_NO @ p=0.04"
  if (raw.startsWith("Scanner signal:") || raw.startsWith("Scanner:")) {
    const dirMatch = raw.match(/BET_(YES|NO)/);
    const probMatch = raw.match(/p=([\d.]+)/);
    if (dirMatch && probMatch) {
      const prob = (parseFloat(probMatch[1]) * 100).toFixed(0);
      return `Scanner detected mispricing at ${prob}% true probability → ${dirMatch[1]}.`;
    }
  }
  return raw;
}

function formatSignalAlert(r: ScanResult): string {
  const confPct   = Math.round(r.sigma_confidence * 100);
  const kellyFmt  = (r.kelly_fraction * 100).toFixed(1);
  const oraclePct = Math.round((r.oracle_prob ?? 0) * 100);
  const mktPct    = Math.round((r.market_price ?? 0) * 100);
  // Edge: cap display at 100% and show as absolute difference
  const rawEdge   = Math.abs(r.edge ?? 0);
  const edgePct   = rawEdge > 1 ? rawEdge.toFixed(0) : Math.round(rawEdge * 100);
  const betAmt    = (r.kelly_amount ?? 0).toFixed(2);
  const side      = r.recommendation.replace("BET_", "").replace("BET ", "");
  const sideEmoji = side === "YES" ? "🟢" : side === "NO" ? "🔴" : "⚪";

  const status = r.executionStatus === "paper" ? "📝 PAPER" : "✅ EXECUTED";

  const pnlToday = r.pnlToday ?? 0;
  const pnlSign  = pnlToday >= 0 ? "+" : "";
  const polyUrl  = `https://polymarket.com/event/${encodeURIComponent(r.slug)}`;
  const thesis   = cleanThesis(r.sigma_thesis ?? "");
  const time     = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });

  const lines = [
    `⚡ <b>QUANTIK [${status}]</b>`,
    ``,
    `<b>${esc(r.question ?? r.slug)}</b>`,
    ``,
    `${sideEmoji} <b>${side}</b> · $${betAmt} USDC`,
    ``,
    `<code>${confidenceBar(confPct)}</code> <b>${confPct}%</b> confidence`,
    `📊 Oracle <b>${oraclePct}%</b> → Market <b>${mktPct}%</b> · Edge <b>${edgePct}%</b>`,
    `📐 Kelly <b>${kellyFmt}%</b>`,
    ``,
    `💡 <i>${esc(thesis)}</i>`,
    `⚠️ ${riskBadge(r.clause_risk_level)}`,
  ];

  // Order ID for executed trades
  if (r.orderId) {
    lines.push(``);
    lines.push(`🔗 Order: <code>${esc(r.orderId)}</code>`);
  }

  lines.push(``);
  lines.push(`📈 P&amp;L today: <b>${pnlSign}$${Math.abs(pnlToday).toFixed(2)}</b> · Trades: ${r.tradesToday ?? 0}`);
  lines.push(`🌐 <a href="${polyUrl}">View on Polymarket</a> · ${time} ET`);

  return lines.join("\n");
}

function esc(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function sendSignalAlert(result: ScanResult): Promise<boolean> {
  try {
    await tgPost("sendMessage", {
      text: formatSignalAlert(result),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("bot token missing")) {
      console.error("[telegramAlert] sendSignalAlert failed:", msg);
    }
    return false;
  }
}

export async function sendStatusUpdate(message: string): Promise<boolean> {
  try {
    await tgPost("sendMessage", {
      text: message,
      parse_mode: "HTML",
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("bot token missing")) {
      console.error("[telegramAlert] sendStatusUpdate failed:", msg);
    }
    return false;
  }
}

export async function handleCallback(callbackData: string): Promise<void> {
  const db = getDb();
  const [action, ...parts] = callbackData.split(":");

  if (action === "exec") {
    const [slug, side, amount] = parts;
    db.prepare(`UPDATE pipeline_runs SET signal_state = 'TRADE', alert_sent = 2 WHERE market_slug = ? AND alert_sent = 1 ORDER BY created_at DESC LIMIT 1`).run(slug);
    await sendStatusUpdate(`⚡ Executing trade: <b>${slug}</b> → ${side} @ $${amount}`);
  } else if (action === "skip") {
    const [slug] = parts;
    db.prepare(`UPDATE pipeline_runs SET signal_state = 'SKIP' WHERE market_slug = ? AND alert_sent = 1 ORDER BY created_at DESC LIMIT 1`).run(slug);
    await sendStatusUpdate(`⏭ Skipped: <b>${slug}</b>`);
  }
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Extract a numeric field from a parsed JSON object, trying multiple key names */
function extractNumber(data: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!data) return null;
  for (const key of keys) {
    const val = data[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** Extract a string field from a parsed JSON object, trying multiple key names */
function extractString(data: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!data) return null;
  for (const key of keys) {
    const val = data[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

// ── DB migration helper ────────────────────────────────────────────────────

export function ensureAlertColumns(): void {
  const db = getDb();
  const prCols = db.prepare("PRAGMA table_info(pipeline_runs)").all() as Array<{ name: string }>;
  if (!prCols.some((c) => c.name === "alert_sent")) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN alert_sent INTEGER DEFAULT 0");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS settings_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}

// ── Alert Poller ───────────────────────────────────────────────────────────

export class AlertPoller {
  async pollAndAlert(): Promise<void> {
    // Skip entirely if Telegram not configured — avoids flooding logs on startup
    const config = await getTelegramConfig();
    if (!config.botToken) return;

    const db = getDb();

    // Check mute
    const muteRow = db.prepare(`SELECT value FROM settings_kv WHERE key = 'mute_until'`).get() as { value: string } | undefined;
    if (muteRow && parseInt(muteRow.value, 10) > Date.now()) return;

    const rows = db.prepare(`
      SELECT
        pr.id, pr.market_slug AS slug, pr.market_question AS question, pr.confidence AS sigma_confidence,
        pr.decision, pr.signal_state, pr.sigma_output, pr.clause_output, pr.oracle_output, pr.edge_output,
        er.net_edge AS edge, er.fractional_kelly AS kelly_fraction, er.position_size AS kelly_amount, er.direction,
        ex.status AS exec_status, ex.order_id AS exec_order_id, ex.source AS exec_source
      FROM pipeline_runs pr
      LEFT JOIN edge_results er ON er.marketSlug = pr.market_slug
      LEFT JOIN executions ex ON ex.slug = pr.market_slug
        AND ex.executed_at >= pr.created_at
        AND ex.executed_at <= COALESCE(pr.completed_at, pr.created_at + 300000)
      WHERE pr.alert_sent = 0
        AND pr.confidence >= 0.55
        AND COALESCE(er.fractional_kelly, 0) >= 0.05
        AND (pr.signal_state = 'TRADE' OR pr.decision IN ('BUY_YES','BUY_NO','TRADE','BET_YES','BET_NO'))
      ORDER BY pr.created_at DESC LIMIT 1
    `).all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const sigmaData = safeJson(row.sigma_output as string) as Record<string, unknown> | null;
      const clauseData = safeJson(row.clause_output as string) as Record<string, unknown> | null;
      const oracleData = safeJson(row.oracle_output as string) as Record<string, unknown> | null;
      const edgeData = safeJson(row.edge_output as string) as Record<string, unknown> | null;
      const recommendation = (row.direction as string) === "YES" ? "BET YES" : "BET NO";

      if (clauseData?.["veto"] === 1 || clauseData?.["veto"] === true) {
        db.prepare("UPDATE pipeline_runs SET alert_sent = -1 WHERE id = ?").run(row.id as string);
        continue;
      }

      // Map execution status from DB to ScanResult format
      const execStatus = row.exec_status as string | null;
      const executionStatus: ScanResult["executionStatus"] | undefined =
        execStatus === "placed" ? "placed"
        : execStatus === "paper" ? "paper"
        : execStatus === "failed" ? "failed"
        : undefined;

      // Only notify for successfully executed trades (placed or paper)
      if (executionStatus !== "placed" && executionStatus !== "paper") {
        // No execution yet or failed — skip for now, will retry next poll
        // If failed, mark as sent to avoid retrying forever
        if (executionStatus === "failed") {
          db.prepare("UPDATE pipeline_runs SET alert_sent = -2 WHERE id = ?").run(row.id as string);
        }
        continue;
      }

      // Oracle prob: try calibrated_prob → estimated_true_prob → p_yes → raw_prob
      const oracleProb = extractNumber(oracleData, "calibrated_prob", "estimated_true_prob", "p_yes", "raw_prob")
        ?? (row.sigma_confidence as number) ?? 0;

      // Market price: try market_implied → yes_price → market_price
      const marketPrice = extractNumber(oracleData, "market_implied", "yes_price", "market_price") ?? 0.5;

      // Edge: prefer edge_results net_edge, fallback to computed |oracle - market|
      const rawEdge = (row.edge as number) ?? extractNumber(edgeData, "net_edge", "gross_edge") ?? null;
      const edge = rawEdge ?? Math.abs(oracleProb - marketPrice);

      // Thesis: sigma thesis → sigma reasoning → fallback
      const thesis = extractString(sigmaData, "thesis", "reasoning") ?? "No thesis available";

      // Clause risk: riskLevel (camelCase) → risk_level (snake_case)
      const riskLevel = extractString(clauseData, "riskLevel", "risk_level") ?? "N/A";

      const result: ScanResult = {
        id:               row.id as string,
        slug:             row.slug as string,
        question:         row.question as string ?? row.slug as string,
        recommendation:   recommendation as ScanResult["recommendation"],
        sigma_confidence: (row.sigma_confidence as number) ?? 0,
        kelly_fraction:   (row.kelly_fraction as number) ?? 0,
        kelly_amount:     (row.kelly_amount as number) ?? 0,
        oracle_prob:      oracleProb,
        market_price:     marketPrice,
        edge,
        sigma_thesis:     thesis,
        clause_risk_level: riskLevel,
        clause_summary:   extractString(clauseData, "resolutionCriteria", "resolution_criteria") ?? "",
        orderId:          (row.exec_order_id as string) ?? undefined,
        executionStatus,
      };

      const sent = await sendSignalAlert(result);
      if (sent) {
        db.prepare("UPDATE pipeline_runs SET alert_sent = 1 WHERE id = ?").run(row.id as string);
        console.log(`[AlertPoller] Alert sent for ${result.slug} (exec: ${executionStatus ?? "signal-only"})`);
      }
    }
  }
}
