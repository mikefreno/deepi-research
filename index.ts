/**
 * deep-research — Multi-round deep web research powered by Firecrawl
 *
 * Registers:
 *   - `deep_research` tool — callable by the LLM to conduct deep research
 *   - `/deepi-research` command — interactive session invocation
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
import {
	Box,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { runDeepResearch, type ResearchProgress } from "./src/research";
import { isFirecrawlReachable } from "./src/firecrawl";
import type { ResearchConfig, ResearchReport, Audience } from "./src/types";

/* ── Constants ────────────────────────────────────────────────────── */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PHASE_ICONS: Record<string, string> = {
	decomposing: "🧩",
	generating_queries: "🔍",
	searching: "🌐",
	analyzing: "📊",
	synthesizing: "📝",
	complete: "✅",
};

type ResearchPhase = Parameters<ResearchProgress>[0]["phase"];

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
				"Number of research rounds (1-3). Each round builds on findings from the previous for deeper analysis. Default: 2",
			minimum: 1,
			maximum: 3,
			default: 2,
		}),
	),
	breadth: Type.Optional(
		Type.Integer({
			description:
				"Number of search queries per round (1-5). More queries = broader coverage but slower. Default: 3",
			minimum: 1,
			maximum: 5,
			default: 3,
		}),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("structured")], {
			description:
				'Output format for the research report. "markdown" for prose with headings, "structured" for detailed hierarchical sections. Default: "markdown"',
			default: "markdown",
		}),
	),
	audience: Type.Optional(
		Type.Union(
			[
				Type.Literal("general"),
				Type.Literal("expert"),
				Type.Literal("executive"),
			],
			{
				description:
					"Target audience for the report. 'general' (accessible), 'expert' (technical depth), 'executive' (concise, action-oriented). Default: 'general'",
				default: "general",
			},
		),
	),
	details: Type.Optional(
		Type.Object({
			showRoundDetails: Type.Optional(
				Type.Boolean({
					description:
						"Include per-round search methodology in the output. Default: false",
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

/* ── Widget Helper ────────────────────────────────────────────────── */

/**
 * Create a widget state that drives a spinner-based progress widget.
 * Returns the state object, the timer, and cleanup function.
 */
function createProgressWidget(
	ctx: any,
	initialPhase: ResearchPhase = "generating_queries",
) {
	const state: {
		phase: ResearchPhase;
		message: string;
		detail: string | undefined;
		fraction: number;
		round: number | undefined;
		totalRounds: number | undefined;
	} = {
		phase: initialPhase,
		message: "Starting...",
		detail: undefined,
		fraction: 0,
		round: undefined,
		totalRounds: undefined,
	};

	let widgetTui: { requestRender(): void } | null = null;
	let spinnerIdx = 0;

	ctx.ui.setWidget(
		"deep-research",
		(tui: { requestRender(): void }, _theme: any) => {
			widgetTui = tui;
			return {
				render: (width: number) => {
					const spinner = SPINNER_FRAMES[spinnerIdx];
					const icon = PHASE_ICONS[state.phase] ?? "";
					const roundInfo =
						state.round && state.totalRounds
							? ` Round ${state.round}/${state.totalRounds}`
							: "";
					const firstLine = `${spinner} ${icon} ${state.message}${roundInfo}`;
					const lines: string[] = [truncateToWidth(firstLine, width)];
					if (state.detail) {
						lines.push(truncateToWidth(`  ${state.detail}`, width));
					}
					if (state.fraction > 0) {
						const barLen = Math.min(15, Math.max(3, width - 4));
						const filled = Math.round(barLen * state.fraction);
						const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
						lines.push(`  ${bar}`);
					}
					return lines;
				},
				invalidate: () => {},
			};
		},
	);

	const spinnerTimer = setInterval(() => {
		spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
		widgetTui?.requestRender();
	}, 100);

	const onProgress: ResearchProgress = (update) => {
		state.phase = update.phase;
		state.message = update.message;
		state.detail = update.detail;
		state.fraction = update.fraction ?? 0;
		state.round = update.round;
		state.totalRounds = update.totalRounds;
	};

	const cleanup = () => {
		clearInterval(spinnerTimer);
		ctx.ui.setWidget("deep-research", undefined);
	};

	return { state, onProgress, cleanup, spinnerTimer };
}

/* ── Extension Entry ───────────────────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "deep_research",
		label: "Deep Research",
		description: [
			"Conduct multi-round deep web research on any topic using Firecrawl.",
			"Generates diverse search queries, searches the web in parallel, analyzes results,",
			"and produces a comprehensive report with numbered citations and a bibliography.",
			"Supports iterative refinement and sub-question decomposition for deeper analysis.",
			"Parameters: question (required), depth, breadth, format, audience, details.",
		].join(" "),
		promptSnippet:
			"deep_research — multi-round deep web research via Firecrawl with iterative query refinement, sub-question decomposition, source authority scoring, and numbered citations",
		promptGuidelines: [
			"Use deep_research for complex, multi-faceted questions that benefit from multiple search angles and iterative refinement.",
			"The tool handles query generation, web search, result analysis, and report synthesis automatically.",
			"For simple fact-finding questions, use firecrawl_search directly instead.",
			"Set audience to 'executive' for concise, action-oriented reports; 'expert' for technical depth; 'general' (default) for accessible reports.",
		],
		parameters: DeepResearchParams,

		async execute(
			_toolCallId: string,
			params: {
				question: string;
				depth?: number;
				breadth?: number;
				format?: "markdown" | "structured";
				audience?: Audience;
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
				audience: params.audience ?? "general",
			};

			const abortSignal = signal;
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { state: _state, onProgress, cleanup } = createProgressWidget(ctx);

			let researchResult: ResearchReport | null = null;
			let lastError: string | null = null;

			try {
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

				// Stream final content via onUpdate before returning
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: researchResult.finalReport }],
						details: {
							phase: "complete",
							duration: researchResult.durationMs,
							rounds: researchResult.rounds.length,
							findings: researchResult.rounds.reduce(
								(s, r) => s + r.findings.length,
								0,
							),
							references: researchResult.references.length,
						},
					});
				}

				cleanup();
				ctx.ui.setStatus("deep-research", undefined);

				let output = researchResult.finalReport;

				// Append methodology section if requested
				if (params.details?.showRoundDetails) {
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
					output += `**Sources in bibliography:** ${researchResult.references.length}\n`;
					output += `**Duration:** ${formatDuration(researchResult.durationMs)}\n`;
				}

				return {
					content: [{ type: "text", text: output }],
					details,
				};
			} catch (error) {
				cleanup();
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
						rounds: [],
						totalSearches: 0,
						totalPagesScraped: 0,
						durationMs: 0,
						error: lastError,
					} as ResearchDetails & { error: string },
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
				audience?: string;
			},
			theme: any,
			_context: any,
		) {
			const question = truncate(args.question ?? "?", 70);
			const depth = args.depth ?? 2;
			const breadth = args.breadth ?? 3;
			const format = args.format ?? "markdown";
			const audience = args.audience ?? "general";

			const text =
				theme.fg("toolTitle", theme.bold("deep_research ")) +
				theme.fg("accent", `"${question}"`) +
				theme.fg(
					"muted",
					` [depth:${depth} breadth:${breadth} ${format} ${audience}]`,
				);
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

	pi.registerCommand("deepi-research", {
		description:
			"Conduct multi-round deep web research on any topic via Firecrawl. Usage: /deepi-research <question>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!args || args.trim().length === 0) {
				ctx.ui.notify(
					"Usage: /deepi-research <your research question>",
					"error",
				);
				return;
			}

			// Ask about depth
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

			// Ask about breadth
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

			// Ask about audience
			const audienceStr = await ctx.ui.select("Report audience?", [
				"General (accessible, explains terms)",
				"Expert (technical depth, assumes domain knowledge)",
				"Executive (concise, action-oriented)",
			]);
			const audience: Audience = audienceStr?.startsWith("Expert")
				? "expert"
				: audienceStr?.startsWith("Executive")
					? "executive"
					: "general";

			ctx.ui.setStatus(
				"deep-research",
				`🌐 Researching: ${truncate(args, 40)}`,
			);

			const config: ResearchConfig = {
				question: args,
				depth,
				breadth,
				format: "markdown",
				audience,
			};

			const { onProgress, cleanup } = createProgressWidget(ctx);

			try {
				const report = await runDeepResearch(config, ctx, onProgress);

				cleanup();
				ctx.ui.setStatus("deep-research", undefined);

				// Show notification
				ctx.ui.notify(
					`Research complete: ${report.rounds.length} rounds, ${report.totalSearches} searches, ${report.totalPagesScraped} pages, ${report.references.length} sources in ${formatDuration(report.durationMs)}`,
					"info",
				);

				// Send the report as a user message
				pi.sendUserMessage(
					`## Deep Research: ${args}\n\n${report.finalReport}\n\n---\n*${report.rounds.length} rounds · ${report.totalSearches} searches · ${report.totalPagesScraped} pages · ${report.references.length} sources · ${formatDuration(report.durationMs)}*`,
				);
			} catch (error) {
				cleanup();
				ctx.ui.setStatus("deep-research", undefined);
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Research failed: ${msg}`, "error");
			}
		},
	});

	// ── Startup check ─────────────────────────────────────────────────

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		const reachable = await isFirecrawlReachable();
		if (!reachable) {
			ctx.ui.notify(
				"Deep Research: Firecrawl endpoint unreachable — searches will fail. Set firecrawl.baseUrl in settings.json (global or project) or the FIRECRAWL_BASE_URL env var.",
				"warning",
			);
		}
	});
}
