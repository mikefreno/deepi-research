/**
 * Deep Research — type definitions
 */

/** Content type classification for a source */
export type ContentType =
	| "documentation"
	| "paper"
	| "news"
	| "blog"
	| "forum"
	| "official"
	| "other";

/** A single search result from Firecrawl */
export interface SearchResult {
	title: string;
	url: string;
	description: string;
	markdown: string;
}

/** Enriched search result with source authority metadata */
export interface EnrichedSearchResult extends SearchResult {
	domain: string;
	authorityScore: number; // 0.0 – 1.0
	publishedDate: Date | null;
	contentType: ContentType;
}

/** A finding extracted from search results by an analysis agent */
export interface Finding {
	title: string;
	summary: string;
	sources: string[];
	keyQuotes: string[];
	confidence: "high" | "medium" | "low";
	/** 0.0 – 1.0: how many independent sources support this finding */
	corroborationScore?: number;
	/** Authority score of the best source supporting this finding */
	bestSourceAuthority?: number;
	/** Average authority score across all sources */
	avgSourceAuthority?: number;
}

/** A numbered reference with full metadata */
export interface Reference {
	id: number;
	url: string;
	title: string;
	domain: string;
	authorityScore: number;
	accessedAt: string; // ISO date string
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
	results: EnrichedSearchResult[];
	findings: Finding[];
	/** Any follow-up questions/angles the analysis suggests */
	followUpTopics: string[];
	/** Number of sources that actually returned data (non-empty) */
	successfulSearches: number;
}

/** Target audience expertise level */
export type Audience = "expert" | "general" | "executive";

/** Configuration for a research session */
export interface ResearchConfig {
	question: string;
	depth: number; // 1-3 rounds
	breadth: number; // queries per round (1-5)
	format: "markdown" | "structured";
	audience?: Audience;
	/** Focus on specific research angles only (empty = all angles) */
	focus?: string[];
	/** Show the research methodology section in the report */
	showMethodology?: boolean;
}

/** Final research report */
export interface ResearchReport {
	question: string;
	rounds: ResearchRound[];
	finalReport: string;
	totalSearches: number;
	totalPagesScraped: number;
	durationMs: number;
	references: Reference[];
}
