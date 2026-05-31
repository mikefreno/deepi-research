/**
 * Deep Research — Search query generation & refinement
 *
 * Uses an LLM agent to generate search queries from different research
 * angles, then analyzes results to produce follow-up queries.
 */
import type { SearchQuery, Finding, ResearchRound } from "./types";
import { runAnalysisAgent } from "./agent";

const GENERATE_QUERIES_SYSTEM = `You are a research methodology expert. Your role is to generate effective web search queries that will yield high-quality, diverse information about a research topic.

Guidelines:
- Create queries from DIFFERENT angles (technical, practical, comparative, critical, forward-looking)
- Each query should target a specific facet of the question
- Queries should use keywords that search engines rank well (avoid overly long questions)
- Cover contrasting viewpoints and alternative approaches
- Include queries for finding authoritative sources (docs, papers, official sites)
- Prioritize recent information where relevant

Output ONLY a JSON array of objects with fields:
- "query": the search query string
- "rationale": why this query will help answer the research question
- "angle": one of "technical" | "practical" | "comparative" | "critical" | "forward-looking" | "authoritative"

Example:
[
  {"query": "Rust async/await performance benchmarks 2024", "rationale": "Understanding current performance characteristics", "angle": "technical"},
  {"query": "Rust vs Go concurrency patterns comparison", "rationale": "Comparative analysis helps contextualize trade-offs", "angle": "comparative"}
]
`;

const FOLLOWUP_SYSTEM = `You are a research analyst. Given the research question and findings so far, your job is to identify what's still unknown and generate follow-up search queries to fill those gaps.

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
- "angle": one of "technical" | "practical" | "comparative" | "critical" | "forward-looking" | "authoritative"
`;

/**
 * Generate initial search queries for a research question.
 */
export async function generateQueries(
	question: string,
	count: number,
	cwd: string,
	signal?: AbortSignal,
): Promise<SearchQuery[]> {
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
				.filter((q) => q.query.length > 0);
		}
	} catch {
		// JSON parse failed, fall back
	}

	return generateFallbackQueries(question, count);
}

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
		.map((f) => `- ${f.title}: ${f.summary} (confidence: ${f.confidence})`)
		.join("\n");

	const exploredAngles = rounds
		.flatMap((r) => r.queries)
		.map((q) => `[${q.angle}] ${q.query} — ${q.rationale}`)
		.join("\n");

	const taskPrompt = `Research question: ${question}

Queries already explored:
${exploredAngles}

Findings so far:
${findingsSummary}

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
				.filter((q) => q.query.length > 0);
		}
	} catch {
		// parse failed
	}

	return [];
}

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
	results: {
		title: string;
		url: string;
		description: string;
		markdown: string;
	}[],
	cwd: string,
	signal?: AbortSignal,
): Promise<Finding[]> {
	const resultsText = results
		.map(
			(r, i) =>
				`--- Result ${i + 1} ---\nTitle: ${r.title}\nURL: ${r.url}\nDescription: ${r.description}\nContent:\n${r.markdown.slice(0, 3000)}`,
		)
		.join("\n\n");

	const taskPrompt = `Search query: "${query}"

Search results:
${resultsText}

Extract key findings from these results.`;

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
				.filter((f) => f.title && f.summary);
		}
	} catch {
		// parse failed
	}

	return [];
}
