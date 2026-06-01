/**
 * Deep Research — Search query generation & refinement
 *
 * Uses an LLM agent to generate search queries from different research
 * angles, then analyzes results to produce follow-up queries.
 */
import type {
	SearchQuery,
	Finding,
	ResearchRound,
	EnrichedSearchResult,
} from "./types";
import { runAnalysisAgent } from "./agent";

/* ── System Prompts ──────────────────────────────────────────────── */

const DECOMPOSE_SYSTEM = `You are a research methodology expert. Given a broad research question, your job is to break it down into 4-7 focused sub-questions that, when answered, collectively provide a complete answer to the original question.

Guidelines:
- Each sub-question should tackle ONE specific facet of the research question
- Cover different dimensions: what, how, why, who, comparison, evidence, implications
- Sub-questions should be independently researchable via web search
- Avoid overlap between sub-questions
- Prioritize questions that will surface concrete evidence over speculative ones

Output ONLY a JSON array of sub-question strings.

Example:
Input: "What are the benefits and risks of artificial intelligence in healthcare?"
Output: ["What specific AI technologies are currently deployed in clinical healthcare settings?", "What peer-reviewed evidence exists for AI improving diagnostic accuracy?", "What are the documented risks and failure cases of AI in healthcare?", "How do regulatory frameworks (FDA, EMA) address AI-based medical devices?", "What do healthcare practitioners report as barriers to AI adoption?"]
`;

const GENERATE_QUERIES_SYSTEM = `You are a research methodology expert. Your role is to generate effective web search queries that will yield high-quality, diverse information about a research topic.

Guidelines:
- Create queries from DIFFERENT angles (technical, practical, comparative, critical, forward-looking, authoritative)
- Each query should target a specific facet of the question
- Queries should use keywords that search engines rank well (avoid overly long questions)
- Cover contrasting viewpoints and alternative approaches
- Include queries for finding authoritative sources (docs, papers, official sites)
- Prioritize recent information where relevant

Output ONLY a JSON array of objects with fields:
- "query": the search query string
- "rationale": why this query will help answer the research question
- "angle": one of "technical" | "practical" | "comparative" | "critical" | "forward-looking" | "authoritative" | "historical" | "case-study" | "data-statistics" | "ethical"

Example:
[
  {"query": "Rust async/await performance benchmarks 2024", "rationale": "Understanding current performance characteristics", "angle": "technical"},
  {"query": "Rust vs Go concurrency patterns comparison", "rationale": "Comparative analysis helps contextualize trade-offs", "angle": "comparative"}
]
`;

const FOLLOWUP_SYSTEM = `You are a research analyst. Given the research question, sub-questions, and findings so far, your job is to identify what's still unknown and generate follow-up search queries to fill those gaps.

Look for:
- Claims made without sufficient evidence
- Conflicting information that needs resolution
- Angles that haven't been explored yet
- Missing authoritative sources
- Practical implications that need more detail
- Recent developments that might have updated findings

Output ONLY a JSON array of objects with fields:
- "query": the search query string
- "rationale": what gap this query fills or what angle it explores
- "angle": one of "technical" | "practical" | "comparative" | "critical" | "forward-looking" | "authoritative" | "historical" | "case-study" | "data-statistics" | "ethical"
`;

/* ── Sub-Question Decomposition ───────────────────────────────────── */

/**
 * Decompose a broad research question into focused, independently
 * researchable sub-questions. Returns the sub-questions or an empty
 * array if the LLM call fails.
 */
export async function decomposeQuestion(
	question: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const taskPrompt = `Break down this research question into 4-7 focused sub-questions:\n\n${question}`;

	const result = await runAnalysisAgent(
		DECOMPOSE_SYSTEM,
		taskPrompt,
		cwd,
		60_000,
		undefined,
		signal,
	);

	if (!result.success || !result.text) return [];

	try {
		const parsed = JSON.parse(result.text);
		if (Array.isArray(parsed) && parsed.length > 0) {
			return parsed.map(String).filter((s: string) => s.length > 10);
		}
	} catch {
		// parse failed
	}

	return [];
}

/* ── Query Generation ────────────────────────────────────────────── */

/**
 * Generate initial search queries for a research question.
 * When sub-questions are available, generates queries per sub-question
 * for better depth and diversity.
 */
export async function generateQueries(
	question: string,
	count: number,
	cwd: string,
	signal?: AbortSignal,
	subQuestions?: string[],
): Promise<SearchQuery[]> {
	// If we have sub-questions, generate queries distributed across them
	if (subQuestions && subQuestions.length > 0) {
		const queriesPerSub = Math.max(1, Math.ceil(count / subQuestions.length));
		const allQueries: SearchQuery[] = [];

		for (const subQ of subQuestions) {
			if (allQueries.length >= count) break;

			const taskPrompt = `Research question: ${question}\nSub-question: ${subQ}\n\nGenerate ${queriesPerSub} search query(ies) to answer this sub-question specifically.`;

			const result = await runAnalysisAgent(
				GENERATE_QUERIES_SYSTEM,
				taskPrompt,
				cwd,
				60_000,
				undefined,
				signal,
			);

			if (!result.success || !result.text) continue;

			try {
				const parsed = JSON.parse(result.text);
				if (Array.isArray(parsed)) {
					const queries = parsed
						.slice(0, queriesPerSub)
						.map((q: Record<string, unknown>) => ({
							query: String(q.query ?? ""),
							rationale: String(q.rationale ?? ""),
							angle: String(q.angle ?? "technical"),
						}))
						.filter((q: { query: string }) => q.query.length > 0);
					allQueries.push(...queries);
				}
			} catch {
				// parse failed for this sub-question, continue
			}
		}

		if (allQueries.length > 0) {
			return allQueries.slice(0, count);
		}
	}

	// Fall through to standard query generation
	const taskPrompt = `Research question: ${question}

Generate ${count} diverse search queries to research this topic effectively. Cover different angles.`;

	const result = await runAnalysisAgent(
		GENERATE_QUERIES_SYSTEM,
		taskPrompt,
		cwd,
		60_000,
		undefined,
		signal,
	);

	if (!result.success || !result.text) {
		return generateFallbackQueries(question, count);
	}

	try {
		const parsed = JSON.parse(result.text);
		if (Array.isArray(parsed) && parsed.length > 0) {
			return parsed
				.slice(0, count)
				.map((q: Record<string, unknown>) => ({
					query: String(q.query ?? ""),
					rationale: String(q.rationale ?? ""),
					angle: String(q.angle ?? "technical"),
				}))
				.filter((q: { query: string }) => q.query.length > 0);
		}
	} catch {
		// JSON parse failed, fall back
	}

	return generateFallbackQueries(question, count);
}

/* ── Follow-up Query Generation ──────────────────────────────────── */

/**
 * Generate follow-up queries based on findings from previous rounds.
 */
export async function generateFollowUpQueries(
	question: string,
	rounds: ResearchRound[],
	count: number,
	cwd: string,
	signal?: AbortSignal,
): Promise<SearchQuery[]> {
	// Build a summary of findings so far
	const allFindings = rounds.flatMap((r) => r.findings);
	const findingsSummary = allFindings
		.map((f) => {
			const corr =
				f.corroborationScore !== undefined
					? ` [corroboration: ${(f.corroborationScore * 100).toFixed(0)}%]`
					: "";
			return `- ${f.title}: ${f.summary} (confidence: ${f.confidence}${corr})`;
		})
		.join("\n");

	const exploredAngles = rounds
		.flatMap((r) => r.queries)
		.map((q) => `[${q.angle}] ${q.query} — ${q.rationale}`)
		.join("\n");

	// Find low-corroboration or low-confidence topics
	const gaps = allFindings
		.filter((f) => f.confidence === "low" || (f.corroborationScore ?? 1) < 0.5)
		.map((f) => `Gap: ${f.title} — ${f.summary}`)
		.join("\n");

	const taskPrompt = `Research question: ${question}

Queries already explored:
${exploredAngles}

Findings so far:
${findingsSummary}

${gaps ? `Remaining knowledge gaps:\n${gaps}` : ""}

Generate ${count} follow-up search queries to fill remaining gaps and deepen the research.`;

	const result = await runAnalysisAgent(
		FOLLOWUP_SYSTEM,
		taskPrompt,
		cwd,
		60_000,
		undefined,
		signal,
	);

	if (!result.success || !result.text) {
		return [];
	}

	try {
		const parsed = JSON.parse(result.text);
		if (Array.isArray(parsed) && parsed.length > 0) {
			return parsed
				.slice(0, count)
				.map((q: Record<string, unknown>) => ({
					query: String(q.query ?? ""),
					rationale: String(q.rationale ?? ""),
					angle: String(q.angle ?? "technical"),
				}))
				.filter((q: { query: string }) => q.query.length > 0);
		}
	} catch {
		// parse failed
	}

	return [];
}

/* ── Fallback Query Generation ────────────────────────────────────── */

/**
 * Fallback query generation when the LLM call fails.
 */
function generateFallbackQueries(
	question: string,
	count: number,
): SearchQuery[] {
	const queries: SearchQuery[] = [];
	const angles = [
		{ angle: "technical", desc: "technical details and specifications" },
		{
			angle: "practical",
			desc: "practical examples, tutorials, and best practices",
		},
		{ angle: "comparative", desc: "comparisons with alternatives" },
		{ angle: "critical", desc: "limitations, challenges, and criticisms" },
		{ angle: "forward-looking", desc: "future trends and developments" },
	];

	for (let i = 0; i < Math.min(count, angles.length); i++) {
		queries.push({
			query: `${question} ${angles[i].desc}`,
			rationale: `Exploring ${angles[i].desc} related to the research question`,
			angle: angles[i].angle as SearchQuery["angle"],
		});
	}

	return queries;
}

/* ── Analysis ────────────────────────────────────────────────────── */

const ANALYZE_SYSTEM = `You are a research analyst. Given search results for a specific query, extract key findings.

For each finding:
- Give it a concise title
- Summarize what was found in 1-3 sentences
- List which source URLs support this finding
- Include 1-2 key quotes from the sources
- Rate your confidence (high/medium/low) based on source authority and consistency

Output ONLY a JSON array of objects with fields:
- "title": concise finding title
- "summary": 1-3 sentence summary
- "sources": array of source URLs
- "keyQuotes": array of 1-2 key quotes
- "confidence": "high" | "medium" | "low"`;

/**
 * Analyze search results for a specific query and extract findings.
 */
export async function analyzeResults(
	query: string,
	results: EnrichedSearchResult[],
	cwd: string,
	signal?: AbortSignal,
): Promise<Finding[]> {
	// Include authority metadata in the prompt so the LLM can consider source quality
	const resultsText = results
		.map(
			(r, i) =>
				`--- Result ${i + 1} ---\nTitle: ${r.title}\nURL: ${r.url}\nDomain: ${r.domain}\nAuthority Score: ${(r.authorityScore * 100).toFixed(0)}%\nContent Type: ${r.contentType}\nDescription: ${r.description}\nContent:\n${r.markdown.slice(0, 3000)}`,
		)
		.join("\n\n");

	const taskPrompt = `Search query: "${query}"

Search results:
${resultsText}

Extract key findings from these results. Consider source authority when rating confidence.`;

	const result = await runAnalysisAgent(
		ANALYZE_SYSTEM,
		taskPrompt,
		cwd,
		90_000,
		undefined,
		signal,
	);

	if (!result.success || !result.text) return [];

	try {
		const parsed = JSON.parse(result.text);
		if (Array.isArray(parsed)) {
			return parsed
				.map((f: Record<string, unknown>) => ({
					title: String(f.title ?? ""),
					summary: String(f.summary ?? ""),
					sources: Array.isArray(f.sources) ? f.sources.map(String) : [],
					keyQuotes: Array.isArray(f.keyQuotes) ? f.keyQuotes.map(String) : [],
					confidence: (["high", "medium", "low"].includes(String(f.confidence))
						? String(f.confidence)
						: "medium") as Finding["confidence"],
				}))
				.filter(
					(f: { title: string; summary: string }) => f.title && f.summary,
				);
		}
	} catch {
		// parse failed
	}

	return [];
}

/* ── Corroboration Tracking ──────────────────────────────────────── */

/**
 * Cross-reference all findings to compute corroboration scores.
 *
 * For each finding, we check:
 * 1. How many other findings reference the same or similar source URLs
 * 2. The authority scores of the supporting sources
 * 3. Whether independent domains support the same claim
 *
 * Returns the findings with added corroborationScore, bestSourceAuthority,
 * and avgSourceAuthority.
 */
export function computeCorroboration(findings: Finding[]): Finding[] {
	if (findings.length === 0) return [];

	// Collect all unique source URLs and their authority scores
	// In a real implementation, we'd map URLs to EnrichedSearchResult authority scores
	// For now, extract domain-level patterns

	// Build a map of domain -> authority scores from source URLs
	const domainAuthority = new Map<string, number>();
	for (const finding of findings) {
		for (const url of finding.sources) {
			try {
				const domain = extractDomainSimple(url);
				if (!domainAuthority.has(domain)) {
					domainAuthority.set(domain, heuristicDomainScore(domain));
				}
			} catch {
				// skip invalid URLs
			}
		}
	}

	return findings.map((finding) => {
		if (finding.sources.length === 0) {
			return {
				...finding,
				corroborationScore: 0,
				bestSourceAuthority: 0,
				avgSourceAuthority: 0,
			};
		}

		// Compute source authority stats
		const authorities: number[] = finding.sources.map((url) => {
			try {
				const domain = extractDomainSimple(url);
				return domainAuthority.get(domain) ?? 0.3;
			} catch {
				return 0.3;
			}
		});

		const bestAuthority = Math.max(...authorities);
		const avgAuthority =
			authorities.reduce((a, b) => a + b, 0) / authorities.length;

		// Compute corroboration: how many other findings share source URLs
		let corroboratingFindings = 0;
		const mySources = new Set(finding.sources);

		for (const other of findings) {
			if (other === finding) continue;
			const overlap = other.sources.some((url) => mySources.has(url));
			if (overlap) corroboratingFindings++;
		}

		// Normalize corroboration: 0-1 based on what fraction of other findings agree
		const maxCorroboration = findings.length - 1;
		const corroborationScore =
			maxCorroboration > 0
				? Math.min(1, corroboratingFindings / maxCorroboration)
				: 0;

		return {
			...finding,
			corroborationScore: Math.round(corroborationScore * 100) / 100,
			bestSourceAuthority: Math.round(bestAuthority * 100) / 100,
			avgSourceAuthority: Math.round(avgAuthority * 100) / 100,
		};
	});
}

/**
 * Simple domain extraction (avoids URL constructor for compatibility).
 */
function extractDomainSimple(url: string): string {
	const match = url.match(/https?:\/\/([^/]+)/);
	if (!match) return url;
	const hostname = match[1].toLowerCase();
	const parts = hostname.split(".");
	const multiPartTlds =
		/\.(co\.uk|org\.uk|ac\.uk|gov\.uk|com\.au|co\.jp|co\.kr|com\.br)$/;
	if (multiPartTlds.test(hostname) && parts.length >= 3) {
		return parts.slice(-3).join(".");
	}
	return parts.slice(-2).join(".");
}

/**
 * Very basic domain score heuristic without the full domain list.
 */
function heuristicDomainScore(domain: string): number {
	if (/\.gov$|\.edu$/.test(domain)) return 0.85;
	if (/arxiv|scholar|pubmed|ieee|acm|springer|nature|science/.test(domain))
		return 0.9;
	if (/github|gitlab|bitbucket/.test(domain)) return 0.75;
	if (/wikipedia|stackoverflow|medium|dev\.to/.test(domain)) return 0.55;
	if (/docs\.|learn\.|developer\./.test(domain)) return 0.8;
	if (/reuters|apnews|bbc|nytimes|bloomberg/.test(domain)) return 0.75;
	if (/blog|forum|reddit/.test(domain)) return 0.3;
	return 0.4;
}
