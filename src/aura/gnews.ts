// src/aura/gnews.ts
// Google News RSS client — equivalent of python GNews library
// No API key needed. Public RSS feed.

export interface GNewsArticle {
  title: string;
  description: string;
  url: string;
  publishedAt: string;
  source: string;
}

/**
 * Fetch news from Google News RSS for a query.
 * Equivalent to GNews().get_news(query)
 */
export async function fetchGNews(
  query: string,
  options: {
    maxResults?: number;
    language?: string;
    country?: string;
    periodDays?: number;
  } = {}
): Promise<GNewsArticle[]> {
  const {
    maxResults = 10,
    language = "en",
    country = "US",
    periodDays,
  } = options;

  const encodedQuery = encodeURIComponent(query) + (periodDays ? `+when:${periodDays}d` : "");
  const url = `https://news.google.com/rss/search?q=${encodedQuery}&hl=${language}&gl=${country}&ceid=${country}:${language}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[GNews] HTTP ${res.status} for query: ${query}`);
      return [];
    }

    const xml = await res.text();
    return parseRssItems(xml, maxResults);
  } catch (err) {
    console.warn(`[GNews] Fetch failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}

function parseRssItems(xml: string, maxResults: number): GNewsArticle[] {
  const articles: GNewsArticle[] = [];

  // Parse <item> blocks from RSS XML without external dependencies
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && articles.length < maxResults) {
    const item = match[1];

    const title = extractTag(item, "title");
    const description = extractTag(item, "description");
    const link = extractTag(item, "link");
    const pubDate = extractTag(item, "pubDate");
    const source = extractTag(item, "source");

    if (title) {
      let sourceName = stripHtml(source);
      // Google News titles often end with " - Source Name"; extract as fallback
      if (!sourceName) {
        const cleanTitle = stripHtml(title);
        const dashIdx = cleanTitle.lastIndexOf(" - ");
        if (dashIdx > 0 && cleanTitle.length - dashIdx < 60) {
          sourceName = cleanTitle.slice(dashIdx + 3).trim();
        }
      }
      articles.push({
        title: stripHtml(title),
        description: stripHtml(description),
        url: link,
        publishedAt: pubDate,
        source: sourceName || "Google News",
      });
    }
  }

  return articles;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA sections
  const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"));
  if (cdataMatch) return cdataMatch[1].trim();

  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}
