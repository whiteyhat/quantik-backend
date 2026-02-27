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

  const prompt = `
You are Clause, the Resolution Agent for a prediction market trading system.
Extract resolution criteria. Identify ambiguous terms. Rate: HIGH/MEDIUM/LOW with 0-1 score.

Market Question: ${market.question}
Description: ${market.description}

Respond ONLY with a valid JSON object matching this schema:
{
  "resolutionCriteria": "string summarising exact conditions",
  "ambiguityFlags": ["string array of ambiguous terms or clauses"],
  "technicality_risks": ["string array of potential loopholes"],
  "ambiguityScore": 0.0 to 1.0 (float),
  "riskLevel": "HIGH" | "MEDIUM" | "LOW",
  "confidence": 0.0 to 1.0 (float)
}
  `;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json"
        }
      })
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
