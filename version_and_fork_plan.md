# Response Versioning & Fork Conversation — Implementation Plan

## Feature 1: Response Versioning (Non-Destructive Regenerate)

### Data Model Change

Minimal — add one optional field to the message object:

```javascript
// Current message
{ role: 'assistant', content: '...', thinking: '...', metadata: {...} }

// With versioning
{
  role: 'assistant',
  content: '...',           // always the "active" version
  thinking: '...',
  metadata: {...},
  alternatives: [           // NEW — previous versions, ordered oldest-first
    { content, thinking, metadata },
    { content, thinking, metadata }
  ]
}
```

No schema migration needed — `alternatives` is just a new optional array on the message object. Old conversations without it work unchanged. The active response is always the top-level `content/thinking/metadata`; alternatives just hold the swapped-out versions.

### Regenerate Flow Change

Current: delete last message → re-trigger LLM.

New:
1. Pop the last assistant message from the array
2. **Stash it**: push `{content, thinking, metadata}` into a temporary hold
3. Re-trigger LLM completion
4. When completion finishes and the new message is pushed to the array, attach the stash as `alternatives` (merging with any existing alternatives from prior regenerations)

This means the new response becomes the active one, and all previous versions accumulate in `alternatives`. If the user regenerates 3 times, `alternatives` has 2 entries, active response is the 3rd.

### UI: Version Navigator

On any assistant message that has `alternatives.length > 0`, render a small version indicator in the metadata bar:

```
◀  2 / 3  ▶                        ○ 63 tokens · 36.3 t/s · 1.74s
```

- Position: left side of `.message-metadata`, before the token counts
- `◀ ▶` arrows cycle through versions (including the current active one)
- Clicking an arrow swaps: move current `{content, thinking, metadata}` into `alternatives` at the right index, pull the target version out, set it as the top-level fields, re-render that single message's `.message-text-content` and metadata
- Persist on swap — `saveModelChatState()` so the selected version survives app restart
- The regenerate button still only appears on the **last** bot message; version arrows appear on any bot message that has alternatives (since you may have regenerated earlier in the conversation, then continued)

### Edge Cases
- **Edit a user message above a versioned response**: the existing `saveEditedMessage` truncates everything after the edit point, so alternatives are naturally discarded (the conversation diverged — old versions are meaningless)
- **Pin a versioned message**: pins the currently active version; alternatives stay attached
- **Export markdown**: exports the active version only (alternatives are drafts, not canonical)

---

## Feature 2: Fork Conversation (With Model Selection)

### How It Fits the Architecture

This works *with* the existing `model → conversations` structure, not against it:

1. Copy messages from source conversation up to fork point
2. Create a new conversation under the **target model's** state
3. Save the target model's state
4. Switch to target model + activate the forked conversation

If forking to the **same model**, skip the model switch — just create a sibling conversation and switch to it.

### Flow

1. User clicks "Fork from here" on any message (user or assistant)
2. A small popover appears listing available models (current model pre-selected at top, marked as "same model")
3. User picks a model
4. App does:
   ```
   sourceMessages = currentConversation.messages.slice(0, messageIndex + 1)
   targetModelData = loadModelChatState(targetModel)
   newConversation = {
     id: generateUUID(),
     messages: deepCopy(sourceMessages),  // strip alternatives to start fresh
     summary: '⑂ ' + currentConversation.summary,  // fork indicator in title
     lastMessageTime: Date.now(),
     forkedFrom: {                        // optional metadata
       model: sourceModel,
       conversationId: sourceConvId,
       messageIndex: messageIndex
     }
   }
   targetModelData.conversations[newConv.id] = newConversation
   targetModelData.activeConversationId = newConv.id
   saveModelChatState(targetModel, targetModelData)
   ```
5. If target model === current model: just `switchActiveConversation()` — sidebar updates, messages render, user is in the forked conversation
6. If target model !== current model: call `switchModel(targetModel)` — which loads its state and sees the new active conversation

### UI: Fork Button + Model Picker

**Fork button** — add to `.message-actions` on every message (user and assistant):
- Icon: `git-branch` (Lucide has this)
- Tooltip: "Fork conversation from here"
- Position: after existing action buttons

**Model picker popover** — small floating panel anchored to the fork button:
```
┌─────────────────────────┐
│ Fork to model:          │
│ ● current-model ← same │
│ ○ llama3.1:8b           │
│ ○ deepseek-r1:14b       │
│ ○ mistral:7b            │
│ ○ qwen2.5:32b           │
└─────────────────────────┘
```
- Lists all available models from the model dropdown (already fetched and cached)
- Current model at top with "(current)" label
- Click a model → execute fork → close popover
- Click outside → close popover
- No full modal needed — this is a fast, lightweight interaction

**Sidebar indicator** — forked conversations show the `⑂` prefix in their title, making them visually distinct. That's enough; no need for a tree view or complex branching visualization.

### Edge Cases
- **Forking with attachments**: copy attachment metadata (chunks, summaries) but not raw base64 (too large). The context block built from chunks will still work. If the target model doesn't support vision, image attachments are already handled gracefully (OCR text used instead).
- **Forking to a model that isn't loaded**: works fine — `loadModelChatState` returns empty defaults, new conversation gets inserted.
- **System prompt differences**: the forked conversation inherits the target model's system prompt (not the source's). This is correct — each model has its own persona/config.
- **Forking at the last message**: valid — creates a copy of the entire conversation. User can then take it in a different direction.
- **Memory/search context**: not copied. These are per-turn injections, not part of the message history. The forked conversation will use the target model's memory settings.

---

## Summary of Changes Required

| Area | Response Versioning | Fork Conversation |
|------|---|---|
| **Data model** | Add `alternatives[]` to message | Add `forkedFrom{}` to conversation (optional) |
| **Persistence** | No migration — additive field | No migration — additive field |
| **chat.js** | Modify `regenerateLastResponse`, add version navigator render/swap logic, update `addMessageToChatUI` | Add `forkConversation()`, model picker popover, fork button in message actions |
| **chat.html/CSS** | Version nav styles (arrows + counter in metadata bar) | Popover styles, fork button icon |
| **Proxy/backend** | None | None |

Both features are additive, require zero backend changes, and don't touch the `model → conversations` architecture.
