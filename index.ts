/**
 * deep-research — Multi-round deep web research powered by Firecrawl
 *
 * Registers:
 *   - `deep_research` tool — callable by the LLM to conduct deep research
 *   - `/deep-research` command — interactive session invocation
 *
 * Architecture:
 *   Each research round generates queries, searches in parallel via
 *   Firecrawl, analyzes results with agent sessions, then generates
 *   follow-up queries. A final synthesis step produces the report.
 *
 * Patterns borrowed from:
 *   - firecrawl.ts extension (direct Firecrawl HTTP calls)
 *   - ralpi executor (agent sessions, widget updates, progress UX)
 *   - subagent extension (structured tool rendering)
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { runDeepResearch, type ResearchProgress } from "./src/research";
import { isFirecrawlReachable } from "./src/firecrawl";
import type { ResearchConfig, ResearchReport } from "./src/types";

/* ── Constants ────────────────────────────────────────────────────── */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PHASE_ICONS: Record<string, string> = {
	generating_queries: "🔍",
	searching: "🌐",
	analyzing: "📊",
	synthesizing: "📝",
	complete: "✅",
};

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 3) + "...";
}

/* ── Tool Definition ──────────────────────────────────────────────── */

const DeepResearchParams = Type.Object({
	question: Type.String({
		description: "The research question to investigate",
	}),
	depth: Type.Optional(
		Type.Integer({
			description:
				"Number of research rounds (1-3). Each round uses findings from the previous to generate deeper follow-up queries. Default: 2",
			minimum: 1,
			maximum: 3,
			default: 2,
		}),
	),
	breadth: Type.Optional(
		Type.Integer({
			description:
				"Number of search queries per round (1-5). More queries = broader coverage. Default: 3",
			minimum: 1,
			maximum: 5,
			default: 3,
		}),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("structured")], {
			description:
				'Output format for the research report. "markdown" for prose, "structured" for detailed sections. Default: "markdown"',
			default: "markdown",
		}),
	),
	details: Type.Optional(
		Type.Object({
			showRoundDetails: Type.Optional(
				Type.Boolean({
					description:
						"Include per-round search details in the output. Default: false",
				}),
			),
		}),
	),
});

interface ResearchDetails {
	rounds: Array<{
		round: number;
		queries: string[];
		findingsCount: number;
		resultsCount: number;
	}>;
	totalSearches: number;
	totalPagesScraped: number;
	durationMs: number;
}

/* ── Extension Entry ───────────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "deep_research",
		label: "Deep Research",
		description: [
			"Conduct multi-round deep web research on any topic using Firecrawl.",
			"Generates diverse search queries, searches the web in parallel, analyzes results, and produces a comprehensive report.",
			"Supports iterative refinement: each round builds on findings from the previous one.",
			"Parameters: question (required), depth (1-3, default 2), breadth (1-5, default 3), format (markdown|structured).",
		].join(" "),
		promptSnippet:
			"deep_research — multi-round deep web research via Firecrawl with iterative query refinement",
		promptGuidelines: [
			"Use deep_research for complex, multi-faceted questions that benefit from multiple search angles and iterative refinement.",
			"The tool handles query generation, web search, result analysis, and report synthesis automatically.",
			"For simple fact-finding questions, use firecrawl_search directly instead.",
		],
		parameters: DeepResearchParams,

		async execute(
			_toolCallId: string,
			params: {
				question: string;
				depth?: number;
				breadth?: number;
				format?: "markdown" | "structured";
				details?: { showRoundDetails?: boolean };
			},
			signal: AbortSignal | undefined,
			onUpdate: ((partial: any) => void) | undefined,
			ctx: any,
		) {
			const config: ResearchConfig = {
				question: params.question,
				depth: params.depth ?? 2,
				breadth: params.breadth ?? 3,
				format: params.format ?? "markdown",
			};

			// Use provided signals
			const abortSignal = signal;

			// Wire progress updates to both the widget and onUpdate
			let spinnerIdx = 0;
			const spinnerTimer = setInterval(() => {
				spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
			}, 100);

			let researchResult: ResearchReport | null = null;
			let lastError: string | null = null;

			const onProgress: ResearchProgress = (update) => {
				const icon = PHASE_ICONS[update.phase] ?? "";
				const spinner = SPINNER_FRAMES[spinnerIdx];
				const roundInfo =
					update.round && update.totalRounds
						? ` Round ${update.round}/${update.totalRounds}`
						: "";

				// Update widget
				const lines: string[] = [
					`${spinner} ${icon} ${truncate(update.message, 80)}${roundInfo}`,
				];
				if (update.detail) {
					lines.push(`  ${truncate(update.detail, 76)}`);
				}
				if (update.fraction !== undefined) {
					const barLen = 15;
					const filled = Math.round(barLen * update.fraction);
					const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
					lines.push(`  ${bar}`);
				}
				ctx.ui.setWidget("deep-research", lines);

				// Stream partial results via onUpdate
				if (onUpdate) {
					const partialText = lines.join("\n");
					onUpdate({
						content: [{ type: "text", text: partialText }],
						details: {
							phase: update.phase,
							round: update.round,
							message: update.message,
							fraction: update.fraction,
						},
					});
				}
			};

			try {
				// Initial status
				ctx.ui.setStatus(
					"deep-research",
					`🌐 Researching: ${truncate(config.question, 40)}`,
				);

				onProgress({
					phase: "generating_queries",
					message: "Starting deep research...",
					fraction: 0,
				});

				researchResult = await runDeepResearch(
					config,
					ctx,
					onProgress,
					abortSignal,
				);

				// ── Build the tool result ──────────────────────────────────

				const details: ResearchDetails = {
					rounds: researchResult.rounds.map((r) => ({
						round: r.round,
						queries: r.queries.map((q) => q.query),
						findingsCount: r.findings.length,
						resultsCount: r.results.length,
					})),
					totalSearches: researchResult.totalSearches,
					totalPagesScraped: researchResult.totalPagesScraped,
					durationMs: researchResult.durationMs,
				};

				const showRoundDetails = params.details?.showRoundDetails ?? false;

				let output = researchResult.finalReport;
				if (showRoundDetails) {
					output += `\n\n---\n\n## Research Methodology\n\n`;
					for (const round of researchResult.rounds) {
						output += `### Round ${round.round}\n\n`;
						output += `**Queries:**\n`;
						for (const q of round.queries) {
							output += `- "${q.query}" (${q.angle}) — ${q.rationale}\n`;
						}
						output += `\n**Results scraped:** ${round.results.length}\n`;
						output += `**Findings extracted:** ${round.findings.length}\n\n`;
					}
					output += `**Total searches:** ${researchResult.totalSearches}\n`;
					output += `**Total pages scraped:** ${researchResult.totalPagesScraped}\n`;
					output += `**Duration:** ${formatDuration(researchResult.durationMs)}\n`;
				}

				// Clean up widget
				clearInterval(spinnerTimer);
				ctx.ui.setWidget("deep-research", undefined);
				ctx.ui.setStatus("deep-research", undefined);

				return {
					content: [{ type: "text", text: output }],
					details,
				};
			} catch (error) {
				clearInterval(spinnerTimer);
				ctx.ui.setWidget("deep-research", undefined);
				ctx.ui.setStatus("deep-research", undefined);

				lastError = error instanceof Error ? error.message : String(error);

				return {
					content: [
						{
							type: "text",
							text: `Research failed: ${lastError}`,
						},
					],
					details: {
						error: lastError,
						phase: researchResult
							? `completed ${researchResult.rounds.length} rounds`
							: "preparation",
					},
					isError: true,
				};
			}
		},

		// ── TUI: Render the tool call (collapsed view) ──────────────────

		renderCall(
			args: {
				question: string;
				depth?: number;
				breadth?: number;
				format?: string;
			},
			theme: any,
			_context: any,
		) {
			const question = truncate(args.question ?? "?", 70);
			const depth = args.depth ?? 2;
			const breadth = args.breadth ?? 3;
			const format = args.format ?? "markdown";

			const text =
				theme.fg("toolTitle", theme.bold("deep_research ")) +
				theme.fg("accent", `"${question}"`) +
				theme.fg("muted", ` [depth:${depth} breadth:${breadth} ${format}]`);
			return new Text(text, 0, 0);
		},

		// ── TUI: Render the tool result (expanded/collapsed) ─────────────

		renderResult(
			result: any,
			{ expanded }: { expanded: boolean },
			theme: any,
			_context: any,
		) {
			const details = result.details as ResearchDetails | undefined;

			if (!details) {
				const text = result.content?.[0]?.text ?? "(no output)";
				return new Text(text, 0, 0);
			}

			const container = new Box();

			// ── Collapsed view ────────────────────────────────────────────

			if (!expanded) {
				const totalRounds = details.rounds.length;
				const totalFindings = details.rounds.reduce(
					(s, r) => s + r.findingsCount,
					0,
				);
				const duration = formatDuration(details.durationMs);

				let text = "";
				text +=
					theme.fg("success", "✓ ") +
					theme.fg("toolTitle", theme.bold("deep research"));
				text += theme.fg(
					"muted",
					` — ${totalRounds} rounds, ${totalFindings} findings`,
				);
				text += theme.fg("dim", ` (${duration})`);
				text += "\n";

				for (const round of details.rounds) {
					const icon =
						round.findingsCount > 0
							? theme.fg("success", "✓")
							: theme.fg("muted", "·");
					text += `  ${icon} ${theme.fg("accent", `Round ${round.round}:`)} `;
					text += theme.fg(
						"dim",
						`${round.queries.length} queries, ${round.resultsCount} pages, ${round.findingsCount} findings`,
					);
					text += "\n";
				}

				text += theme.fg("muted", "(Ctrl+O to expand)");
				container.addChild(new Text(text, 0, 0));
				return container;
			}

			// ── Expanded view ─────────────────────────────────────────────

			const headerText =
				theme.fg("toolTitle", theme.bold("Deep Research Results")) +
				"\n" +
				theme.fg("dim", `Duration: ${formatDuration(details.durationMs)} | `) +
				theme.fg("dim", `Searches: ${details.totalSearches} | `) +
				theme.fg("dim", `Pages scraped: ${details.totalPagesScraped}`);
			container.addChild(new Text(headerText, 0, 0));

			for (const round of details.rounds) {
				container.addChild(new Text("", 0, 0)); // Spacer
				const roundHeader = `Round ${round.round}`;
				container.addChild(
					new Text(theme.fg("toolTitle", theme.bold(roundHeader)), 0, 0),
				);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${round.queries.length} queries → ${round.resultsCount} pages → ${round.findingsCount} findings`,
						),
						0,
						0,
					),
				);
				for (const q of round.queries) {
					container.addChild(
						new Text(
							theme.fg("muted", "  · ") + theme.fg("accent", truncate(q, 70)),
							0,
							0,
						),
					);
				}
			}

			return container;
		},
	});

	// ── Command ───────────────────────────────────────────────────────

	pi.registerCommand("deep-research", {
		description:
			"Conduct multi-round deep web research on any topic via Firecrawl. Usage: /deep-research <question>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!args || args.trim().length === 0) {
				ctx.ui.notify(
					"Usage: /deep-research <your research question>",
					"error",
				);
				return;
			}

			// Ask about depth/breadth
			const depthStr = await ctx.ui.select("Research depth?", [
				"1 round (quick survey)",
				"2 rounds (standard)",
				"3 rounds (deep dive)",
			]);
			const depth = depthStr?.startsWith("1")
				? 1
				: depthStr?.startsWith("3")
					? 3
					: 2;

			const breadthStr = await ctx.ui.select("Research breadth?", [
				"1 query/round (narrow)",
				"3 queries/round (balanced)",
				"5 queries/round (broad)",
			]);
			const breadth = breadthStr?.startsWith("1")
				? 1
				: breadthStr?.startsWith("5")
					? 5
					: 3;

			// Create a promise-based interaction
			ctx.ui.setStatus(
				"deep-research",
				`🌐 Researching: ${truncate(args, 40)}`,
			);

			const config: ResearchConfig = {
				question: args,
				depth,
				breadth,
				format: "markdown",
			};

			let spinnerIdx = 0;
			const spinnerTimer = setInterval(() => {
				spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
			}, 100);

			try {
				const onProgress: ResearchProgress = (update) => {
					const icon = PHASE_ICONS[update.phase] ?? "";
					const spinner = SPINNER_FRAMES[spinnerIdx];
					const lines: string[] = [
						`${spinner} ${icon} ${truncate(update.message, 80)}`,
					];
					if (update.detail) {
						lines.push(`  ${truncate(update.detail, 76)}`);
					}
					if (update.fraction !== undefined) {
						const barLen = 15;
						const filled = Math.round(barLen * update.fraction);
						const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
						lines.push(`  ${bar}`);
					}
					ctx.ui.setWidget("deep-research", lines);
				};

				const report = await runDeepResearch(config, ctx, onProgress);

				clearInterval(spinnerTimer);
				ctx.ui.setWidget("deep-research", undefined);
				ctx.ui.setStatus("deep-research", undefined);

				// Show notification
				ctx.ui.notify(
					`Research complete: ${report.rounds.length} rounds, ${report.totalSearches} searches, ${report.totalPagesScraped} pages in ${formatDuration(report.durationMs)}`,
					"info",
				);

				// Send the report as a user message
				pi.sendUserMessage(
					`## Deep Research: ${args}\n\n${report.finalReport}\n\n---\n*${report.rounds.length} rounds · ${report.totalSearches} searches · ${report.totalPagesScraped} pages · ${formatDuration(report.durationMs)}*`,
				);
			} catch (error) {
				clearInterval(spinnerTimer);
				ctx.ui.setWidget("deep-research", undefined);
				ctx.ui.setStatus("deep-research", undefined);
				ctx.ui.notify(
					`Research failed: error instanceof Error ? error.message : String(error)`,
					"error",
				);
			}
		},
	});

	// ── Startup check ─────────────────────────────────────────────────

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		const reachable = await isFirecrawlReachable();
		if (!reachable) {
			ctx.ui.notify(
				"Deep Research: Firecrawl endpoint unreachable — searches will fail. Check FIRECRAWL_BASE_URL in settings.json or env.",
				"warning",
			);
		}
	});
}
