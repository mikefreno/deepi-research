/**
 * Deep Research — Core research orchestration
 *
 * Manages the multi-round deep research process:
 * 1. Decompose the question into sub-questions (when depth > 1)
 * 2. Generate initial search queries (per sub-question for better diversity)
 * 3. Execute all queries in parallel via Firecrawl
 * 4. Analyze results and extract findings
 * 5. Compute corroboration scores
 * 6. Generate follow-up queries for gaps
 * 7. Iterate for depth rounds
 * 8. Synthesize final report with numbered references
 *
 * Widget and progress callback patterns borrowed from ralpi's executor.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	Finding,
	ResearchConfig,
	EnrichedSearchResult,
	ResearchRound,
	ResearchReport,
} from "./types";
import type { SynthesisResult } from "./report";
import { searchWeb } from "./firecrawl";
import {
	generateQueries,
	generateFollowUpQueries,
	analyzeResults,
	computeCorroboration,
	decomposeQuestion,
} from "./queries";
import { synthesizeReport } from "./report";

/** Progress callback for UI updates */
export type ResearchProgress = (update: {
	phase:
		| "decomposing"
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

// ── Round-Robin Parallel Execution ──────────────────────────────────

/**
 * Maximum concurrent Firecrawl search requests.
 * Prevents rate limiting while still parallelizing queries.
 */
const MAX_SEARCH_CONCURRENT = 3;

/**
 * Maximum concurrent analysis agent sessions.
 */
const MAX_ANALYSIS_CONCURRENT = 2;

/**
 * Minimum findings per round before we consider early stopping.
 * If we're getting very few new findings, saturation is near.
 */
const SATURATION_THRESHOLD = 0.15; // < 15% new findings = likely saturated

/**
 * Bounded-concurrency parallel execution with round-robin slot assignment.
 *
 * Similar to ralpi's ModelRoundRobin: with N concurrent slots, items are
 * assigned to free slots in FIFO order. When a slot finishes, the next
 * item in the queue is assigned to it.
 *
 * This ensures even load distribution and avoids bursty concurrency.
 */
async function boundedConcurrency<T, R>(
	items: T[],
	maxConcurrent: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (true) {
			const currentIndex = nextIndex++;
			if (currentIndex >= items.length) return;
			results[currentIndex] = await mapper(items[currentIndex], currentIndex);
		}
	}

	const numWorkers = Math.min(maxConcurrent, items.length);
	const workers = Array.from({ length: numWorkers }, () => worker());
	await Promise.all(workers);
	return results;
}

/**
 * Assess whether the research is reaching information saturation.
 */
function assessSaturation(
	previousRound: ResearchRound | undefined,
	currentRound: ResearchRound,
): number {
	if (!previousRound || previousRound.findings.length === 0) return 0;

	const prevUrls = new Set(previousRound.results.map((r) => r.url));
	const newUrls = currentRound.results.filter(
		(r) => !prevUrls.has(r.url),
	).length;
	const totalUrls = currentRound.results.length;
	const newRatio = totalUrls > 0 ? newUrls / totalUrls : 0;

	// Also check finding novelty
	const prevFindingTitles = new Set(
		previousRound.findings.map((f) => f.title.toLowerCase()),
	);
	const newFindings = currentRound.findings.filter(
		(f) => !prevFindingTitles.has(f.title.toLowerCase()),
	).length;
	const totalFindings = currentRound.findings.length;
	const findingNovelty = totalFindings > 0 ? newFindings / totalFindings : 0;

	// Weight: URL novelty (40%) + finding novelty (60%)
	return newRatio * 0.4 + findingNovelty * 0.6;
}

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
	let subQuestions: string[] = [];

	// ── Phase: Decompose question into sub-questions ────────────────

	if (config.depth > 1) {
		onProgress({
			phase: "decomposing",
			round: 1,
			totalRounds: config.depth,
			message: "Decomposing research question into sub-topics...",
			fraction: 0,
		});

		if (signal?.aborted) throw new Error("Research cancelled");

		subQuestions = await decomposeQuestion(config.question, ctx.cwd, signal);
	}

	// ── Phase: Generate initial queries ─────────────────────────────

	onProgress({
		phase: "generating_queries",
		round: 1,
		totalRounds: config.depth,
		message:
			subQuestions.length > 0
				? `Generating queries across ${subQuestions.length} sub-topics...`
				: "Generating initial search queries...",
		fraction: 0.05,
	});

	if (signal?.aborted) throw new Error("Research cancelled");

	const queries = await generateQueries(
		config.question,
		config.breadth,
		ctx.cwd,
		signal,
		subQuestions.length > 0 ? subQuestions : undefined,
	);

	if (queries.length === 0) {
		throw new Error("Failed to generate any search queries");
	}

	// ── Execute rounds ───────────────────────────────────────────────

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

		// ── Search phase (parallel with round-robin) ────────────────────

		onProgress({
			phase: "searching",
			round,
			totalRounds: config.depth,
			message: `Searching ${currentQueries.length} queries in parallel...`,
			fraction: 0.25,
		});

		if (signal?.aborted) throw new Error("Research cancelled");

		// Run searches in parallel using round-robin bounded concurrency.
		// Each mapper call runs independently; failures are caught per-query.
		const searchResultsArrays: (EnrichedSearchResult[] | null)[] =
			await boundedConcurrency(
				currentQueries,
				MAX_SEARCH_CONCURRENT,
				async (q, i) => {
					onProgress({
						phase: "searching",
						round,
						totalRounds: config.depth,
						message: `Searching: "${q.query.slice(0, 60)}..."`,
						detail: q.rationale,
						fraction: 0.25 + (i / currentQueries.length) * 0.25,
					});

					try {
						return await searchWeb(q.query, 5, signal);
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						onProgress({
							phase: "searching",
							round,
							totalRounds: config.depth,
							message: `Search failed: ${errorMsg.slice(0, 80)}`,
							fraction: 0.25 + ((i + 1) / currentQueries.length) * 0.25,
						});
						return null;
					}
				},
			);

		// Flatten results, filtering out nulls (failed searches)
		const searchResults: EnrichedSearchResult[] = searchResultsArrays
			.filter((r): r is EnrichedSearchResult[] => r !== null)
			.flat();

		totalSearches += currentQueries.length;

		// Deduplicate results by URL (prefer higher authority)
		const seen = new Map<string, EnrichedSearchResult>();
		for (const r of searchResults) {
			const existing = seen.get(r.url);
			if (!existing || r.authorityScore > existing.authorityScore) {
				seen.set(r.url, r);
			}
		}
		const uniqueResults = Array.from(seen.values());

		totalPages += uniqueResults.length;

		// ── Analyze phase (parallel with round-robin) ──────────────────

		onProgress({
			phase: "analyzing",
			round,
			totalRounds: config.depth,
			message: `Analyzing ${uniqueResults.length} search results in parallel...`,
			fraction: 0.6,
		});

		if (signal?.aborted) throw new Error("Research cancelled");

		// Build query-result pairs for parallel analysis
		const analysisTasks: Array<{
			query: (typeof currentQueries)[number];
			results: typeof uniqueResults;
			index: number;
		}> = [];

		const resultsPerQuery = Math.ceil(
			uniqueResults.length / currentQueries.length,
		);

		for (let i = 0; i < currentQueries.length; i++) {
			const startIdx = i * resultsPerQuery;
			const endIdx = Math.min(startIdx + resultsPerQuery, uniqueResults.length);
			const queryResults = uniqueResults.slice(startIdx, endIdx);

			if (queryResults.length === 0) continue;

			analysisTasks.push({
				query: currentQueries[i],
				results: queryResults,
				index: i,
			});
		}

		// Run analyses in parallel using round-robin bounded concurrency
		const findingsArrays: Finding[][] = await boundedConcurrency(
			analysisTasks,
			MAX_ANALYSIS_CONCURRENT,
			async (task) => {
				onProgress({
					phase: "analyzing",
					round,
					totalRounds: config.depth,
					message: `Analyzing: "${task.query.query.slice(0, 40)}..."`,
					fraction: 0.6 + (task.index / currentQueries.length) * 0.2,
				});

				try {
					return await analyzeResults(
						task.query.query,
						task.results,
						ctx.cwd,
						signal,
					);
				} catch {
					// Analysis failure shouldn't crash the round
					return [];
				}
			},
		);

		// Flatten all findings
		const allFindings: ResearchRound["findings"] = findingsArrays.flat();

		// ── Corroboration pass ────────────────────────────────────────
		// Cross-reference findings to compute corroboration scores
		const corroboratedFindings = computeCorroboration(allFindings);

		// Record this round
		const successfulSearches = currentQueries.length;
		const followUpTopics = corroboratedFindings
			.filter(
				(f: Finding) =>
					f.confidence === "low" && (f.corroborationScore ?? 0) < 0.5,
			)
			.map((f: Finding) => f.title);

		rounds.push({
			round,
			queries: currentQueries,
			results: uniqueResults,
			findings: corroboratedFindings,
			followUpTopics,
			successfulSearches,
		});

		// ── Adaptive depth: check for saturation ──────────────────────
		if (round > 1 && round < config.depth) {
			const saturation = assessSaturation(
				rounds[rounds.length - 2],
				rounds[rounds.length - 1],
			);
			if (saturation < SATURATION_THRESHOLD) {
				onProgress({
					phase: "synthesizing",
					message: `Information saturation reached (${(saturation * 100).toFixed(0)}% novelty) — synthesizing early`,
					fraction: 0.85,
				});
				break;
			}
		}
	}

	// ── Synthesis phase ───────────────────────────────────────────────

	onProgress({
		phase: "synthesizing",
		message: "Synthesizing research into final report...",
		fraction: 0.9,
	});

	if (signal?.aborted) throw new Error("Research cancelled");

	const synthesisResult: SynthesisResult = await synthesizeReport(
		config.question,
		rounds,
		config,
		ctx.cwd,
		signal,
	);
	const finalReport = synthesisResult.report;
	const references = synthesisResult.references;

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
		references,
	};
}
