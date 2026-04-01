# Agent Mode Improvements

## Top 3 Opportunities

## 1. Make Agent Runs Durable, Resumable, and Background-Capable

### Problem / Limitation
Agent runs are currently tied to the live HTTP stream and the open chat view. If the client disconnects, the loop stops immediately (`proxy/llm.js:1315-1319`), and pending permissions auto-deny when the stream closes (`proxy/tools.js:299-317`). The only continuation path is an in-UI "continue +5/+15 steps" flow after max-step exhaustion, using in-memory messages returned to the renderer (`renderer/chat.js:486-522`, `renderer/chat.js:590-592`).

### Why It Matters
This makes agent mode fragile for any meaningful task. Users cannot confidently hand off long-running work, switch chats, restart the app, or leave the machine without risking total loss of progress. That limits agent mode to "babysat" usage instead of true delegation.

### Proposed Enhancement
Turn agent mode into a durable job system with pause/resume, reconnectable streaming, and optional background completion.

### Implementation Direction
Persist an `agent_run` record with:
- current message state
- tool/event log
- pending permission requests
- run status: `queued | running | waiting_permission | paused | completed | failed | cancelled`

Move execution off the request lifecycle into a run manager/worker.
Expose:
- `POST /api/agent/runs`
- `GET /api/agent/runs/:id`
- `GET /api/agent/runs/:id/stream`
- `POST /api/agent/runs/:id/resume`
- `POST /api/agent/runs/:id/cancel`

Store step events as append-only NDJSON or SQLite rows so the renderer can rehydrate the full trace after reload. Persist permission requests by run ID instead of keeping them only in memory. On completion, attach the final summary and artifacts back into the conversation.

### Expected Impact
This is the biggest unlock. Agent mode starts feeling like a real autonomous assistant instead of a fragile streamed interaction. It enables "start this and come back later" workflows, reduces fear of losing work, and materially increases trust and usage depth.

## 2. Unify Agent Mode with Search, Research, Memory, and Skills Instead of Forcing Mode Selection

### Problem / Limitation
Agent mode is siloed from the other intelligence systems. The UI forces mutual exclusivity between agent mode, web search, and deep research (`renderer/chat.js:151-156`, `renderer/chat.js:193-197`, `renderer/chat.js:209-219`). The normal chat path uses `augmentChatMessages(...)` to inject live search, fetched URLs, and memory context (`proxy/llm.js:636-775`), but the agent path bypasses that and runs its own loop (`proxy/llm.js:1221-1452`). In practice, memory only gets auto-extracted after an agent run, not injected into it (`renderer/chat.js:5652-5655`).

### Why It Matters
Users are forced to choose between "automation" and "context." That raises cognitive load and makes agent mode feel less capable than regular chat in some cases. It also blocks high-value flows like: research live sources, use prior memory, then act on files or clipboard in one run.

### Proposed Enhancement
Make agent mode the orchestrator for all advanced capabilities. Search, deep research, memory retrieval, and skill loading should become composable parts of one run, not separate modes.

### Implementation Direction
Refactor pre-processing into reusable capability stages shared by both chat and agent:
- query classification
- live search/deep research retrieval
- URL fetching
- memory retrieval
- skill preloading/hinting

Then let agent runs declare policies, not modes, for example:
- `research: off | web | deep | auto`
- `memory: off | inject | inject_and_extract`
- `skills: auto | manual`

Deep research should either become an agent-callable tool or a preflight step that returns structured sources/citations into the agent context. Memory retrieval should be injected before the run, not only extracted afterward.

### Expected Impact
This removes unnecessary mode decisions and makes the feature feel much smarter. Users can ask once and get a system that decides whether to search, retrieve memory, load a skill, and act. That materially expands the feature from "tool calling" to "workflow orchestration."

## 3. Shift from Primitive Tool Calls to Plan-Based Execution with Batched Permissions and Surgical File Operations

### Problem / Limitation
The current tool model is too low-level for serious work. File access is coarse:
- `readFile` only returns the first 8k chars (`proxy/tools.js:371-378`)
- edits are mostly blunt `writeFile`/`appendFile` overwrites (`proxy/tools.js:380-388`, `proxy/tools.js:552-560`)
- permissions are granted per primitive action, with only once/session/folder scopes (`proxy/tools.js:265-318`, `renderer/chat.js:316-469`)

This creates repetitive approvals, poor large-file handling, and brittle multi-step code/file workflows.

### Why It Matters
Users want to delegate outcomes, not micromanage reads, writes, and confirmations. The current behavior wastes steps, increases interruption cost, and reduces trust because the agent is both too powerful and too imprecise at the same time.

### Proposed Enhancement
Add plan-first execution for multi-step or risky tasks, plus a more surgical workspace toolset.

### Implementation Direction
Introduce tools like:
- `readFileRange(path, start, end)`
- `searchInFiles(query, scope)`
- `globFiles(pattern, scope)`
- `applyPatch(path, diff)`
- `replaceInFile(path, search, replace)`
- `moveFile`, `mkdir`, `copyFile`

For risky or multi-file work, require the model to emit an execution plan first:
- intended actions
- target files/paths
- estimated risks
- preview diffs where possible

Then let the user approve the whole plan or selected scopes once. Internally, permission records should bind to a run + plan scope, not only a single tool call. For edits, prefer patch/diff application over blind overwrite. Cache file indexes during a run so the agent stops re-scanning the same directories.

### Expected Impact
This would sharply reduce user interruptions and step waste while making the agent substantially more capable at real file/code workflows. The system becomes faster, more trustworthy, and more useful for high-value automation rather than toy interactions.

## Open Question
The main product choice is whether agent mode should remain a "live co-pilot" or become a true delegated job runner. The codebase is already close enough to the latter that optimizing in that direction would likely create the most product value.
