/**
 * Deep Research — Core research orchestration
 *
 * Manages the multi-round deep research process:
 * 1. Generate initial search queries
 * 2. Execute all queries in parallel via Firecrawl
 * 3. Analyze results and extract findings
 * 4. Generate follow-up queries
 * 5. Iterate for depth rounds
 * 6. Synthesize final report
 *
 * Widget and progress callback patterns borrowed from ralpi's executor.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ResearchConfig,
	SearchResult,
	ResearchRound,
	ResearchReport,
} from "./types";
import { searchWeb } from "./firecrawl";
import {
	generateQueries,
	generateFollowUpQueries,
	analyzeResults,
} from "./queries";
import { synthesizeReport } from "./report";

/** Progress callback for UI updates */
export type ResearchProgress = (update: {
	phase:
		| "generating_queries"
		| "searching"
		| "analyzing"
		| "synthesizing"
		| "complete";
	round?: number;
	totalRounds?: number;
	message: string;
	detail?: string;
	fraction?: number; // 0-1
}) => void;

/**
 * Run a complete deep research session.
 */
export async function runDeepResearch(
	config: ResearchConfig,
	ctx: ExtensionContext,
	onProgress: ResearchProgress,
	signal?: AbortSignal,
): Promise<ResearchReport> {
	const startTime = Date.now();
	const rounds: ResearchRound[] = [];
	let totalSearches = 0;
	let totalPages = 0;

	// ── Round 1: Generate initial queries ──────────────────────────────

	onProgress({
		phase: "generating_queries",
		round: 1,
		totalRounds: config.depth,
		message: "Generating initial search queries...",
		fraction: 0,
	});

	if (signal?.aborted) throw new Error("Research cancelled");

	const queries = await generateQueries(
		config.question,
		config.breadth,
		ctx.cwd,
		signal,
	);

	if (queries.length === 0) {
		throw new Error("Failed to generate any search queries");
	}

	// ── Execute rounds ─────────────────────────────────────────────────

	for (let round = 1; round <= config.depth; round++) {
		if (signal?.aborted) throw new Error("Research cancelled");

		const isFirstRound = round === 1;
		const currentQueries = isFirstRound
			? queries
			: await generateFollowUpQueries(
					config.question,
					rounds,
					config.breadth,
					ctx.cwd,
					signal,
				);

		if (!currentQueries || currentQueries.length === 0) {
			// No follow-up queries to generate — stop here
			break;
		}

		// ── Search phase ──────────────────────────────────────────────────

		onProgress({
			phase: "searching",
			round,
			totalRounds: config.depth,
			message: `Searching with ${currentQueries.length} queries...`,
			fraction: 0.25,
		});

		const searchResults: SearchResult[] = [];

		for (let i = 0; i < currentQueries.length; i++) {
			if (signal?.aborted) throw new Error("Research cancelled");

			const q = currentQueries[i];
			onProgress({
				phase: "searching",
				round,
				totalRounds: config.depth,
				message: `Searching: "${q.query.slice(0, 60)}..."`,
				detail: q.rationale,
				fraction: 0.25 + (i / currentQueries.length) * 0.25,
			});

			try {
				const results = await searchWeb(q.query, 5, signal);
				searchResults.push(...results);
			} catch (error) {
				// Individual search failure shouldn't crash the whole round
				const errorMsg = error instanceof Error ? error.message : String(error);
				onProgress({
					phase: "searching",
					round,
					totalRounds: config.depth,
					message: `Search failed: ${errorMsg.slice(0, 80)}`,
					fraction: 0.25 + ((i + 1) / currentQueries.length) * 0.25,
				});
			}

			// Small delay between searches to avoid rate limits
			if (i < currentQueries.length - 1) {
				await new Promise((r) => setTimeout(r, 300));
			}
		}

		totalSearches += currentQueries.length;

		// Deduplicate results by URL
		const seen = new Set<string>();
		const uniqueResults = searchResults.filter((r) => {
			if (seen.has(r.url)) return false;
			seen.add(r.url);
			return true;
		});

		totalPages += uniqueResults.length;

		// ── Analyze phase ──────────────────────────────────────────────────

		onProgress({
			phase: "analyzing",
			round,
			totalRounds: config.depth,
			message: `Analyzing ${uniqueResults.length} search results...`,
			fraction: 0.6,
		});

		// Analyze results per query group
		const allFindings: ResearchRound["findings"] = [];

		for (let i = 0; i < currentQueries.length; i++) {
			if (signal?.aborted) throw new Error("Research cancelled");

			const q = currentQueries[i];
			// Find results that match this query (loosely: take a portion of results)
			const resultsPerQuery = Math.ceil(
				uniqueResults.length / currentQueries.length,
			);
			const startIdx = i * resultsPerQuery;
			const endIdx = Math.min(startIdx + resultsPerQuery, uniqueResults.length);
			const queryResults = uniqueResults.slice(startIdx, endIdx);

			if (queryResults.length === 0) continue;

			onProgress({
				phase: "analyzing",
				round,
				totalRounds: config.depth,
				message: `Analyzing results for "${q.query.slice(0, 40)}..."`,
				fraction: 0.6 + (i / currentQueries.length) * 0.2,
			});

			try {
				const findings = await analyzeResults(
					q.query,
					queryResults,
					ctx.cwd,
					signal,
				);
				allFindings.push(...findings);
			} catch {
				// Analysis failure shouldn't crash the round
			}
		}

		// Record this round
		rounds.push({
			round,
			queries: currentQueries,
			results: uniqueResults,
			findings: allFindings,
			followUpTopics: allFindings
				.filter((f) => f.confidence === "low")
				.map((f) => f.title),
		});
	}

	// ── Synthesis phase ─────────────────────────────────────────────────

	onProgress({
		phase: "synthesizing",
		message: "Synthesizing research into final report...",
		fraction: 0.9,
	});

	if (signal?.aborted) throw new Error("Research cancelled");

	const finalReport = await synthesizeReport(
		config.question,
		rounds,
		config,
		ctx.cwd,
		signal,
	);

	const durationMs = Date.now() - startTime;

	onProgress({
		phase: "complete",
		message: "Research complete!",
		fraction: 1.0,
	});

	return {
		question: config.question,
		rounds,
		finalReport,
		totalSearches,
		totalPagesScraped: totalPages,
		durationMs,
	};
}
