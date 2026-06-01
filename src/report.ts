/**
 * Deep Research — Report synthesis
 *
 * Takes all research rounds and synthesizes a comprehensive report
 * using an LLM agent. Produces:
 *  - Numbered inline citations with a bibliography
 *  - Layered report: TL;DR → Executive Summary → Key Findings
 *    → Detailed Analysis → Limitations/Gaps → References
 *  - Audience-aware tone adjustment
 */
import type {
	ResearchRound,
	ResearchConfig,
	Reference,
	Finding,
} from "./types";
import { runAnalysisAgent } from "./agent";

/** Return shape from synthesizeReport */
export interface SynthesisResult {
	report: string;
	references: Reference[];
}

/* ── System Prompts ──────────────────────────────────────────────── */

function buildSynthesisSystem(audience: string): string {
	const audienceGuidance: Record<string, string> = {
		expert:
			"Assume expert-level domain knowledge. Use precise technical terminology, reference specific methodologies and standards, and prioritize depth over hand-holding. The reader understands the field.",
		general:
			"Write for an informed general audience. Define technical terms on first use, explain context, and keep the tone accessible but not simplistic. Avoid jargon without explanation.",
		executive:
			"Write for a busy executive or decision-maker. Lead with actionable conclusions and recommendations. Be concise — use bold for key takeaways. Minimize technical detail; focus on implications, trade-offs, and decisions. Target 2-3 pages.",
	};

	const guidance = audienceGuidance[audience] ?? audienceGuidance.general;

	return `You are a senior research analyst synthesizing findings from multiple web searches into a comprehensive, well-structured report.

Audience: ${guidance}

Report structure (use ## headings):
1. **TL;DR** — One paragraph (2-3 sentences) giving the single most important answer
2. **Executive Summary** — 2-3 paragraphs covering what was found, how confident we are, and key implications
3. **Key Findings** — Tiered by importance/confidence. Bullet points with inline citations
4. **Detailed Analysis** — Organized by theme. Each section covers one aspect with evidence
5. **Limitations & Knowledge Gaps** — What evidence is weak, missing, or contradictory
6. **Conclusion** — Wrap up with actionable takeaways

Citation rules:
- Use numbered references like [1], [2] etc. throughout the text
- At the end, include a ## References section listing each citation
- Format references as: [1] Title — Domain (URL)
- Cite specific evidence, not vague associations
- When multiple sources support a claim, cite all of them: [1][3][5]

Style guidelines:
- Write in an objective, authoritative tone
- Use bullet points for listing evidence
- Note the confidence level for key claims
- Be thorough but concise — every paragraph should add value
- Use > for notable direct quotes with citations`;
}

/* ── Evidence Builder ────────────────────────────────────────────── */

function buildEvidenceText(
	question: string,
	rounds: ResearchRound[],
): { evidenceText: string; referenceMap: Map<string, Reference> } {
	const allFindings = rounds.flatMap((r) => r.findings);
	const totalSearches = rounds.reduce((sum, r) => sum + r.queries.length, 0);
	const totalPages = rounds.reduce((sum, r) => sum + r.results.length, 0);

	// Build a bibliography map (url -> Reference)
	const seenUrls = new Map<string, Reference>();
	let refId = 0;

	for (const round of rounds) {
		for (const result of round.results) {
			if (!seenUrls.has(result.url)) {
				refId++;
				seenUrls.set(result.url, {
					id: refId,
					url: result.url,
					title: result.title,
					domain: result.domain,
					authorityScore: result.authorityScore,
					accessedAt: new Date().toISOString().split("T")[0],
				});
			}
		}
	}

	// Organize findings by thematic angle
	const evidenceByAngle = new Map<string, Finding[]>();
	for (const round of rounds) {
		for (const finding of round.findings) {
			const angle = round.queries[0]?.angle ?? "technical";
			if (!evidenceByAngle.has(angle)) evidenceByAngle.set(angle, []);
			evidenceByAngle.get(angle)!.push(finding);
		}
	}

	let evidenceText = `## Research Question\n${question}\n\n`;
	evidenceText += `## Overview\n- Rounds of research: ${rounds.length}\n`;
	evidenceText += `- Total searches executed: ${totalSearches}\n`;
	evidenceText += `- Total pages analyzed: ${totalPages}\n`;
	evidenceText += `- Key findings extracted: ${allFindings.length}\n\n`;

	// Build evidence grouped by angle with reference IDs
	for (const [angle, findings] of Array.from(evidenceByAngle)) {
		if (findings.length === 0) continue;
		evidenceText += `## Angle: ${angle}\n\n`;
		for (const finding of findings) {
			// Get reference IDs for this finding's sources
			const refs = finding.sources
				.map((url) => seenUrls.get(url))
				.filter((r): r is Reference => !!r)
				.map((r) => `[${r.id}]`);

			const avgAuth =
				finding.avgSourceAuthority !== undefined
					? ` | Avg Authority: ${(finding.avgSourceAuthority * 100).toFixed(0)}%`
					: "";
			const corr =
				finding.corroborationScore !== undefined
					? ` | Corroboration: ${(finding.corroborationScore * 100).toFixed(0)}%`
					: "";
			const bestAuthStr =
				finding.bestSourceAuthority !== undefined
					? ` | Best Source: ${(finding.bestSourceAuthority * 100).toFixed(0)}%`
					: "";

			evidenceText += `### ${finding.title}\n`;
			evidenceText += `**Confidence:** ${finding.confidence}${avgAuth}${corr}${bestAuthStr}\n`;
			if (refs.length > 0) {
				evidenceText += `**Sources:** ${refs.join(", ")}\n`;
			}
			evidenceText += `${finding.summary}\n\n`;
			if (finding.keyQuotes.length > 0) {
				evidenceText += `> ${finding.keyQuotes[0]}\n\n`;
			}
		}
	}

	// Include reference metadata for the LLM to build proper citations
	evidenceText += `## Reference Metadata\n\n`;
	for (const [, ref] of seenUrls) {
		evidenceText += `[${ref.id}] ${ref.title} (${ref.domain}, authority: ${(ref.authorityScore * 100).toFixed(0)}%) — ${ref.url}\n`;
	}

	return { evidenceText, referenceMap: seenUrls };
}

/* ── Main Synthesis ──────────────────────────────────────────────── */

/**
 * Synthesize a research report from all rounds.
 * Returns both the formatted report and the full bibliography.
 */
export async function synthesizeReport(
	question: string,
	rounds: ResearchRound[],
	config: ResearchConfig,
	cwd: string,
	signal?: AbortSignal,
): Promise<SynthesisResult> {
	const audience = config.audience ?? "general";
	const { evidenceText, referenceMap } = buildEvidenceText(question, rounds);

	const formatInstruction =
		config.format === "structured"
			? "Structured report with numbered sections, clear hierarchies, and data tables where appropriate."
			: "Well-formatted markdown report with ## headings, bullet points, and inline numbered citations like [1].";

	const taskPrompt = `Synthesize the following research findings into a comprehensive, well-structured report.

${evidenceText}

Write a thorough report that answers the original question: "${question}"

Format: ${formatInstruction}
Audience: ${audience}

Remember to use numbered citations like [1], [2] and include a ## References section at the end.`;

	const result = await runAnalysisAgent(
		buildSynthesisSystem(audience),
		taskPrompt,
		cwd,
		120_000,
		undefined,
		signal,
	);

	if (result.success && result.text) {
		// Build bibliography section
		const bibSection = buildBibliography(referenceMap);

		// Append references if not already present
		let report = result.text;
		if (!report.includes("## References") && !report.includes("# References")) {
			report += `\n\n${bibSection}`;
		}

		return { report, references: Array.from(referenceMap.values()) };
	}

	// Fallback: generate a simple structured report
	const fallbackReport = generateFallbackReport(
		question,
		rounds,
		referenceMap,
		audience,
	);
	return {
		report: fallbackReport + `\n\n${buildBibliography(referenceMap)}`,
		references: Array.from(referenceMap.values()),
	};
}

/* ── Bibliography Builder ────────────────────────────────────────── */

/**
 * Build a structured ## References section from the reference map.
 */
function buildBibliography(referenceMap: Map<string, Reference>): string {
	if (referenceMap.size === 0) return "## References\n\nNo sources cited.";

	const refs = Array.from(referenceMap.values()).sort((a, b) => a.id - b.id);
	const lines: string[] = ["## References\n"];
	for (const ref of refs) {
		const authIcon =
			ref.authorityScore >= 0.8 ? "⭐" : ref.authorityScore >= 0.5 ? "✓" : "○";
		lines.push(
			`[${ref.id}] ${authIcon} **${ref.title}** — ${ref.domain} (${ref.url}) — accessed ${ref.accessedAt}`,
		);
	}

	return lines.join("\n");
}

/* ── Fallback Report ─────────────────────────────────────────────── */

/**
 * Fallback report when the LLM synthesis fails.
 * Produces a clean, structured report from the evidence.
 */
function generateFallbackReport(
	question: string,
	rounds: ResearchRound[],
	referenceMap: Map<string, Reference>,
	_audience: string,
): string {
	const lines: string[] = [];
	const allFindings = rounds.flatMap((r) => r.findings);

	// ── TL;DR ──
	lines.push(`# Research Report: ${question}`);
	lines.push("");

	const highConfFindings = allFindings.filter((f) => f.confidence === "high");
	const totalHigh = highConfFindings.length;
	const total = allFindings.length;

	lines.push("## TL;DR");
	lines.push("");
	if (highConfFindings.length > 0) {
		lines.push(
			`Based on analysis of ${total} findings across ${rounds.length} research round(s), ` +
				`${totalHigh} high-confidence conclusions were identified. ` +
				`${highConfFindings[0].title}: ${highConfFindings[0].summary}`,
		);
	} else {
		lines.push(
			`This report covers findings from ${rounds.length} research round(s) exploring "${question}". ` +
				`${total} findings were extracted, with varying levels of confidence.`,
		);
	}
	lines.push("");

	// ── Executive Summary ──
	lines.push("## Executive Summary");
	lines.push("");
	lines.push(
		`This report synthesizes findings from ${rounds.length} research round(s), ` +
			`${rounds.reduce((s, r) => s + r.queries.length, 0)} search queries, ` +
			`and ${rounds.reduce((s, r) => s + r.results.length, 0)} sources.`,
	);
	lines.push("");

	// ── Key Findings (tiered) ──
	if (allFindings.length > 0) {
		lines.push("## Key Findings");
		lines.push("");

		// High confidence first
		const highConf = allFindings.filter((f) => f.confidence === "high");
		if (highConf.length > 0) {
			lines.push("### High Confidence");
			for (const finding of highConf) {
				const refs = finding.sources
					.map((url) => referenceMap.get(url))
					.filter((r): r is Reference => !!r)
					.map((r) => `[${r.id}]`);
				lines.push(
					`- **${finding.title}** ${refs.length > 0 ? refs.join("") : ""}`,
				);
				lines.push(`  - ${finding.summary}`);
			}
			lines.push("");
		}

		// Medium confidence
		const medConf = allFindings.filter((f) => f.confidence === "medium");
		if (medConf.length > 0) {
			lines.push("### Moderate Confidence");
			for (const finding of medConf) {
				const refs = finding.sources
					.map((url) => referenceMap.get(url))
					.filter((r): r is Reference => !!r)
					.map((r) => `[${r.id}]`);
				lines.push(
					`- **${finding.title}** ${refs.length > 0 ? refs.join("") : ""}`,
				);
				lines.push(`  - ${finding.summary}`);
			}
			lines.push("");
		}

		// Low confidence
		const lowConf = allFindings.filter((f) => f.confidence === "low");
		if (lowConf.length > 0) {
			lines.push("### Lower Confidence (Needs Further Research)");
			for (const finding of lowConf) {
				const refs = finding.sources
					.map((url) => referenceMap.get(url))
					.filter((r): r is Reference => !!r)
					.map((r) => `[${r.id}]`);
				lines.push(
					`- **${finding.title}** ${refs.length > 0 ? refs.join("") : ""}`,
				);
				lines.push(`  - ${finding.summary}`);
			}
			lines.push("");
		}

		// ── Detailed Analysis ──
		lines.push("## Detailed Analysis");
		lines.push("");

		const byAngle = new Map<string, Finding[]>();
		for (const round of rounds) {
			for (const f of round.findings) {
				const angle = round.queries[0]?.angle ?? "general";
				if (!byAngle.has(angle)) byAngle.set(angle, []);
				byAngle.get(angle)!.push(f);
			}
		}

		for (const [angle, findings] of byAngle) {
			lines.push(`### ${angle.charAt(0).toUpperCase() + angle.slice(1)}`);
			lines.push("");
			for (const f of findings) {
				const corrStr =
					f.corroborationScore !== undefined
						? ` (corroboration: ${(f.corroborationScore * 100).toFixed(0)}%)`
						: "";
				lines.push(`**${f.title}** — *${f.confidence} confidence${corrStr}*`);
				lines.push("");
				lines.push(f.summary);
				lines.push("");
				if (f.keyQuotes.length > 0) {
					lines.push(`> ${f.keyQuotes[0]}`);
					lines.push("");
				}
			}
		}

		// ── Limitations ──
		const lowConfCount = allFindings.filter(
			(f) => f.confidence === "low",
		).length;
		const noCorr = allFindings.filter(
			(f) => (f.corroborationScore ?? 0) < 0.3,
		).length;

		lines.push("## Limitations & Knowledge Gaps");
		lines.push("");
		if (lowConfCount > 0) {
			lines.push(
				`- **${lowConfCount} of ${allFindings.length} findings** have low confidence, indicating limited or conflicting evidence.`,
			);
		}
		if (noCorr > 0) {
			lines.push(
				`- **${noCorr} findings** lack corroboration from multiple independent sources.`,
			);
		}
		lines.push(
			"- This research relied on web search results; some relevant sources may not be indexed or accessible.",
		);
		lines.push(
			"- Findings are dependent on search engine ranking and the quality of indexed content.",
		);
		lines.push("");

		// ── Conclusion ──
		lines.push("## Conclusion");
		lines.push("");
		if (highConf.length > 0) {
			lines.push(
				`The research identified ${highConf.length} high-confidence finding(s) and ${medConf.length} moderately-supported finding(s). ` +
					`The strongest evidence relates to: ${highConf.map((f) => f.title).join(", ")}.`,
			);
		} else {
			lines.push(
				"The research surfaced relevant information but with limited high-confidence evidence. Further investigation is recommended for the identified knowledge gaps.",
			);
		}
		lines.push("");
	}

	// ── Methodology ──
	lines.push(`*Report prepared for: ${_audience} audience*`);
	lines.push("");

	lines.push("## Methodology");
	lines.push("");
	for (const round of rounds) {
		const failedSearches = round.queries.length - round.successfulSearches;
		lines.push(`### Round ${round.round}`);
		lines.push(
			`Queries: ${round.queries.map((q) => `"${q.query}" [${q.angle}]`).join(", ")}`,
		);
		lines.push(`Pages scraped: ${round.results.length}`);
		lines.push(`Findings extracted: ${round.findings.length}`);
		if (failedSearches > 0) {
			lines.push(`Searches failed: ${failedSearches}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
