# OllamaBrah

![OllamaBrah](assets/banner.png)

A desktop chat client for local [Ollama](https://ollama.com) and [llama.cpp](https://github.com/ggerganov/llama.cpp) models. Built with Electron.

> Ported from the [OllamaBro browser extension](https://github.com/BorisHrzenjak/OllamaBro) — all the same features, now as a standalone desktop app.

---

## What's New - v1.15.0

- **Plan-first approvals for risky agent actions** — shell commands and file-changing tools now emit a plan approval card before execution so Agent Mode asks for intent-level confirmation before the lower-level permission prompt
- **Plan decisions are persisted with the run** — pending plans, approval decisions, and a basic plan audit trail are now stored with durable runs and replayed after reconnect/reopen
- **Run replay shows plan audit context** — reopening a run now shows whether plans were approved, making serious coding tasks easier to review
- **Phase 4 test coverage started** — plan-gated tool metadata is now covered alongside the existing tool and permission tests (`npm test`)

---

## Features

### Models & Backends
- **Ollama** — chat with any locally installed Ollama model
- **llama.cpp** — run GGUF models directly via `llama-server`; configure binary path, models directory, GPU layers, context size, and server port
- `llama.cpp` scans GGUFs into a manifest with per-model runtime profiles, inferred capabilities, and automatic `mmproj` pairing for multimodal setups
- `llama.cpp` now supports the same app-side web search, deep research, memory injection, and explicit memory-save automation used by the Ollama backend
- `llama.cpp` session state is persisted so the app can optionally recover the last active GGUF runtime and reuse in-flight loads when startup keep-alive is enabled
- Document attachments work with `llama.cpp` even when image attachments are unavailable
- Model switcher, model management, and dashboard views with live availability checking plus separate local, cloud, and `llama.cpp` sections
- Dot-safe model history storage with legacy migration so dashboard and usage stats stay accurate for future model names
- Kokoro TTS via the local proxy with on-demand model caching, sentence streaming playback, and a built-in self-test endpoint
- Startup diagnostics for Ollama, llama.cpp, memory, and voice prerequisites with guided recovery actions
- Auto-detect context window size per model
- Override context limit manually
- Adjust model parameters per model: temperature, top-p, top-k, repeat penalty, max tokens, seed
- Pull new models from the Ollama registry
- Pull input accepts either a bare model name or pasted `ollama pull ...` / `ollama run ...` commands
- Update individual models or bulk-update all at once
- Hardware-based model recommendations via llmfit integration

### Chat
- Full streaming responses with stop button
- Non-destructive regenerate with per-message response version history
- Fork conversations from any message, including into a different model
- Relaunching the app focuses the existing window instead of opening a duplicate app instance
- Thinking/reasoning model support — collapsible reasoning blocks (DeepSeek, QwQ, etc.)
- Multiple conversations per model with search and tag filtering
- Message history navigation with `↑` / `↓`
- Pin messages to preserve them in context
- Per-message actions: copy, read aloud, download as TXT or Markdown, remove
- GitHub Releases update checks with optional startup notifications, a manual check button in Settings, and a compact update popup with version/date info
- Drag & drop file attachments
- Supported file types: images, PDF, TXT, Markdown, Python, JS, TS, JSON, HTML, CSS, SQL, Shell, YAML, XML, CSV, logs
- Document attachments are chunked and summarized automatically, with only the most relevant excerpts injected into context on each turn
- Scanned PDFs and plain image attachments are OCR-processed automatically, so text-only models can use screenshots, photos, and image-based documents too
- Attached documents stay useful on follow-up questions instead of being pasted in full every time
- Export full conversations as Markdown
- Context meter showing token breakdown (system prompt / search / conversation)

### Input Modes
- **Top-bar `Chat` / `Agent` workflow switcher** — quickly move between normal conversation and the coding/automation workflow
- **Web search** — augment responses with live Tavily search results
- **Deep research** — multi-step Exa research pipeline before answering
- **Agent mode** — autonomous tool-use loop with step-by-step visualization, live in-progress status feedback between tool phases, configurable max steps and permissions, and support for web search, deep research, memory injection, and skill hints in a single run
- **Agent capabilities strip** — in Agent workflow, pick research mode (`Off / Web / Deep / Auto`), memory mode (`Off / Inject / Inject + Save`), and skills mode (`Auto / Manual`)
- **Coding-oriented agent tools** — targeted file range reads, codebase search, globbing, in-file replace, single-file patch application, and file system helpers for repo work
- **Per-run tool cache** — search, glob, and directory results are cached per run and auto-invalidated on writes to avoid redundant rescans
- **Agent run history** — sidebar shows past and active runs with status indicators and click-to-replay when in Agent mode
- **Plan-first approvals** — risky shell and file-changing actions now require a plan approval step before execution
- **Durable agent run APIs** — persisted run metadata plus event log streaming, cancel, and resume endpoints for longer-lived agent workflows
- **Renderer run recovery** — the desktop UI can reconnect to active runs, replay recent runs, and resume from max-step limits through the durable run API
- **Memory** — semantic memory using `nomic-embed-text` embeddings; auto-inject and auto-extract toggles; full memory manager with search, add, and clear
- Semantic memory search in the memory manager, with provenance like source type, extraction mode, and linked conversation/message metadata
- Auto-extracted memories save directly with provenance and deduplication, and replies can show which memories were used in context

### Voice & Audio
- **Voice input** — speech-to-text via Whisper *(requires Python + faster-whisper)*
- **Text-to-speech** — read responses aloud; choose between Browser (Web Speech API) or Kokoro engine; configurable voice selection

### Personas & Prompts
- System prompt editor with token counter
- Persona presets — save, edit, and switch between named system prompts
- Slash commands — custom prompt shortcuts with autocomplete (`/command`)

### Themes
- **Dark:** Default, Dracula, Tokyo Night, Catppuccin Mocha, Kanagawa, Rosé Pine, Nord, Night Owl, One Dark Pro
- **Light:** GitHub Light, Solarized Light, Catppuccin Latte, Kanagawa Lotus, Rosé Pine Dawn, Nord Light, Night Owl Light, One Light

### Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Send message | `Enter` / `Ctrl+Enter` |
| New chat | `Ctrl+N` |
| Delete conversation | `Ctrl+D` |
| Read last response aloud | `Ctrl+R` |
| Abort generation | `Esc` |
| Browse message history | `↑` / `↓` |
| Show shortcuts panel | `Ctrl+H` |
| Toggle voice input | `Alt+V` |
| Add file | `Ctrl+I` |
| Toggle web search | `Alt+W` |
| Toggle deep research | `Alt+R` |
| Toggle Agent workflow | `Alt+A` |
| Toggle memory | `Ctrl+M` |

---

## Installation

**Download the installer**
- Grab the latest Windows installer from [GitHub Releases](https://github.com/BorisHrzenjak/OllamaBrah/releases)

**Prerequisites**
- [Node.js](https://nodejs.org) v18+
- [Ollama](https://ollama.com) installed and running
- Python 3 *(optional — voice input only)*

**Run from source**
```bash
git clone https://github.com/BorisHrzenjak/ollama_brah.git
cd ollama_brah
npm install
npx electron-rebuild
npm start
```

> `electron-rebuild` is required because `better-sqlite3` is a native addon that must be compiled against Electron's bundled Node version. Skipping this step will cause a crash on startup.

**Run tests**
```bash
npm test
```

**Build a distributable**
```bash
npm run build
```
Produces a Windows installer in `/dist`.

**Publish a release**
```bash
git tag -a v1.5.2 -m "Your version notes here"
git push origin v1.5.2
```
The GitHub Actions release workflow builds the installer and uploads it to the matching GitHub Release automatically.

---

## Notes

- Ollama must be running before launching the app (`ollama serve`)
- If Ollama is running on a custom address, set `OLLAMA_API_BASE_URL` in `.env` to match it
- Pull at least one model first: `ollama pull <model-name>`
- The internal proxy runs on `localhost:3456` — make sure that port is free
- Memory feature requires the `nomic-embed-text` model: `ollama pull nomic-embed-text`
- Voice input requires: `pip install faster-whisper`
- First OCR use may take longer while English OCR assets are cached locally
