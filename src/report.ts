/**
 * Deep Research — Report synthesis
 *
 * Takes all research rounds and synthesizes a comprehensive report
 * using an LLM agent.
 */
import type { ResearchRound, ResearchConfig } from "./types";
import { runAnalysisAgent } from "./agent";

const SYNTHESIS_SYSTEM = `You are a senior research analyst synthesizing findings from multiple web searches into a comprehensive, well-structured report.

Your report should:
1. Start with an executive summary (2-3 paragraphs covering the key answer to the research question)
2. Organize findings by theme, not by search query
3. Include specific evidence from sources (cite URLs in [brackets])
4. Note areas of disagreement or uncertainty
5. Identify knowledge gaps that remain
6. End with actionable conclusions

Style guidelines:
- Use clear section headings (## level)
- Write in an objective, authoritative tone
- Include bullet points for listing evidence
- Use inline citations like [source](url)
- Note the confidence level for key claims
- Be thorough but concise — every paragraph should add value`;

/**
 * Synthesize a research report from all rounds.
 */
export async function synthesizeReport(
	question: string,
	rounds: ResearchRound[],
	config: ResearchConfig,
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	// Build the evidence summary
	const allFindings = rounds.flatMap((r) => r.findings);
	const totalSearches = rounds.reduce((sum, r) => sum + r.queries.length, 0);
	const totalPages = rounds.reduce((sum, r) => sum + r.results.length, 0);

	const evidenceByAngle = new Map<string, ResearchRound["findings"]>();
	for (const round of rounds) {
		for (const query of round.queries) {
			const key = query.angle;
			if (!evidenceByAngle.has(key)) evidenceByAngle.set(key, []);
		}
		for (const finding of round.findings) {
			// Try to determine angle from the round's queries
			const angle = round.queries[0]?.angle ?? "technical";
			if (!evidenceByAngle.has(angle)) evidenceByAngle.set(angle, []);
			evidenceByAngle.get(angle)!.push(finding);
		}
	}

	// Build structured evidence text
	let evidenceText = `## Research Question\n${question}\n\n`;
	evidenceText += `## Overview\n- Rounds of research: ${rounds.length}\n`;
	evidenceText += `- Total searches executed: ${totalSearches}\n`;
	evidenceText += `- Total pages analyzed: ${totalPages}\n`;
	evidenceText += `- Key findings extracted: ${allFindings.length}\n\n`;

	for (const [angle, findings] of Array.from(evidenceByAngle)) {
		if (findings.length === 0) continue;
		evidenceText += `## Angle: ${angle}\n\n`;
		for (const finding of findings) {
			evidenceText += `### ${finding.title}\n`;
			evidenceText += `**Confidence:** ${finding.confidence}\n`;
			evidenceText += `${finding.summary}\n\n`;
			if (finding.keyQuotes.length > 0) {
				evidenceText += `> ${finding.keyQuotes[0]}\n\n`;
			}
			if (finding.sources.length > 0) {
				evidenceText += `Sources: ${finding.sources.map((s: string) => `[${s}](${s})`).join(", ")}\n\n`;
			}
		}
	}

	// Also include raw search context for depth
	evidenceText += `## Raw Search Context\n\n`;
	for (const round of rounds) {
		evidenceText += `### Round ${round.round}\n`;
		for (const q of round.queries) {
			evidenceText += `- **"${q.query}"** (${q.angle}) — ${q.rationale}\n`;
		}
		evidenceText += `\n`;
	}

	const taskPrompt = `Synthesize the following research findings into a comprehensive, well-structured report.

${evidenceText}

Write a thorough report that answers the original question: "${question}"

Format: ${config.format === "structured" ? "Structured report with numbered sections, clear hierarchies, and data tables where appropriate." : "Well-formatted markdown report with ## headings, bullet points, and inline citations."}`;

	const result = await runAnalysisAgent(
		SYNTHESIS_SYSTEM,
		taskPrompt,
		cwd,
		120_000,
		undefined,
		signal,
	);

	if (result.success && result.text) {
		return result.text;
	}

	// Fallback: generate a simple report from the evidence
	return generateFallbackReport(question, rounds);
}

/**
 * Fallback report when the LLM synthesis fails.
 */
function generateFallbackReport(
	question: string,
	rounds: ResearchRound[],
): string {
	const lines: string[] = [];
	lines.push(`# Research Report: ${question}`);
	lines.push("");
	lines.push("## Executive Summary");
	lines.push("");
	lines.push(
		`This report summarizes findings from ${rounds.length} research round(s) exploring the question above.`,
	);
	lines.push("");

	const allFindings = rounds.flatMap((r) => r.findings);

	if (allFindings.length > 0) {
		lines.push("## Key Findings");
		lines.push("");
		for (const finding of allFindings) {
			lines.push(`### ${finding.title}`);
			lines.push(`*Confidence: ${finding.confidence}*`);
			lines.push("");
			lines.push(finding.summary);
			lines.push("");
			if (finding.keyQuotes.length > 0) {
				lines.push(`> ${finding.keyQuotes[0]}`);
				lines.push("");
			}
			if (finding.sources.length > 0) {
				lines.push("Sources:");
				for (const src of finding.sources) {
					lines.push(`- [${src}](${src})`);
				}
				lines.push("");
			}
		}
	}

	lines.push("## Search Methodology");
	lines.push("");
	for (const round of rounds) {
		lines.push(`### Round ${round.round}`);
		lines.push(
			`Queries: ${round.queries.map((q) => `"${q.query}"`).join(", ")}`,
		);
		lines.push(`Pages scraped: ${round.results.length}`);
		lines.push(`Findings: ${round.findings.length}`);
		lines.push("");
	}

	return lines.join("\n");
}
