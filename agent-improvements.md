# Agent Mode Improvements

## 1. Make Agent Runs Truly Durable and Outcome-Oriented

### Problem / Limitation

Agent runs are only partially durable today. The run record is persisted, but live execution still sits in the proxy process via in-memory `activeAgentRuns`, resume creates a new run, and step exhaustion falls back to a manual `Continue (+5/+15)` interaction rather than a real suspended job state ([proxy/llm.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/llm.js:64), [proxy/agent-runs.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/agent-runs.js:27), [renderer/chat.js](C:/Users/Boris/Documents/Code/ollama_brah/renderer/chat.js:1124)).

### Why It Matters

This keeps agent mode in a "babysat live session" category instead of a delegated assistant category. Long repo tasks, research jobs, or multi-step fixes still require the user to keep the app open, watch step limits, and manually push the run forward.

### Proposed Enhancement

Turn runs into true background jobs that continue until they either finish, hit a real blocker, or exceed a configurable budget. "Paused waiting for approval" and "paused waiting to continue" should be first-class run states, not improvised through chat events.

### Implementation Direction

- Move execution ownership out of the request/stream lifecycle into a dedicated run worker with a persisted state machine.
- Persist resumable execution state: current step, latest messages, pending approvals, granted scopes, tool cache/index handles, and run budget.
- Keep the same run ID across pause/resume instead of forking a new run on resume.
- Add restart recovery on boot: reconcile `running` runs, mark stale ones, and offer resume/recover.
- Replace `maxSteps` babysitting with policies like `run_until_done`, `run_until_blocked`, and `max_compute_budget`.

### Expected Impact

This is the biggest unlock. Agent mode starts supporting "start this and come back later" workflows, which materially increases trust, depth of usage, and the kinds of tasks users will hand off.

## 2. Replace Tool-Level Interruptions with Scope-Based Approval

### Problem / Limitation

The current model still makes users approve at the wrong level. Risky steps trigger plan approval, but the actual file edits and shell commands still hit per-tool permission gates, and the approval memory is only an in-memory `sessionPermissions` map that disappears on disconnect/resume ([proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:640), [proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:702), [proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:824), [proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:1065)).

### Why It Matters

Users want to approve outcomes, not micromanage tool calls. Repeated "approve plan, approve write, approve patch, approve shell" breaks flow, increases cognitive load, and makes the agent feel both slow and brittle.

### Proposed Enhancement

Introduce approval envelopes: the agent first scouts, then proposes a bounded execution scope such as "edit these files, run these commands, then show diff + test results." The user approves that scope once. The agent only interrupts again if it needs to go outside the approved boundary.

### Implementation Direction

- Persist `approvedScopes` on the run record, keyed by workspace, file set/glob, tool families, and command hashes.
- Make plan approval the primary control surface; demote per-tool prompts to exceptions when scope expands.
- Add diff bundle previews and command previews before execution, not only after individual tools finish.
- Support approval scopes like `this run`, `this workspace`, `this file set`, `this command family`.
- Treat disconnects as "approval pending" rather than auto-deny whenever possible.

### Expected Impact

This would sharply reduce interruptions while improving safety. The agent becomes much more usable for real coding and automation work because the user can approve intent once and let the system execute.

## 3. Add a Workspace Intelligence Layer and Dependency-Aware Executor

### Problem / Limitation

Workspace awareness is mostly just path restriction plus low-level file tools. The agent has to rediscover repo structure by calling `findFiles`, `searchInFiles`, `readFileRange`, etc., backed by only a tiny 30-second per-run cache, and multi-tool steps are executed blindly in parallel with `Promise.all` ([proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:14), [proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:202), [proxy/tools.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/tools.js:333), [proxy/llm.js](C:/Users/Boris/Documents/Code/ollama_brah/proxy/llm.js:1764)).

### Why It Matters

On real repos, that wastes steps, burns context, and makes the agent slower and less reliable than it should be. It also increases the chance of bad execution ordering when multiple file or shell actions are launched together without dependency awareness.

### Proposed Enhancement

Add a repo intelligence service plus an execution scheduler. The agent should start from a structured workspace model, not raw file walking, and it should execute tool batches as an ordered action graph instead of a flat parallel burst.

### Implementation Direction

- Build a background workspace index per root: file tree, manifests, package scripts, tests, lockfiles, major entrypoints, git status, and optionally symbol-level search.
- Expose higher-level tools such as `inspectRepo`, `searchSymbol`, `readRelatedFiles`, `gitStatus`, `runProjectCommand`, `runTests`, and `applyPatchSet`.
- Return structured JSON from tools where possible so the model reasons over machine-friendly outputs, not only long text blobs.
- Add a scheduler that parallelizes only safe reads/fetches, while serializing conflicting writes and command chains with file/resource locks.
- Incrementally invalidate the workspace index on edits instead of relying on a short-lived cache.

### Expected Impact

This makes agent mode feel smarter immediately: faster repo comprehension, fewer wasted steps, safer execution, and much stronger performance on coding tasks, which is where this feature can create the most product value.
