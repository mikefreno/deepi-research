/**
 * Deep Research — direct Firecrawl HTTP client
 *
 * Calls the self-hosted Firecrawl API directly (same approach as the
 * firecrawl.ts extension)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SearchResult } from "./types";

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
 * Search the web and return structured results.
 * Uses Firecrawl's search endpoint with scrape to get full page content.
 */
export async function searchWeb(
	query: string,
	limit: number = 5,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
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

	return res.data
		.map((doc) => ({
			title: (doc.title as string) ?? "",
			url: (doc.url as string) ?? "",
			description: (doc.description as string) ?? "",
			markdown: (doc.markdown as string) ?? "",
		}))
		.filter((r) => r.markdown || r.description);
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
