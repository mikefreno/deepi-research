# Deep Research

Multi-round deep web research powered by Firecrawl with iterative query refinement.

```bash
pi install npm:@mikefreno/deep-research
```

## Features

- **Multi-round iteration**: Each round generates follow-up queries based on previous findings (depth 1-3)
- **Parallel query expansion**: Multiple diverse search queries per round (breadth 1-5) covering technical, practical, comparative, critical, and forward-looking angles
- **LLM-driven analysis**: Each round's results are analyzed by an agent session to extract structured findings with confidence ratings
- **Automatic deduplication**: Search results are deduplicated by URL across all queries
- **Graceful degradation**: Individual search or analysis failures don't crash the full research — partial results are preserved
- **Progress streaming**: Real-time progress widget with spinner, phase indicators, and progress bar
- **Abort support**: Research can be cancelled mid-flight via `AbortSignal`
- **Rich TUI rendering**: Compact collapsed view and detailed expanded view in the terminal UI
- **Fallback resilience**: Built-in fallback query generation and report synthesis when LLM calls fail

## Usage

### Tool (LLM-callable)

Registers the `deep_research` tool for AI agent use:

```
deep_research — multi-round deep web research via Firecrawl with iterative query refinement
```

Parameters:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | string | — | The research question to investigate |
| `depth` | integer (1-3) | 2 | Number of research rounds |
| `breadth` | integer (1-5) | 3 | Search queries per round |
| `format` | "markdown" \| "structured" | "markdown" | Output format for the report |
| `details.showRoundDetails` | boolean | false | Include per-round search metadata in output |

### Command (interactive)

```
/deep-research <your research question>
```

Prompts for depth (1-3 rounds) and breadth (1-5 queries) interactively, then runs the research and sends the final report as a user message.

### Recommended usage

- Use `deep_research` for complex, multi-faceted questions that benefit from multiple search angles and iterative refinement.
- The tool handles query generation, web search, result analysis, and report synthesis automatically.
- For simple fact-finding questions, use `firecrawl_search` directly instead.

## Architecture

```
Research Flow:

  Question
     ↓
  ┌─ Round 1 ───────────────────────────┐
  │  LLM → generate queries (N angles)   │
  │  Firecrawl → search each query       │
  │  LLM → analyze results → findings    │
  └──────────────┬───────────────────────┘
                 ↓ (follow-up queries)
  ┌─ Round 2 ───────────────────────────┐
  │  LLM → identify knowledge gaps       │
  │  Firecrawl → search follow-ups       │
  │  LLM → analyze → new findings        │
  └──────────────┬───────────────────────┘
                 ↓ (iterate depth times)
  ┌─ Synthesis ─────────────────────────┐
  │  LLM → synthesize all findings       │
  │  → comprehensive research report     │
  └─────────────────────────────────────┘
```

## Configuration

Deep Research reads Firecrawl configuration from `~/.pi/agent/settings.json`:

```json
{
  "firecrawl": {
    "baseUrl": "http://localhost:3002",
    "apiKey": "your-api-key"
  }
}
```

Environment variables are also supported:
- `FIRECRAWL_BASE_URL` — overrides the Firecrawl endpoint (default: `http://localhost:3002`)
- `FIRECRAWL_API_KEY` — API key for authenticated Firecrawl instances

### Session startup check

On `session_start`, the extension checks whether the Firecrawl endpoint is reachable. If not, it shows a warning notification so you know searches will fail before you try to use it.
