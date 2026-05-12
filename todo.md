# Agent Reliability Fix Plan

## Priority 0: Reproduce and Measure

- [x] Add an agent run diagnostics panel or debug endpoint that shows:
  - model name and backend
  - request options sent to the backend
  - elapsed time per model step
  - whether the response had content, thinking, tool calls, or raw parse errors
  - finish reason / done reason when available
- [x] Add tests or fixtures for these failure cases:
  - backend returns no content and no tool calls
  - backend returns reasoning/thinking only
  - backend times out before a final response
  - backend returns malformed tool calls
  - agent mode receives per-model options from the UI
- [x] Keep a small set of persisted sample agent runs for regression testing.

## 1. Empty Agent Responses Are Marked Completed

Problem: agent mode currently treats "no tool calls" as completion even when the model returns no useful content. This creates fake successful runs.

- [x] In `proxy/llm.js`, change the no-tool-call branch so empty content is not marked `completed`.
- [x] Emit a clear event such as `empty_model_response` with model, backend, step, elapsed time, and any finish reason.
- [x] Mark the run `failed` or `paused` with `canResume: true` instead of `completed`.
- [x] Add a retry path that asks the model for a concise final answer when the first response is empty.
- [x] Update the frontend to show "Model returned an empty response" instead of the generic "Agent response - see steps above" placeholder.
- [x] Add tests proving empty model responses do not become completed runs.

## 2. Reasoning-Only Responses Are Not Handled in Agent Mode

Problem: normal chat detects thinking-only output, but agent mode ignores reasoning/thinking fields and may complete without a final answer.

- [x] Normalize reasoning fields from Ollama and llama.cpp in agent responses:
  - `message.thinking`
  - `reasoning_content`
  - raw `<think>...</think>` content
- [x] If the response contains thinking but no final content or tool calls, emit a `reasoning_only_response` event.
- [x] Retry once with a strict instruction: "Return only the final answer or a valid tool call. Do not continue thinking."
- [x] Keep thinking traces out of future agent context unless explicitly needed for debugging.
- [x] Add agent-mode UI messaging that matches the normal chat fallback.
- [x] Add tests for reasoning-only output from both Ollama-style and OpenAI/llama.cpp-style responses.

## 3. Agent Model Calls Need Streaming or Better Timeouts

Problem: agent mode uses non-streaming model calls with a hard 120s timeout. Local reasoning models can spend that budget thinking, then the app loses useful partial state.

- [x] Replace non-streaming agent model calls with streaming calls where possible.
- [x] Track partial content, thinking, and tool calls as they stream.
- [x] Use separate timeout settings:
  - connection timeout
  - first-token timeout
  - inactivity timeout
  - max step duration
- [x] Make these values configurable through environment variables.
- [x] Expose agent timeout controls through Settings.
- [x] Fix incorrect timeout messages that still say "30s" while using 120s.
- [x] Persist timeout details into `run.json` and `events.ndjson`.
- [x] Add tests for timeout classification and resumability.

## 4. Agent Mode Must Honor Model Parameters

Problem: normal chat sends model options such as `temperature`, `top_p`, `num_predict`, `num_ctx`, and `think`, but agent mode does not pass them through.

- [x] Include model options in the `agentBody` created in `renderer/chat.js`.
- [x] Store those options in the durable run request body.
- [x] Pass options into `callOllamaWithTools` and `callLlamaCppWithTools`.
- [x] Map options correctly per backend:
  - Ollama: `options.num_predict`, `options.num_ctx`, `think`
  - llama.cpp: `max_tokens`, context handled by server profile, supported sampling args
- [x] Add a conservative default max token budget for agent steps if the user has no explicit setting.
- [x] Add tests proving agent requests preserve and apply model settings.

## 5. Prevent Stale Proxy Mismatches

Problem: if port `3456` is already occupied, the app can reuse an old proxy process. The UI may talk to stale code after an update or local edit.

- [x] Add `/api/version` or `/api/build-info` to the proxy.
- [x] Include app version, package version, startup timestamp, and a source/build hash when available.
- [x] On renderer startup, verify the proxy version matches the app version.
- [x] If the proxy is stale, show a blocking readiness warning and offer a restart action.
- [x] Improve proxy shutdown:
  - wait longer than 1.5s when intentionally replacing the proxy
  - verify the old process actually stopped
  - fail loudly if a foreign process owns the port
- [x] Add tests for version endpoint shape.

## Important Reliability Upgrades

- [x] Add model capability detection for agent mode:
  - supports tool calls
  - supports structured JSON tool arguments
  - reasoning model likely
  - recommended agent defaults
- [x] Warn or disable agent mode for models that do not reliably support tools.
- [x] Add a "final answer required" guard after tool execution so the run does not stop after tool chatter.
- [x] Improve web search quality gates so the agent does not loop through bad search results without progress.
- [x] Increase or configure `runShell` timeout beyond the current 30s default.
- [x] Add command timeout controls per tool instead of one hardcoded shell timeout.
- [x] Add run health statuses:
  - `running`
  - `waiting_permission`
  - `paused_empty_response`
  - `paused_reasoning_only`
  - `paused_timeout`
  - `failed_backend`
  - `completed`
- [x] Add a one-click "continue with safer prompt" action for paused/empty/reasoning-only runs.

## Dependency and Platform Upgrades

- [x] Upgrade small low-risk packages first:
  - `@llamaindex/liteparse`
  - `diff`
  - `dotenv`
- [x] Plan larger upgrades separately with smoke testing:
  - Electron
  - Electron Builder
  - Express 5
  - `better-sqlite3`
  - `electron-store`
  - `pdf-parse`
  - `vectra`
  - Defer these to a dedicated branch/release because they affect runtime packaging, native modules, routing semantics, and document/vector parsing.
  - Upgrade one family at a time, run `npm test`, then run the Windows app smoke checklist below before merging.
- [ ] Before major Electron upgrades, verify:
  - app startup
  - proxy startup/shutdown
  - SQLite reads/writes
  - streaming chat
  - agent runs
  - packaged Windows build

## Verification Checklist

- [x] `npm test`
- [ ] Manual normal chat test with an Ollama local model.
- [ ] Manual normal chat test with llama.cpp backend.
- [ ] Agent test: simple final answer, no tools.
- [ ] Agent test: read file and summarize.
- [ ] Agent test: write/edit file and run shell verification.
- [ ] Agent test: reasoning model with thinking enabled and disabled.
- [ ] Agent test: intentionally slow command/model response.
- [ ] Restart app mid-agent-run and confirm resume behavior.
- [ ] Confirm latest production run no longer shows `completed` with zero content and zero tool calls.
