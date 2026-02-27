export function extractKeywords(question: string): string[] {
  const stopwords = new Set([
    "will", "the", "a", "an", "be", "is", "are", "was",
    "were", "in", "on", "at", "by", "for", "of", "to",
    "and", "or", "not", "that", "this", "it", "he", "she",
    "they", "with", "from", "what", "when", "who", "which",
    "how", "than", "before", "after", "during", "do", "does", "did", "have", "has", "had"
  ]);

  return question
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(" ")
    .filter(w => w.length > 3 && !stopwords.has(w.toLowerCase()))
    .slice(0, 3);
}

export function extractMainKeyword(question: string): string {
  const words = extractKeywords(question);
  return words.length > 0 ? words[0] : question.split(" ")[0] || "";
}
