/**
 * Deep Research — direct Firecrawl HTTP client
 *
 * Calls the self-hosted Firecrawl API directly (same approach as the
 * firecrawl.ts extension)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SearchResult, EnrichedSearchResult, ContentType } from "./types";

/* ── Config ──────────────────────────────────────────────────────── */

function loadFirecrawlConfig() {
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		const fc = settings.firecrawl ?? {};
		return {
			baseUrl: (
				fc.baseUrl ??
				process.env.FIRECRAWL_BASE_URL ??
				"http://localhost:3002"
			).replace(/\/+$/, ""),
			apiKey: fc.apiKey ?? process.env.FIRECRAWL_API_KEY,
		};
	} catch {
		return {
			baseUrl: (
				process.env.FIRECRAWL_BASE_URL ?? "http://localhost:3002"
			).replace(/\/+$/, ""),
			apiKey: process.env.FIRECRAWL_API_KEY,
		};
	}
}

const { baseUrl: BASE_URL, apiKey: API_KEY } = loadFirecrawlConfig();

/* ── Domain Authority Heuristics ─────────────────────────────────── */

/**
 * Known high-authority domains and their authority scores (0.0 – 1.0).
 * Academic, official, and established technical sources score highest.
 */
const AUTHORITY_DOMAINS: Record<string, number> = {
	// Academic & scholarly
	"arxiv.org": 0.95,
	"scholar.google.com": 0.95,
	"pubmed.ncbi.nlm.nih.gov": 0.95,
	"semanticscholar.org": 0.9,
	"ieee.org": 0.95,
	"acm.org": 0.95,
	"springer.com": 0.9,
	"sciencedirect.com": 0.9,
	"wiley.com": 0.85,
	"nature.com": 0.95,
	"science.org": 0.95,
	"plos.org": 0.85,
	// Official documentation
	"docs.python.org": 0.9,
	"developer.mozilla.org": 0.9,
	"learn.microsoft.com": 0.85,
	"developer.apple.com": 0.85,
	"kubernetes.io": 0.85,
	"react.dev": 0.85,
	"nextjs.org": 0.8,
	// Government & non-profits
	".gov": 0.9,
	".edu": 0.85,
	"who.int": 0.9,
	"worldbank.org": 0.85,
	"oecd.org": 0.85,
	// Established tech & news
	"github.com": 0.8,
	"stackoverflow.com": 0.7,
	"medium.com": 0.4,
	"dev.to": 0.5,
	"wikipedia.org": 0.7,
	"reuters.com": 0.8,
	"apnews.com": 0.8,
	"bbc.com": 0.75,
	"nytimes.com": 0.75,
	"theguardian.com": 0.7,
	"techcrunch.com": 0.6,
	"arstechnica.com": 0.65,
	"wired.com": 0.65,
	"infoworld.com": 0.55,
};

/** Content-type hints based on domain patterns */
const CONTENT_TYPE_HINTS: [RegExp, ContentType][] = [
	[
		/arxiv\.org|semanticscholar|ieee\.org|acm\.org|springer|sciencedirect|pubmed\.ncbi/,
		"paper",
	],
	[
		/docs\.|learn\.|developer\.|kubernetes\.io|react\.dev|nextjs\.org/,
		"documentation",
	],
	[/wikipedia\.org|stackoverflow\.com|medium\.com|dev\.to/, "forum"],
	[
		/reuters\.com|apnews\.com|bbc\.com|nytimes\.com|techcrunch|arstechnica|wired/,
		"news",
	],
	[/\.gov|\.edu|who\.int|worldbank|oecd\.org/, "official"],
	[/github\.com/, "documentation"],
];

/* ── Source enrichment helpers ───────────────────────────────────── */

/**
 * Extract the registered domain from a URL (e.g., "blog.example.com" → "example.com").
 * Uses a simple 2-part TLD heuristic. For common cases like .co.uk this is approximate.
 */
function extractDomain(url: string): string {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		// Special-case common multi-part TLDs
		const multiPartTlds =
			/\.(co\.uk|org\.uk|ac\.uk|gov\.uk|com\.au|co\.jp|co\.kr|com\.br)$/;
		const parts = hostname.split(".");
		if (multiPartTlds.test(hostname) && parts.length >= 3) {
			return parts.slice(-3).join(".");
		}
		return parts.slice(-2).join(".");
	} catch {
		return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
	}
}

function computeAuthorityScore(domain: string): number {
	// Direct match first
	if (AUTHORITY_DOMAINS[domain]) return AUTHORITY_DOMAINS[domain];

	// Suffix matches (.gov, .edu, etc.)
	for (const [key, score] of Object.entries(AUTHORITY_DOMAINS)) {
		if (key.startsWith(".") && domain.endsWith(key)) return score;
	}

	// Subdomain matches (e.g., blog.example.com matches example.com)
	const parent = domain.split(".").slice(-2).join(".");
	if (parent !== domain && AUTHORITY_DOMAINS[parent]) {
		return AUTHORITY_DOMAINS[parent] * 0.9;
	}

	return 0.3; // Unknown / low-authority default
}

function detectContentType(url: string, description: string): ContentType {
	const lowerUrl = url.toLowerCase();
	const lowerDesc = description.toLowerCase();

	for (const [pattern, type] of CONTENT_TYPE_HINTS) {
		if (pattern.test(lowerUrl)) return type;
	}

	// Heuristics from description text
	if (/paper|research|study|experiment|analysis\b/.test(lowerDesc))
		return "paper";
	if (/documentation|guide|tutorial|api|reference/.test(lowerDesc))
		return "documentation";
	if (/blog|post|article|opinion/.test(lowerDesc)) return "blog";
	if (/news|report|announce|release/.test(lowerDesc)) return "news";
	if (/forum|discussion|question|answer|thread/.test(lowerDesc)) return "forum";

	return "other";
}

function tryParseDate(dateStr: string | undefined | null): Date | null {
	if (!dateStr) return null;
	const d = new Date(dateStr);
	return isNaN(d.getTime()) ? null : d;
}

/**
 * Enrich a raw search result with source authority metadata.
 * Accepts extra fields (e.g. date) from the Firecrawl API response.
 */
export function enrichResult(
	result: SearchResult & Record<string, unknown>,
): EnrichedSearchResult {
	const domain = extractDomain(result.url);
	return {
		...result,
		domain,
		authorityScore: computeAuthorityScore(domain),
		publishedDate: tryParseDate(result.date as string | undefined),
		contentType: detectContentType(result.url, result.description),
	};
}

/* ── Helpers ──────────────────────────────────────────────────────── */

async function firecrawlRequest(
	endpoint: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (API_KEY) {
		headers["Authorization"] = `Bearer ${API_KEY}`;
	}

	const res = await fetch(`${BASE_URL}/v1/${endpoint}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(
			`Firecrawl ${endpoint} failed (${res.status}): ${text.slice(0, 500)}`,
		);
	}

	return res.json();
}

export async function isFirecrawlReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE_URL}/v1/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
			},
			body: JSON.stringify({ url: "https://example.com", formats: ["links"] }),
			signal: AbortSignal.timeout(10_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/* ── Search ───────────────────────────────────────────────────────── */

/**
 * Search the web and return structured, enriched results.
 * Uses Firecrawl's search endpoint with scrape to get full page content.
 */
export async function searchWeb(
	query: string,
	limit: number = 5,
	signal?: AbortSignal,
): Promise<EnrichedSearchResult[]> {
	const body: Record<string, unknown> = {
		query,
		limit: Math.min(limit, 10),
		scrapeOptions: {
			formats: ["markdown"],
			onlyMainContent: true,
		},
	};

	const result = await firecrawlRequest("search", body, signal);

	if (!result || typeof result !== "object") return [];

	const res = result as {
		success?: boolean;
		data?: Record<string, unknown>[];
		error?: string;
	};

	if (!res.success || !res.data) return [];

	const rawResults: (SearchResult & Record<string, unknown>)[] = res.data
		.map((doc) => ({
			title: (doc.title as string) ?? "",
			url: (doc.url as string) ?? "",
			description: (doc.description as string) ?? "",
			markdown: (doc.markdown as string) ?? "",
			// Preserve extra fields for date extraction
			...doc,
		}))
		.filter((r) => r.markdown || r.description);

	// Enrich each result with source metadata
	return rawResults.map(enrichResult);
}

/* ── Scrape ───────────────────────────────────────────────────────── */

/**
 * Scrape a single URL and return its markdown content.
 */
export async function scrapeUrl(
	url: string,
	signal?: AbortSignal,
): Promise<{ title: string; markdown: string; links: string[] } | null> {
	const result = await firecrawlRequest(
		"scrape",
		{ url, formats: ["markdown"] },
		signal,
	);

	if (!result || typeof result !== "object") return null;

	const res = result as {
		success?: boolean;
		data?: Record<string, unknown>;
		error?: string;
	};

	if (!res.success || !res.data) return null;

	return {
		title: (res.data.title as string) ?? "",
		markdown: (res.data.markdown as string) ?? "",
		links: (res.data.links as string[]) ?? [],
	};
}
