# Agent Mode Plan

## Goal

Use Agent Mode as OllamaBrah's path for coding workflows instead of creating a separate coding app right now. The focus is to make the current agent reliable, precise, and workspace-aware enough for real repo tasks before deciding whether a dedicated `Code` mode or separate app is justified.

## Product Direction

- Position Agent Mode as the place for coding, automation, and repo workflows.
- Keep OllamaBrah as one app for now.
- Introduce a clear `Chat` / `Agent` switcher as the main workflow split so users can immediately understand whether they are in conversational mode or coding/automation mode.
- Treat the switcher as a UX and mental-model improvement, not as proof that OllamaBrah is already a full coding IDE.
- Ship incremental improvements that match the current architecture: chat-first UI, local tool runtime, and agent loop.

## Phase 1: Product Positioning And Minimal UX

### Objective

Make Agent Mode easier to understand as the coding workflow path by giving it a clearly separate entry point from normal chat, without overpromising a full coding IDE experience.

### Tasks

- Update user-facing copy in `README.md` so Agent Mode is described as the main path for local automation and coding workflows.
- Audit UI copy in `renderer/chat.html` and `renderer/chat.js` for places where Agent Mode is explained, and rewrite those descriptions to emphasize coding, file work, and automation.
- Replace the current mental model of scattered toolbar toggles with a clearer top-level distinction between normal chat and agent-driven execution.
- Design and implement a first-class `Chat` / `Agent` switcher in the top bar.
- Use the header area as the preferred placement for the switcher so it reads as a page-level workflow state, not as just another composer toggle.
- Keep the switcher visually close to the model/status area so users understand it changes the entire interaction mode, not just a single message option.
- In `Chat` state, keep the standard composer behavior and hide agent-only controls.
- In `Agent` state, keep the same conversation surface but reveal agent-oriented controls and language.
- In `Agent` state, show a compact capabilities strip with:
  - Research: `Off / Web / Deep / Auto`
  - Memory: `Off / Inject / Inject + Save`
  - Skills: `Auto / Manual`
- In `Agent` state, update nearby labels and helper text so the user understands this mode is for coding, automation, repo work, and delegated tasks.
- Keep advanced agent settings like permissions, max steps, allowed directories, and blocked paths in Settings.
- Remove or reduce redundant toolbar toggles once the switcher and capabilities strip exist.
- Decide which existing quick toggles remain useful in `Chat` mode versus `Agent` mode so the UI does not duplicate the same controls in two places.
- Verify that the new UX does not break current flows for chat, search, memory, or skills.

### Deliverable

A clearer main surface where users explicitly choose `Chat` or `Agent`, making coding/automation workflows easier to discover without introducing a premature full `Code` mode.

## Phase 2: Durable Agent Execution

### Objective

Make agent runs robust enough for real coding tasks that may outlive the current stream, open view, or temporary interruption.

### Tasks

- Introduce a persisted `agent_run` model stored in SQLite or another existing local persistence layer.
- Persist the following per run:
  - run ID
  - status: `queued | running | waiting_permission | paused | completed | failed | cancelled`
  - conversation linkage
  - message state
  - tool/event log
  - pending permission requests
  - created/updated timestamps
- Move agent execution ownership out of the live request lifecycle in `proxy/llm.js` into a dedicated run manager.
- Add API endpoints for durable runs:
  - `POST /api/agent/runs`
  - `GET /api/agent/runs/:id`
  - `GET /api/agent/runs/:id/stream`
  - `POST /api/agent/runs/:id/resume`
  - `POST /api/agent/runs/:id/cancel`
- Refactor the current `/api/agent/chat` endpoint to either become a compatibility wrapper or share the same execution engine.
- Persist step events as append-only rows or NDJSON so the renderer can rehydrate the full trace after reload.
- Tie permission requests to a run ID instead of storing them only in memory.
- Support reconnecting to an in-progress run from the renderer after app reload or navigation.
- Add UI for run states: running, waiting for permission, paused, completed, failed, cancelled.
- Add a basic run history list so users can reopen recent agent runs.

### Deliverable

Agent runs that survive disconnects and feel like delegated tasks instead of fragile live chats.

## Phase 3: Coding-Oriented Tooling

### Objective

Upgrade the tool layer from general-purpose primitives to a practical code editing toolkit.

### Tasks

- Add `readFileRange(path, start, end)` so the agent can inspect large files without wasting context.
- Add `searchInFiles(query, scope)` for codebase text search.
- Add `globFiles(pattern, scope)` for fast path-based discovery.
- Add `applyPatch(path, diff)` for surgical file edits.
- Add `replaceInFile(path, search, replace)` for targeted replacements.
- Add filesystem helpers:
  - `mkdir`
  - `copyFile`
  - `moveFile`
- Improve `diffFiles` output so it is more useful for previewing edits and reviews.
- Revisit `readFile`, `writeFile`, and `appendFile` semantics so they remain available but are no longer the primary editing path for coding tasks.
- Cache file indexes or search results during a run so the agent does not repeatedly rescan the same workspace.
- Add tests for each new tool and for permission enforcement on those tools.

### Deliverable

A toolset that supports real repo work with less context waste and less risk of blunt file overwrites.

## Phase 4: Plan-First Approvals

### Objective

Reduce interruption spam and increase trust by letting users approve a coding plan instead of approving every primitive action one by one.

### Tasks

- Define a plan schema for risky or multi-step work.
- Require the agent to emit a plan before:
  - multi-file edits
  - shell commands
  - destructive operations
  - large workspace changes
- Ensure each plan includes:
  - intended actions
  - affected files and paths
  - risk level
  - expected commands
  - diff previews when possible
- Add a plan approval UI in the renderer.
- Let the user approve:
  - the full plan
  - selected parts of the plan
  - a narrower path scope when relevant
- Tie approvals to run + plan scope instead of only single tool calls.
- Preserve the existing low-level permission system as a fallback for non-plan actions.
- Add auditability so completed runs show which plan was approved and what was actually executed.

### Deliverable

Agent Mode becomes more trustworthy and less exhausting during serious coding work.

## Phase 5: Workspace-Aware UX

### Objective

Add the minimum project-oriented UX needed before considering whether `Agent` should later evolve into a stronger first-class coding workspace.

### Tasks

- Add selected working directory / project root to the main agent workflow.
- Let users set or switch the active workspace for an agent run.
- Show a changed-files panel for the current run.
- Show a diff preview panel for agent-proposed or completed edits.
- Show a `files touched in this run` summary in the final run output.
- Add a shell output panel for agent commands so command results are not buried in chat text.
- Add a compact run timeline that separates:
  - reasoning/status
  - tool calls
  - file edits
  - shell output
  - final summary
- Make the active workspace visible in the UI so users always know which repo the agent is operating on.
- Add guardrails so workspace-scoped actions default to the selected project root.

### Deliverable

Agent Mode starts feeling like a coding workspace layered onto OllamaBrah rather than a chat transcript with occasional file actions.

## Phase 6: Decision Gate For A Stronger Code Mode

### Objective

Only consider a full `Code` mode or a separate app after the underlying execution and tooling layers are mature enough.

### Success Signals To Evaluate

- Agent runs are durable and resumable.
- Users can complete multi-file coding tasks without constant babysitting.
- Patch-based editing is the default for code changes.
- Workspace-aware UX is used regularly.
- Users are spending more time on repo work than standard chat use cases.

### Questions To Revisit

- Is coding now the dominant use case for OllamaBrah?
- Is the chat-first shell helping or hurting coding workflows?
- Do we need a radically different layout, such as persistent file tree + diff pane + terminal pane?
- Would a separate app reduce complexity, or just duplicate the same backend work under a new brand?

### Decision Rule

- If coding becomes the dominant use case and the `Chat` / `Agent` split is no longer enough, promote coding into a stronger first-class mode.
- If coding and chat remain naturally unified, keep one app and continue refining Agent Mode.
- Do not split into a dedicated coding app until the product evidence is strong enough to justify the added maintenance cost.

## Suggested Execution Order

### Next Release

- Reposition Agent Mode in product copy
- Add top-bar `Chat` / `Agent` switcher
- Add compact agent capabilities strip
- Keep advanced controls in Settings

### Near-Term Upgrades

- Durable run model
- Resume/reconnect support
- Persisted event log
- Permission state tied to run ID
- Range reads, search, glob, patch, replace, mkdir, move, copy
- Better diff handling
- Plan-first approval flow

### After That

- Workspace root selection
- Changed-files panel
- Diff preview panel
- Files-touched summary
- Shell output panel

### Only Then

- Re-evaluate whether a stronger `Code` mode is warranted
- Re-evaluate whether a separate coding app is justified

## Immediate Practical Starting Points

If you want the shortest path to visible progress, start here:

1. Build the top-bar `Chat` / `Agent` switcher and capabilities strip.
2. Add a durable `agent_run` persistence model and run status API.
3. Add `readFileRange`, `searchInFiles`, `globFiles`, and `applyPatch`.
4. Add plan-first approval for shell and multi-file edits.
5. Add workspace root selection and changed-files summary.

## Decision Summary

Use Agent Mode as the coding path for now.

Do not build a separate coding app yet. The main gaps are execution-model maturity, file-edit precision, approval UX, and workspace awareness inside the current architecture. Solve those first, then decide whether `Code` deserves to become a first-class mode.

## UX Note On The Switcher

- Preferred label pair: `Chat` and `Agent`.
- Preferred placement: top bar / header area, not buried in the composer toolbar.
- Reason: this communicates a workflow-level switch between conversational use and coding/automation use.
- Keep the main chat transcript shared between both modes so the app still feels like one product.
- Let the selected mode change the controls, helper text, and defaults around the composer instead of splitting into two separate apps or layouts immediately.
