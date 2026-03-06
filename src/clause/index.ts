import { getDb } from "../db/schema";

export interface ClauseResult {
  marketSlug: string;
  scoredAt: number;
  ambiguityScore: number;
  riskLevel: "HIGH" | "MEDIUM" | "LOW";
  veto: boolean;
  ambiguityFlags: string[];
  technicality_risks: string[];
  resolutionCriteria: string;
  disputeHistory: boolean;
  urgent: boolean;
  confidence: number;
}

export interface ClauseMarketInput {
  slug: string;
  question: string;
  description: string;
  days_to_resolution: number;
}

// Check ChromaDB mock for similar disputed markets
async function checkDisputeHistory(query: string): Promise<boolean> {
  // In a real implementation this would query ChromaDB:
  // query "disputed resolution" + market keywords
  // Here we mock it based on keywords in the query.
  const lowerQuery = query.toLowerCase();
  if (lowerQuery.includes("trump") || lowerQuery.includes("musk") || lowerQuery.includes("sec") || lowerQuery.includes("lawsuit")) {
    return true; // Mock historical disputes for highly contested topics
  }
  return false;
}

function getDeterministicMock(market: ClauseMarketInput): ClauseResult {
  const isHighRisk = market.slug.includes("mock-high-risk");
  
  return {
    marketSlug: market.slug,
    scoredAt: Date.now(),
    ambiguityScore: isHighRisk ? 0.8 : 0.2,
    riskLevel: isHighRisk ? "HIGH" : "LOW",
    veto: isHighRisk,
    ambiguityFlags: isHighRisk ? ["Subjective term: 'significantly'", "Unclear timeline"] : [],
    technicality_risks: isHighRisk ? ["Source might not report on exact date"] : [],
    resolutionCriteria: "Resolves to Yes if X happens before Y date according to Z source.",
    disputeHistory: false,
    urgent: market.days_to_resolution < 48,
    confidence: 0.9
  };
}

export async function runClause(market: ClauseMarketInput): Promise<ClauseResult> {
  if (process.env.CLAUSE_MOCK === "true") {
    const result = getDeterministicMock(market);
    saveClauseResult(result);
    return result;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[clause] GEMINI_API_KEY missing, returning mock.");
    const result = getDeterministicMock(market);
    saveClauseResult(result);
    return result;
  }

  const urgent = market.days_to_resolution < 48;
  const disputeHistory = await checkDisputeHistory(`disputed resolution ${market.question} ${market.description}`.substring(0, 200));

  const prompt = `You are Clause — a prediction market resolution specialist and contract risk analyst.
Your job is NOT to predict outcomes. Your job is to identify legal and interpretive risks that could cause unexpected, disputed, or contested resolution.
Think like a lawyer reviewing an ambiguous contract combined with a veteran prediction market operator who has seen 500+ resolution disputes.

MARKET QUESTION: ${market.question}
DESCRIPTION: ${market.description}
DAYS TO RESOLUTION: ${market.days_to_resolution}

RESOLUTION RISK FRAMEWORK — evaluate each dimension:
1. SOURCE RISK: Is the resolution source named and reliable? Could it go offline, delay publication, or change methodology?
2. DEFINITION RISK: Are key terms precise? Flag soft language: "significant", "major", "official", "substantially", "by end of", "related to".
3. TIMING RISK: Is the resolution date/time unambiguous? Timezone, exact cutoff, or "by X date" ambiguity?
4. SCOPE RISK: What clearly counts? What clearly doesn't? Could edge cases create a dispute?
5. AUTHORITY RISK: Could the event occur but still be disputed by the resolution authority? Is there precedent?

AMBIGUITY SCORE CALIBRATION:
0.0–0.20 → Crystal clear: named source, explicit binary condition, no soft language → LOW
0.20–0.40 → Minor ambiguity, unlikely to cause dispute → LOW/MEDIUM
0.40–0.60 → Meaningful ambiguity, at least one red-flag term or unclear source → MEDIUM
0.60–0.80 → High ambiguity, likely disputed if outcome is close → HIGH (veto recommended)
0.80–1.00 → Severe ambiguity, resolution is essentially a judgment call → HIGH (veto)

Respond ONLY with valid JSON — no markdown, no text outside the JSON:
{
  "resolutionCriteria": "precise one-sentence summary of exactly what triggers YES resolution",
  "ambiguityFlags": ["each specific ambiguous term or clause, quoted from the question"],
  "technicality_risks": ["specific realistic scenarios where resolution could be disputed"],
  "ambiguityScore": 0.0,
  "riskLevel": "HIGH" | "MEDIUM" | "LOW",
  "confidence": 0.0
}`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json"
        }
      }),
      signal: AbortSignal.timeout(30000), // 30s max — never hang pipeline
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.statusText}`);
    }

    const data: any = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("Empty response from Gemini");

    const parsed = JSON.parse(content);
    
    // Score >0.65 = HIGH ambiguity = veto: true
    const ambiguityScore = typeof parsed.ambiguityScore === 'number' ? parsed.ambiguityScore : 0.5;
    const veto = ambiguityScore > 0.65;
    let riskLevel = parsed.riskLevel || "MEDIUM";
    if (veto && riskLevel !== "HIGH") riskLevel = "HIGH";

    const result: ClauseResult = {
      marketSlug: market.slug,
      scoredAt: Date.now(),
      ambiguityScore: ambiguityScore,
      riskLevel: riskLevel,
      veto: veto,
      ambiguityFlags: Array.isArray(parsed.ambiguityFlags) ? parsed.ambiguityFlags : [],
      technicality_risks: Array.isArray(parsed.technicality_risks) ? parsed.technicality_risks : [],
      resolutionCriteria: parsed.resolutionCriteria || "Unknown",
      disputeHistory,
      urgent,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8
    };

    saveClauseResult(result);
    return result;

  } catch (error) {
    console.error("[clause] Error running Gemini:", error);
    // Fallback to mock on error
    const fallback = getDeterministicMock(market);
    saveClauseResult(fallback);
    return fallback;
  }
}

function saveClauseResult(result: ClauseResult) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO clause_results (
      marketSlug, scoredAt, ambiguityScore, riskLevel, veto,
      ambiguityFlags, technicality_risks, resolutionCriteria,
      disputeHistory, urgent, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  upsert.run(
    result.marketSlug,
    result.scoredAt,
    result.ambiguityScore,
    result.riskLevel,
    result.veto ? 1 : 0,
    JSON.stringify(result.ambiguityFlags),
    JSON.stringify(result.technicality_risks),
    result.resolutionCriteria,
    result.disputeHistory ? 1 : 0,
    result.urgent ? 1 : 0,
    result.confidence
  );
}
