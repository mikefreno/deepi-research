/**
 * Deep Research — type definitions
 */

/** A single search result from Firecrawl */
export interface SearchResult {
	title: string;
	url: string;
	description: string;
	markdown: string;
}

/** A finding extracted from search results by an analysis agent */
export interface Finding {
	title: string;
	summary: string;
	sources: string[];
	keyQuotes: string[];
	confidence: "high" | "medium" | "low";
}

/** A generated search query with its intent/rationale */
export interface SearchQuery {
	query: string;
	rationale: string;
	angle: string;
}

/** Output from one research round */
export interface ResearchRound {
	round: number;
	queries: SearchQuery[];
	results: SearchResult[];
	findings: Finding[];
	/** Any follow-up questions/angles the analysis suggests */
	followUpTopics: string[];
}

/** Configuration for a research session */
export interface ResearchConfig {
	question: string;
	depth: number; // 1-3 rounds
	breadth: number; // queries per round (1-5)
	format: "markdown" | "structured";
}

/** Final research report */
export interface ResearchReport {
	question: string;
	rounds: ResearchRound[];
	finalReport: string;
	totalSearches: number;
	totalPagesScraped: number;
	durationMs: number;
}
