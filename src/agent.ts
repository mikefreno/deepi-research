/**
 * Deep Research — Agent Session helper
 *
 * Uses pi's in-process `createAgentSession` for LLM subtasks
 * (query generation, result analysis, report synthesis).
 * Pattern borrowed from ralpi's runAgentSession().
 */
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Aggregate tool usage stats */
export interface ToolUsage {
	read: number;
	write: number;
	edit: number;
	bash: number;
	other: number;
}

export interface AgentResult {
	success: boolean;
	text: string;
	error?: string;
	toolUsage: ToolUsage;
}

/**
 * Run a prompt through an in-process Pi agent session.
 * Non-blocking — the event loop stays responsive.
 */
export async function runAnalysisAgent(
	systemPrompt: string,
	taskPrompt: string,
	cwd: string,
	timeoutMs: number = 120_000,
	onEvent?: (event: AgentSessionEvent) => void,
	signal?: AbortSignal,
): Promise<AgentResult> {
	const toolUsage: ToolUsage = {
		read: 0,
		write: 0,
		edit: 0,
		bash: 0,
		other: 0,
	};

	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	if (timeoutMs > 0) {
		timeoutHandle = setTimeout(() => {
			sessionRef.session?.agent.abort();
		}, timeoutMs);
	}

	const sessionRef: {
		session?: Awaited<ReturnType<typeof createAgentSession>>["session"];
	} = {};

	try {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const result = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: loader,
			tools: ["read", "grep", "find", "ls"],
		});
		sessionRef.session = result.session;

		const abortHandler = () => result.session.agent.abort();
		signal?.addEventListener("abort", abortHandler, { once: true });

		let finalText = "";
		let errorMessage: string | undefined;

		const unsubscribe = result.session.subscribe((event: AgentSessionEvent) => {
			onEvent?.(event);

			if (event.type === "message_end") {
				const message = event.message as {
					role?: string;
					content?: unknown;
					errorMessage?: string;
				};
				if (message.role !== "assistant") return;
				if (message.errorMessage) errorMessage = message.errorMessage;
				const text = extractAssistantText(message.content);
				if (text) finalText = text;
			}

			if (event.type === "tool_execution_start") {
				const name = event.toolName;
				if (name in toolUsage) {
					(toolUsage as unknown as Record<string, number>)[name]++;
				} else {
					toolUsage.other++;
				}
			}
		});

		if (signal?.aborted) throw new Error("Aborted");

		await result.session.prompt(`${systemPrompt}\n\n${taskPrompt}`);
		await result.session.agent.waitForIdle();

		unsubscribe();
		result.session.dispose();
		signal?.removeEventListener("abort", abortHandler);
		if (timeoutHandle) clearTimeout(timeoutHandle);

		if (errorMessage && !finalText) {
			return { success: false, text: "", error: errorMessage, toolUsage };
		}

		return { success: true, text: finalText.trim(), toolUsage };
	} catch (error) {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		return {
			success: false,
			text: "",
			error: error instanceof Error ? error.message : String(error),
			toolUsage,
		};
	} finally {
		sessionRef.session?.dispose();
	}
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: string; text?: string } =>
				!!c &&
				typeof c === "object" &&
				(c as { type?: string }).type === "text",
		)
		.map((c) => (c as { text?: string }).text ?? "")
		.join("");
}
