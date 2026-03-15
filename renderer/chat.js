document.addEventListener('DOMContentLoaded', async () => {
    // ─── Electron / Chrome API Shim ──────────────────────────────────────────
    const isElectron = typeof window.electronAPI !== 'undefined';
    let chrome;
    if (isElectron) {
        window.electronAPI.getAppVersion().then(v => { window._appVersion = v; });
        chrome = {
            storage: {
                local: {
                    get: async (keys, callback) => {
                        let result;
                        if (keys === null || keys === undefined) {
                            result = await window.electronAPI.store.getAll();
                        } else if (typeof keys === 'string') {
                            const val = await window.electronAPI.store.get(keys, undefined);
                            result = { [keys]: val };
                        } else if (Array.isArray(keys)) {
                            result = {};
                            for (const k of keys) {
                                result[k] = await window.electronAPI.store.get(k, undefined);
                            }
                        } else if (typeof keys === 'object') {
                            result = {};
                            for (const [k, def] of Object.entries(keys)) {
                                const val = await window.electronAPI.store.get(k, undefined);
                                result[k] = val !== undefined ? val : def;
                            }
                        } else {
                            result = {};
                        }
                        if (typeof callback === 'function') { callback(result); return undefined; }
                        return result;
                    },
                    set: async (obj) => {
                        for (const [k, v] of Object.entries(obj)) {
                            await window.electronAPI.store.set(k, v);
                        }
                    },
                    remove: async (keys) => {
                        const arr = Array.isArray(keys) ? keys : [keys];
                        for (const k of arr) {
                            await window.electronAPI.store.delete(k);
                        }
                    }
                }
            },
            runtime: {
                getManifest: () => ({ version: window._appVersion || '1.0.0' }),
                sendMessage: () => {},
                lastError: null
            }
        };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Set app version from manifest
    const appVersionEl = document.getElementById('appVersion');
    if (appVersionEl && chrome.runtime?.getManifest) {
        appVersionEl.textContent = `v${chrome.runtime.getManifest().version}`;
    }

    // Initialize Lucide icons
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    const PROXY_BASE = 'http://localhost:3456';

    const modelNameDisplay = document.getElementById('modelNameDisplay');
    const chatContainer = document.getElementById('chatContainer');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const loadingIndicator = document.getElementById('loadingIndicator');

    // Ensure loading indicator is hidden on initialization
    if (loadingIndicator) {
        loadingIndicator.style.display = 'none';
    }
    const clearChatButton = document.getElementById('clearChatButton');
    const exportChatButton = document.getElementById('exportChatButton');
    const modelSwitcherButton = document.getElementById('modelSwitcherButton');
    const modelSwitcherDropdown = document.getElementById('modelSwitcherDropdown');
    const conversationSidebar = document.getElementById('conversationSidebar');
    const newChatButton = document.getElementById('newChatButton');
    const collapseSidebarButton = document.getElementById('collapseSidebarButton');
    const conversationList = document.getElementById('conversationList');
    const conversationSearchInput = document.getElementById('conversationSearchInput');
    const clearSearchButton = document.getElementById('clearSearchButton');

    // Settings modal elements
    const settingsButton = document.getElementById('settingsButton');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsModalButton = document.getElementById('closeSettingsModal');
    const systemPromptInput = document.getElementById('systemPromptInput');
    const saveSystemPromptButton = document.getElementById('saveSystemPromptButton');
    const clearSystemPromptButton = document.getElementById('clearSystemPromptButton');
    const systemPromptTokenCount = document.getElementById('systemPromptTokenCount');
    const inputTokenCount = document.getElementById('inputTokenCount');
    const contextLimitInput = document.getElementById('contextLimitInput');
    const contextLimitInfo = document.getElementById('contextLimitInfo');

    // Clear context modal elements
    const clearContextModal = document.getElementById('clearContextModal');

    // Keyboard shortcuts modal elements
    const shortcutsModal = document.getElementById('shortcutsModal');
    const closeShortcutsModalButton = document.getElementById('closeShortcutsModal');
    const closeClearContextModalButton = document.getElementById('closeClearContextModal');
    const cancelClearContextButton = document.getElementById('cancelClearContextButton');
    const confirmClearContextButton = document.getElementById('confirmClearContextButton');

    // Context indicator elements
    const contextIndicator = document.getElementById('contextIndicator');
    const contextIndicatorText = document.getElementById('contextIndicatorText');

    // File upload elements
    const fileButton = document.getElementById('fileButton');
    const fileInput = document.getElementById('fileInput');
    const imagePreviewArea = document.getElementById('imagePreviewArea');
    const dragDropOverlay = document.getElementById('dragDropOverlay');
    const micButton = document.getElementById('micButton');
    const webSearchButton = document.getElementById('webSearchButton');

    // Web search state
    let webSearchEnabled = false;

    webSearchButton.addEventListener('click', () => {
        webSearchEnabled = !webSearchEnabled;
        webSearchButton.classList.toggle('active', webSearchEnabled);
        webSearchButton.title = webSearchEnabled ? 'Web Search: ON' : 'Web Search: OFF';
        // Disable deep research when web search is enabled (mutually exclusive)
        if (webSearchEnabled && deepResearchEnabled) {
            deepResearchEnabled = false;
            deepResearchButton.classList.remove('active');
            deepResearchButton.title = 'Deep Research: OFF';
        }
        // Disable agent mode when web search is enabled (mutually exclusive)
        if (webSearchEnabled && agentModeEnabled) {
            agentModeEnabled = false;
            agentModeButton.classList.remove('active');
            agentModeButton.title = 'Agent Mode: OFF';
        }
    });

    // Slash command state
    const SLASH_COMMANDS_KEY = 'slashCommands';
    const SLASH_COMMANDS_INIT_KEY = 'slashCommands_init';
    const DEFAULT_SLASH_COMMANDS = [
        { id: 'translate',  trigger: 'translate',  name: 'Translate',        body: 'Translate the following text to English:\n\n' },
        { id: 'summarize',  trigger: 'summarize',  name: 'Summarize',        body: 'Summarize the following in 3–5 concise bullet points:\n\n' },
        { id: 'fix-code',   trigger: 'fix-code',   name: 'Fix Code',         body: 'Find and fix any bugs in the following code. Explain what was wrong:\n\n' },
        { id: 'explain',    trigger: 'explain',    name: 'Explain',          body: 'Explain the following concept in simple, clear terms:\n\n' },
        { id: 'improve',    trigger: 'improve',    name: 'Improve Writing',  body: 'Improve the writing quality, clarity, and style of the following text:\n\n' },
        { id: 'eli5',       trigger: 'eli5',       name: 'ELI5',             body: "Explain this like I'm 5 years old:\n\n" },
        { id: 'brainstorm', trigger: 'brainstorm', name: 'Brainstorm',       body: 'Brainstorm 5–10 creative ideas for the following:\n\n' },
        { id: 'proofread',  trigger: 'proofread',  name: 'Proofread',        body: 'Proofread the following text for grammar, spelling, and punctuation errors:\n\n' },
    ];
    let slashCommands = [];
    let slashPopupFiltered = [];
    let slashPopupSelectedIndex = -1;
    const slashCommandPopup = document.getElementById('slashCommandPopup');

    // Deep research state
    const deepResearchButton = document.getElementById('deepResearchButton');
    let deepResearchEnabled = false;

    deepResearchButton.addEventListener('click', () => {
        deepResearchEnabled = !deepResearchEnabled;
        deepResearchButton.classList.toggle('active', deepResearchEnabled);
        deepResearchButton.title = deepResearchEnabled ? 'Deep Research: ON' : 'Deep Research: OFF';
        // Disable web search when deep research is enabled (mutually exclusive)
        if (deepResearchEnabled && webSearchEnabled) {
            webSearchEnabled = false;
            webSearchButton.classList.remove('active');
            webSearchButton.title = 'Web Search: OFF';
        }
        // Disable agent mode when deep research is enabled (mutually exclusive)
        if (deepResearchEnabled && agentModeEnabled) {
            agentModeEnabled = false;
            agentModeButton.classList.remove('active');
            agentModeButton.title = 'Agent Mode: OFF';
        }
    });

    // Agent mode state
    const agentModeButton = document.getElementById('agentModeButton');
    let agentModeEnabled = false;

    agentModeButton.addEventListener('click', () => {
        agentModeEnabled = !agentModeEnabled;
        agentModeButton.classList.toggle('active', agentModeEnabled);
        agentModeButton.title = agentModeEnabled ? 'Agent Mode: ON' : 'Agent Mode: OFF';
        if (agentModeEnabled) {
            if (webSearchEnabled) {
                webSearchEnabled = false;
                webSearchButton.classList.remove('active');
                webSearchButton.title = 'Web Search: OFF';
            }
            if (deepResearchEnabled) {
                deepResearchEnabled = false;
                deepResearchButton.classList.remove('active');
                deepResearchButton.title = 'Deep Research: OFF';
            }
        }
    });

    // Memory state
    const memoryButton = document.getElementById('memoryButton');
    let memoryEnabled = false;

    memoryButton.addEventListener('click', () => {
        memoryEnabled = !memoryEnabled;
        memoryButton.classList.toggle('active', memoryEnabled);
        memoryButton.title = memoryEnabled ? 'Memory: ON' : 'Memory: OFF';
    });

    // Keyword patterns that trigger auto-save to memory
    const MEMORY_SAVE_PATTERNS = [
        /\b(remember (that|this|the fact that)|please remember|note that)\b/i,
        /\bsave (this|that|it|the fact that)?\s*(to|in|into)?\s*(the\s+)?memory\b/i,
        /\bsave to (the\s+)?memory\b/i,
        /\b(store|add) (this|that|it)?\s*(to|in|into)\s*(my |your |the )?memory\b/i,
        /\badd to (my |your |the )?memory\b/i,
        /\b(don'?t forget (that|this)|keep in mind that)\b/i,
        /\bremember (me|this|that|my|for future)\b/i,
    ];

    function detectMemorySaveIntent(text) {
        return MEMORY_SAVE_PATTERNS.some(re => re.test(text));
    }

    // --- Agent step renderer helpers ---

    function createAgentStepBlock(type, name, argsObj) {
        const block = document.createElement('div');
        block.className = `agent-step-block agent-step-${type}`;

        const header = document.createElement('div');
        header.className = 'agent-step-header';

        const iconName = type === 'tool_call' ? 'wrench' : 'check-circle';
        const iconEl = document.createElement('span');
        iconEl.className = 'agent-step-icon';
        iconEl.innerHTML = `<i data-lucide="${iconName}"></i>`;

        const nameEl = document.createElement('span');
        nameEl.className = 'agent-step-name';
        nameEl.textContent = name;

        const statusEl = document.createElement('span');
        statusEl.className = 'agent-step-status';
        statusEl.textContent = type === 'tool_call' ? 'Running…' : 'Done';

        const chevronEl = document.createElement('span');
        chevronEl.className = 'agent-step-chevron';
        chevronEl.innerHTML = '<i data-lucide="chevron-right"></i>';

        header.append(iconEl, nameEl, statusEl, chevronEl);

        const body = document.createElement('div');
        body.className = 'agent-step-body';

        if (argsObj && Object.keys(argsObj).length > 0) {
            const pre = document.createElement('pre');
            pre.className = 'agent-step-args';
            pre.textContent = JSON.stringify(argsObj, null, 2);
            body.appendChild(pre);
        }

        header.addEventListener('click', () => {
            const expanded = body.classList.toggle('expanded');
            header.classList.toggle('expanded', expanded);
        });

        block.append(header, body);
        if (typeof lucide !== 'undefined') lucide.createIcons({ el: block });

        return block;
    }

    function appendResultToStepBlock(block, result, isError) {
        const statusEl = block.querySelector('.agent-step-status');
        if (statusEl) statusEl.textContent = isError ? 'Error' : 'Done';

        const body = block.querySelector('.agent-step-body');
        if (!body) return;

        const resultPre = document.createElement('pre');
        resultPre.className = 'agent-step-result' + (isError ? ' error' : '');
        resultPre.textContent = String(result).slice(0, 2000);
        body.appendChild(resultPre);

        // Auto-expand on error
        if (isError) {
            body.classList.add('expanded');
            block.querySelector('.agent-step-header').classList.add('expanded');
        }
    }

    function createPermissionCard(chunk) {
        const riskColors = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444', critical: '#dc2626' };
        const borderColor = riskColors[chunk.risk] || '#f59e0b';
        const FILE_TOOLS = new Set(['readFile', 'writeFile', 'listDirectory', 'findFiles', 'deleteFile']);
        const isFileTool = FILE_TOOLS.has(chunk.tool);

        const card = document.createElement('div');
        card.className = 'agent-permission-card';
        card.style.borderColor = borderColor;

        const args = chunk.args || {};
        const argsLines = Object.entries(args)
            .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
            .join('\n');

        const header = document.createElement('div');
        header.className = 'agent-perm-header';

        const headerIcon = document.createElement('span');
        headerIcon.className = 'agent-perm-icon';
        const iconEl = document.createElement('i');
        iconEl.setAttribute('data-lucide', 'shield-alert');
        headerIcon.appendChild(iconEl);

        const headerTool = document.createElement('span');
        headerTool.className = 'agent-perm-tool';
        headerTool.textContent = chunk.tool;

        const headerRisk = document.createElement('span');
        headerRisk.className = 'agent-perm-risk';
        headerRisk.textContent = `[${chunk.risk || 'confirm'}]`;
        // Only apply color if it matches a safe CSS color value
        if (/^#[0-9a-fA-F]{3,8}$|^[a-z]+$/i.test(borderColor)) {
            headerRisk.style.color = borderColor;
        }

        header.append(headerIcon, headerTool, headerRisk);
        card.appendChild(header);

        if (argsLines) {
            const argsPre = document.createElement('pre');
            argsPre.className = 'agent-perm-args';
            argsPre.textContent = argsLines;
            card.appendChild(argsPre);
        }

        const btnRow = document.createElement('div');
        btnRow.className = 'agent-perm-buttons';

        const allowBtn = document.createElement('button');
        allowBtn.className = 'agent-perm-allow';
        allowBtn.textContent = 'Allow once';

        const sessionBtn = document.createElement('button');
        sessionBtn.className = 'agent-perm-session';
        sessionBtn.textContent = 'Allow session';

        const denyBtn = document.createElement('button');
        denyBtn.className = 'agent-perm-deny';
        denyBtn.textContent = 'Deny';

        if (isFileTool) {
            const pathBtn = document.createElement('button');
            pathBtn.className = 'agent-perm-path';
            pathBtn.textContent = 'Allow folder';
            btnRow.append(allowBtn, sessionBtn, pathBtn, denyBtn);

            if (typeof lucide !== 'undefined') lucide.createIcons({ el: card });

            const respond = async (approved, scope) => {
                [allowBtn, sessionBtn, pathBtn, denyBtn].forEach(b => b.disabled = true);
                clearInterval(countdownInterval);
                try {
                    await fetch(`${PROXY_BASE}/api/agent/permission`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: chunk.id, approved, scope })
                    });
                    const label = !approved ? '✗ Denied' : scope === 'session' ? '✓ Allowed (session)' : scope === 'path' ? '✓ Allowed (folder)' : '✓ Allowed';
                    btnRow.innerHTML = `<span class="agent-perm-result">${label}</span>`;
                    countdownEl.remove();
                } catch (e) {
                    console.warn('[Agent] Permission POST failed:', e);
                    [allowBtn, sessionBtn, pathBtn, denyBtn].forEach(b => b.disabled = false);
                    const errSpan = document.createElement('span');
                    errSpan.className = 'agent-perm-result';
                    errSpan.style.color = 'var(--error-text)';
                    errSpan.textContent = '⚠ Request failed — try again';
                    btnRow.appendChild(errSpan);
                }
            };
            allowBtn.addEventListener('click', () => respond(true, 'once'));
            sessionBtn.addEventListener('click', () => respond(true, 'session'));
            pathBtn.addEventListener('click', () => respond(true, 'path'));
            denyBtn.addEventListener('click', () => respond(false, 'once'));
        } else {
            btnRow.append(allowBtn, sessionBtn, denyBtn);

            if (typeof lucide !== 'undefined') lucide.createIcons({ el: card });

            const respond = async (approved, scope) => {
                [allowBtn, sessionBtn, denyBtn].forEach(b => b.disabled = true);
                clearInterval(countdownInterval);
                try {
                    await fetch(`${PROXY_BASE}/api/agent/permission`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: chunk.id, approved, scope })
                    });
                    const label = !approved ? '✗ Denied' : scope === 'session' ? '✓ Allowed (session)' : '✓ Allowed';
                    btnRow.innerHTML = `<span class="agent-perm-result">${label}</span>`;
                    countdownEl.remove();
                } catch (e) {
                    console.warn('[Agent] Permission POST failed:', e);
                    [allowBtn, sessionBtn, denyBtn].forEach(b => b.disabled = false);
                    const errSpan = document.createElement('span');
                    errSpan.className = 'agent-perm-result';
                    errSpan.style.color = 'var(--error-text)';
                    errSpan.textContent = '⚠ Request failed — try again';
                    btnRow.appendChild(errSpan);
                }
            };
            allowBtn.addEventListener('click', () => respond(true, 'once'));
            sessionBtn.addEventListener('click', () => respond(true, 'session'));
            denyBtn.addEventListener('click', () => respond(false, 'once'));
        }

        card.appendChild(btnRow);

        // Countdown — silent for first 4 minutes, visible in final 60 seconds
        const countdownEl = document.createElement('div');
        countdownEl.className = 'agent-perm-countdown';
        card.appendChild(countdownEl);
        const TIMEOUT_SEC = 300;
        let remaining = TIMEOUT_SEC;
        const countdownInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(countdownInterval);
                countdownEl.textContent = 'Auto-denied';
                countdownEl.classList.add('urgent');
                return;
            }
            if (remaining <= 60) {
                const m = Math.floor(remaining / 60);
                const s = String(remaining % 60).padStart(2, '0');
                countdownEl.textContent = `Auto-denies in ${m}:${s}`;
                countdownEl.classList.toggle('urgent', remaining <= 15);
            } else {
                countdownEl.textContent = '';
            }
        }, 1000);

        return card;
    }

    async function handleAgentStream(botTextElement, botMessageDiv, reader) {
        const decoder = new TextDecoder();
        let buf = '';
        let currentContentDiv = null;
        let currentContentText = '';
        let lastToolCallBlock = {}; // toolName → last block element
        let savedMessagesForContinue = null;

        // Step counter line
        const counterEl = document.createElement('span');
        counterEl.className = 'agent-step-counter';
        counterEl.textContent = 'Agent running…';
        botTextElement.appendChild(counterEl);

        function renderContinueButtons(savedMessages) {
            const row = document.createElement('div');
            row.className = 'agent-continue-row';
            for (const extraSteps of [5, 15]) {
                const btn = document.createElement('button');
                btn.className = 'agent-continue-btn';
                btn.textContent = `Continue (+${extraSteps} steps)`;
                btn.onclick = async () => {
                    row.remove();
                    currentContentDiv = null;
                    currentContentText = '';
                    try {
                        const resp = await fetch(`${PROXY_BASE}/api/agent/chat`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: currentModelName,
                                backend: currentModelBackend,
                                maxSteps: extraSteps,
                                continueFrom: savedMessages
                            })
                        });
                        if (!resp.ok) throw new Error(`Agent API Error: ${resp.status}`);
                        const contReader = resp.body.getReader();
                        const contText = await handleAgentStream(botTextElement, botMessageDiv, contReader);
                        if (contText) currentContentText = contText;
                    } catch (e) {
                        const errDiv = document.createElement('div');
                        errDiv.className = 'agent-error';
                        errDiv.textContent = 'Continue failed: ' + e.message;
                        botTextElement.appendChild(errDiv);
                    }
                };
                row.appendChild(btn);
            }
            botTextElement.appendChild(row);
        }

        const processAgentChunk = (chunk) => {
            if (chunk.type === 'keepalive') return;

            if (chunk.type === 'content' && chunk.text) {
                if (!currentContentDiv) {
                    currentContentDiv = document.createElement('div');
                    currentContentDiv.className = 'agent-content-block';
                    botTextElement.appendChild(currentContentDiv);
                }
                currentContentText += chunk.text;
                currentContentDiv.innerHTML = '';
                currentContentDiv.appendChild(renderMarkdownWithThinking(currentContentText, false));
            }

            if (chunk.type === 'tool_call') {
                currentContentDiv = null;
                currentContentText = '';
                const block = createAgentStepBlock('tool_call', chunk.name, chunk.args);
                block.dataset.toolName = chunk.name;
                botTextElement.appendChild(block);
                lastToolCallBlock[chunk.name] = block;
            }

            if (chunk.type === 'tool_result') {
                const block = lastToolCallBlock[chunk.name];
                if (block) {
                    appendResultToStepBlock(block, chunk.result, chunk.error);
                    // Change block class to show result type
                    block.classList.remove('agent-step-tool_call');
                    block.classList.add('agent-step-tool_result');
                }
            }

            if (chunk.type === 'permission_request') {
                currentContentDiv = null;
                currentContentText = '';
                const card = createPermissionCard(chunk);
                botTextElement.appendChild(card);
            }

            if (chunk.type === 'context_compressed') {
                const note = document.createElement('div');
                note.className = 'agent-context-compressed';
                const kb = n => Math.round(n / 1000) + 'k';
                note.textContent = `↯ Context compressed at step ${chunk.step} — ${kb(chunk.tokensBefore)} → ${kb(chunk.tokensAfter)} tokens`;
                botTextElement.appendChild(note);
            }

            if (chunk.type === 'tool_running') {
                const block = lastToolCallBlock[chunk.name];
                if (block) {
                    const statusEl = block.querySelector('.agent-step-status');
                    if (statusEl) statusEl.textContent = 'Executing…';
                }
            }

            if (chunk.type === 'step_done') {
                counterEl.textContent = `Step ${chunk.step} / ${chunk.maxSteps}`;
            }

            if (chunk.type === 'max_steps_reached') {
                savedMessagesForContinue = chunk.messages;
            }

            if (chunk.type === 'error') {
                const errDiv = document.createElement('div');
                errDiv.className = 'agent-error';
                errDiv.textContent = 'Agent error: ' + chunk.text;
                botTextElement.appendChild(errDiv);
            }

            if (chunk.type === 'done') {
                counterEl.textContent = '';
                if (savedMessagesForContinue) {
                    renderContinueButtons(savedMessagesForContinue);
                }
                return true; // signal caller to stop
            }

            chatContainer.scrollTop = chatContainer.scrollHeight;
            return false;
        };

        let streamDone = false;
        while (!streamDone) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                let chunk;
                try { chunk = JSON.parse(line); } catch { continue; }
                if (processAgentChunk(chunk)) { streamDone = true; break; }
            }
        }

        // Flush any bytes remaining in the TextDecoder and process trailing data
        buf += decoder.decode();
        for (const line of buf.split('\n')) {
            if (!line.trim()) continue;
            let chunk;
            try { chunk = JSON.parse(line); } catch { continue; }
            processAgentChunk(chunk);
        }

        return currentContentText;
    }

    // Speech Recognition Setup (local Whisper via proxy)
    let isListening = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let whisperReady = false;
    let headerChunk = null;       // first WebM chunk contains the container header
    let interimTranscript = '';   // running transcript shown in the preview
    let lastTranscribePromise = null; // track in-flight transcription
    const voicePreviewEl = document.getElementById('voicePreview');

    function setMicState(listening) {
        isListening = listening;
        if (!micButton) return;
        if (listening) {
            micButton.classList.add('listening');
            micButton.innerHTML = createLucideIcon('mic-off', 20).outerHTML;
            micButton.title = 'Stop Recording';
        } else {
            micButton.classList.remove('listening');
            micButton.innerHTML = createLucideIcon('mic', 20).outerHTML;
            micButton.title = 'Voice Input';
        }
    }

    function showVoicePreview(text) {
        if (!voicePreviewEl) return;
        voicePreviewEl.textContent = text || '🎙 Listening…';
        voicePreviewEl.style.display = 'block';
    }

    function hideVoicePreview() {
        if (!voicePreviewEl) return;
        voicePreviewEl.style.display = 'none';
        voicePreviewEl.textContent = '';
    }

    async function transcribeBlob(blob) {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        const r = await fetch(`${PROXY_BASE}/api/stt/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: base64, format: 'webm' })
        });
        const data = await r.json();
        return data.text || '';
    }

    async function ensureWhisperReady() {
        try {
            const r = await fetch(`${PROXY_BASE}/api/stt/status`);
            const s = await r.json();
            if (s.status === 'ready') { whisperReady = true; return true; }
            if (s.status === 'loading') return false;
        } catch { /* proxy not up */ }

        micButton.title = 'Loading Whisper…';
        micButton.innerHTML = createLucideIcon('loader', 20).outerHTML;
        try {
            const r = await fetch(`${PROXY_BASE}/api/stt/load`, { method: 'POST' });
            const s = await r.json();
            if (s.status === 'ready' || s.ok) { whisperReady = true; return true; }
        } catch (e) {
            console.error('[STT] Failed to start Whisper:', e);
        }
        setMicState(false);
        alert('Could not start the Whisper server.\n\nMake sure you have installed:\n  pip install faster-whisper flask');
        return false;
    }

    async function startRecording() {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            alert('Microphone access denied. Please allow microphone access and restart the app.');
            return;
        }

        audioChunks = [];
        headerChunk = null;
        interimTranscript = '';
        lastTranscribePromise = null;

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : '';
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

        mediaRecorder.ondataavailable = async (e) => {
            if (e.data.size === 0) return;
            audioChunks.push(e.data);

            if (!headerChunk) {
                // First chunk is the WebM initialization segment — save it as the
                // container header so later chunks can be decoded independently.
                headerChunk = e.data;
                showVoicePreview('');
                return;
            }

            // Transcribe this ~3-second chunk prefixed with the WebM header
            const chunkBlob = new Blob([headerChunk, e.data],
                { type: mediaRecorder.mimeType || 'audio/webm' });
            lastTranscribePromise = transcribeBlob(chunkBlob).then(text => {
                if (text) {
                    interimTranscript += (interimTranscript ? ' ' : '') + text;
                    showVoicePreview(interimTranscript);
                }
            }).catch(err => console.error('[STT] Chunk transcription error:', err));
        };

        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            // Wait for any in-flight chunk transcription to finish
            if (lastTranscribePromise) await lastTranscribePromise.catch(() => {});

            hideVoicePreview();

            if (interimTranscript) {
                if (messageInput.value && !/\s$/.test(messageInput.value))
                    messageInput.value += ' ';
                messageInput.value += interimTranscript;
                messageInput.dispatchEvent(new Event('input'));
            }
            setMicState(false);
        };

        // Fire ondataavailable every 3 seconds for rolling preview
        mediaRecorder.start(3000);
        setMicState(true);
        showVoicePreview('');
    }

    if (micButton) {
        micButton.addEventListener('click', async () => {
            if (isListening) {
                if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
                return;
            }
            if (!whisperReady) {
                const ready = await ensureWhisperReady();
                if (!ready) return;
            }
            await startRecording();
        });
    }

    let currentModelName = '';
    let sidebarSearchQuery = '';
    let sidebarTagFilter = '';
    const storageKeyPrefix = 'ollamaBroChat_';
    const sidebarStateKey = 'ollamaBroSidebarState';
    const draftsKey = 'ollamaBroDrafts';
    const personaPresetsKey = 'ollamaBroPersonaPresets';

    let activePersonaName = '';

    const DEFAULT_PRESETS = [
        {
            id: 'default-code-reviewer',
            name: 'Code Reviewer',
            prompt: 'You are an expert code reviewer. Analyze code for bugs, performance issues, security vulnerabilities, and style violations. Provide clear, actionable feedback with specific suggestions for improvement.'
        },
        {
            id: 'default-translator',
            name: 'Translator',
            prompt: 'You are a professional translator. Translate text accurately while preserving tone, nuance, and cultural context. If the target language is not specified, ask before translating.'
        },
        {
            id: 'default-tutor',
            name: 'Tutor',
            prompt: 'You are a patient and encouraging tutor. Explain concepts clearly using simple language and relatable examples. Break down complex topics step by step. Ask clarifying questions to tailor explanations to the student\'s level.'
        },
        {
            id: 'default-storyteller',
            name: 'Storyteller',
            prompt: 'You are a creative storyteller. Craft vivid, engaging narratives with compelling characters and immersive descriptions. Adapt your style and tone to match the genre and mood requested.'
        }
    ];
    // Store available models as objects with name and size
    let availableModels = [];
    let llamaCppModels = []; // [{name, path, size}] — from /api/llamacpp/models
    let currentModelBackend = 'ollama'; // 'ollama' | 'llamacpp'
    let currentLlamaCppPath = null;
    let currentAbortController = null; // Track current request for aborting
    let selectedFiles = []; // Store selected files (images and documents) for sending

    // Context management constants
    const DEFAULT_CONTEXT_LIMIT = 4096;   // 4K — local models
    const CLOUD_CONTEXT_LIMIT = 131072;   // 128K — cloud models
    const MAX_MESSAGES_PER_CONVERSATION = 200;
    const MAX_VISIBLE_MESSAGES = 50;
    const WARNING_THRESHOLD = 0.75; // 75% - yellow
    const CRITICAL_THRESHOLD = 0.90; // 90% - red

    // Smart scrolling state
    let isUserScrolledUp = false;
    let scrollThreshold = 100; // pixels from bottom to consider "at bottom"
    let isStreaming = false;
    let showFullHistory = false;

    // Smart scroll functions
    function isNearBottom() {
        const scrollPosition = chatContainer.scrollTop + chatContainer.clientHeight;
        const scrollHeight = chatContainer.scrollHeight;
        return scrollHeight - scrollPosition <= scrollThreshold;
    }

    function scrollToBottom(force = false) {
        if (force || !isUserScrolledUp) {
            chatContainer.scrollTo({
                top: chatContainer.scrollHeight,
                behavior: 'smooth'
            });
        }
    }

    function handleScroll() {
        const wasScrolledUp = isUserScrolledUp;
        isUserScrolledUp = !isNearBottom();

        // Show/hide scroll to bottom button
        const scrollButton = document.getElementById('scrollToBottomButton');
        if (scrollButton) {
            scrollButton.style.display = isUserScrolledUp ? 'flex' : 'none';
        }

        // If user scrolls down to bottom during streaming, resume auto-scroll
        if (wasScrolledUp && !isUserScrolledUp && isStreaming) {
            scrollToBottom(true);
        }
    }

    // Draft persistence functions
    async function saveDraft(conversationId, text) {
        if (!chrome.storage || !chrome.storage.local) return;
        try {
            const drafts = await chrome.storage.local.get(draftsKey);
            const draftData = drafts[draftsKey] || {};
            draftData[conversationId] = {
                text: text,
                timestamp: Date.now()
            };
            await chrome.storage.local.set({ [draftsKey]: draftData });
        } catch (error) {
            console.error('Error saving draft:', error);
        }
    }

    async function loadDraft(conversationId) {
        if (!chrome.storage || !chrome.storage.local) return '';
        try {
            const drafts = await chrome.storage.local.get(draftsKey);
            const draftData = drafts[draftsKey] || {};
            const draft = draftData[conversationId];
            return draft ? draft.text : '';
        } catch (error) {
            console.error('Error loading draft:', error);
            return '';
        }
    }

    async function clearDraft(conversationId) {
        if (!chrome.storage || !chrome.storage.local) return;
        try {
            const drafts = await chrome.storage.local.get(draftsKey);
            const draftData = drafts[draftsKey] || {};
            delete draftData[conversationId];
            await chrome.storage.local.set({ [draftsKey]: draftData });
        } catch (error) {
            console.error('Error clearing draft:', error);
        }
    }

    // Helper function to create Lucide icons as SVG
    function createLucideIcon(iconName, size = 16) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', size);
        svg.setAttribute('height', size);
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        // Define icon paths
        const icons = {
            'copy': '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
            'file-down': '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/>',
            'file-code': '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><polyline points="9 13 11 15 9 17"/><polyline points="15 13 13 15 15 17"/>',
            'square': '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>',
            'trash-2': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
            'brain': '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>',
            'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
            'eye': '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
            'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
            'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
            'x': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
            'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
            'trash': '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
            'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
            'audio-lines': '<path d="M2 10v4"/><path d="M6 6v12"/><path d="M10 3v18"/><path d="M14 6v12"/><path d="M18 10v4"/><path d="M22 10v4"/>',
            'volume-x': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
            'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
            'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
            'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
            'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
            'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
            'activity': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
            'flame': '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
            'cpu': '<rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
            'mic': '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
            'mic-off': '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/>',
            'mic': '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
            'mic-off': '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/>',
            'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
            'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
            'search-check': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="m9 11 2 2 4-4"/>'
        };

        if (icons[iconName]) {
            svg.innerHTML = icons[iconName];
        } else {
            // Fallback to a simple circle if icon not found
            svg.innerHTML = '<circle cx="12" cy="12" r="10"/>';
        }

        return svg;
    }

    // Token estimation functions
    function estimateTokens(text) {
        if (!text || typeof text !== 'string') return 0;
        // Approximate BPE tokenization using the GPT-2/LLaMA pretokenization regex
        // (same pattern used by tiktoken/minbpe before the actual BPE encoding step).
        // Handles contractions, numbers, punctuation, and whitespace absorption correctly.
        // Exact counting would require shipping the full BPE vocab table (~5MB).
        const GPT2_PATTERN = /'(?:[sdmt]|ll|ve|re)| ?\w+| ?\d+| ?[^\s\w]+|\s+(?!\S)|\s+/gi;
        const pieces = text.match(GPT2_PATTERN) || [];
        // Each piece is 1 BPE token for common/short words; rare or long pieces split ~every 4 chars.
        return pieces.reduce((sum, p) => {
            const len = p.trimStart().length;
            return sum + (len <= 8 ? 1 : Math.ceil(len / 4));
        }, 0);
    }

    function getConversationTokenCount(messages) {
        if (!Array.isArray(messages)) return 0;
        return messages.reduce((total, msg) => {
            const contentTokens = estimateTokens(msg.content || '');
            // Add overhead for message structure (role, etc.)
            return total + contentTokens + 4;
        }, 0);
    }

    function formatTokenCount(count) {
        if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}k tokens`;
        }
        return `${count} tokens`;
    }

    async function updateContextIndicator(messages, systemPrompt = '', modelData = null) {
        const messageTokens = getConversationTokenCount(messages);
        const systemPromptTokens = estimateTokens(systemPrompt);
        const totalTokens = messageTokens + systemPromptTokens;

        // Get effective context limit
        const effectiveLimit = getEffectiveContextLimit(currentModelName, modelData);
        const isCloud = isCloudModel(currentModelName);
        const hasOverride = modelData && modelData.contextLimitOverride && modelData.contextLimitOverride > 0;

        // Update text
        contextIndicatorText.textContent = formatTokenCount(totalTokens);

        // Calculate percentage
        const usagePercent = ((totalTokens / effectiveLimit) * 100).toFixed(1);

        // Build enhanced tooltip
        let tooltipText = `📊 Context Usage: ${formatTokenCount(totalTokens)} / ${formatContextLimit(effectiveLimit)} (${usagePercent}%)\n\n`;
        tooltipText += `Messages: ${formatTokenCount(messageTokens)}\n`;
        if (systemPromptTokens > 0) {
            tooltipText += `System prompt: ${formatTokenCount(systemPromptTokens)}\n`;
        }
        tooltipText += `\n`;

        if (isCloud) {
            tooltipText += `Context window: ${formatContextLimit(effectiveLimit)} (cloud model)\n`;
            tooltipText += `Context window varies by model. Cloud models typically support\n`;
            tooltipText += `128K-1M tokens. Check ollama.com/library/${currentModelName} for specifics.\n\n`;
        } else {
            tooltipText += `Context window: ${formatContextLimit(effectiveLimit)} (local model)\n`;
            tooltipText += `Default context window for local models is 4K tokens.\n`;
            tooltipText += `You can increase this when running Ollama with --ctx-size flag.\n\n`;
        }

        if (hasOverride) {
            tooltipText += `💡 Custom limit set. Visit Settings to change.\n`;
        } else {
            tooltipText += `💡 Tip: Click Settings to set a custom context limit.`;
        }

        contextIndicator.title = tooltipText;

        // Update color based on usage
        const usageRatio = totalTokens / effectiveLimit;
        contextIndicator.classList.remove('warning', 'critical');

        if (usageRatio >= CRITICAL_THRESHOLD) {
            contextIndicator.classList.add('critical');
        } else if (usageRatio >= WARNING_THRESHOLD) {
            contextIndicator.classList.add('warning');
        }
    }

    function makeCloudBadge(size = 14) {
        const span = document.createElement('span');
        span.className = 'cloud-icon cap-badge';
        span.title = 'Cloud model';
        span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="#3b82f6" viewBox="0 0 16 16"><path d="M4.406 3.342A5.53 5.53 0 0 1 8 2c2.69 0 4.923 2 5.166 4.579C14.758 6.804 16 8.137 16 9.773 16 11.569 14.502 13 12.687 13H3.781C1.708 13 0 11.366 0 9.318c0-1.763 1.266-3.223 2.942-3.593.143-.863.698-1.723 1.464-2.383z"/></svg>`;
        return span;
    }

    // Cloud model detection
    function isCloudModel(modelName) {
        if (!modelName || typeof modelName !== 'string') return false;

        // Pattern 1: :cloud or .cloud tag in name (Ollama cloud models use :cloud)
        if (modelName.includes(':cloud') || modelName.includes('.cloud')) return true;

        // Pattern 2: Check if model has size 0 (cloud models don't occupy local storage)
        const model = availableModels.find(m => m.name === modelName);
        if (model && (model.size === 0 || model.size === undefined || model.size === null)) {
            return true;
        }

        return false;
    }

    // Get effective context limit for current model
    function getEffectiveContextLimit(modelName, modelData) {
        // Check for user override
        if (modelData && modelData.contextLimitOverride && modelData.contextLimitOverride > 0) {
            return modelData.contextLimitOverride;
        }

        // Auto-detect based on model type
        if (isCloudModel(modelName)) {
            return CLOUD_CONTEXT_LIMIT; // 131072 (128K)
        }

        return DEFAULT_CONTEXT_LIMIT; // 4096 (4K)
    }

    // Format context limit for display
    function formatContextLimit(limit) {
        if (limit >= 1000) {
            return `${(limit / 1000).toFixed(0)}k`;
        }
        return `${limit}`;
    }

    function toggleFileUploadUI(show) {
        if (fileButton) {
            fileButton.style.display = show ? 'flex' : 'none';
        }
    }

    function updateModelDisplay(modelName) {
        // Clear previous content
        modelNameDisplay.innerHTML = '';

        // Create container for text
        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.gap = '6px';

        // Add model name text
        const textSpan = document.createElement('span');
        textSpan.textContent = `Chatting with: ${decodeURIComponent(modelName)}`;
        container.appendChild(textSpan);

        // Add cloud icon for cloud models
        if (isCloudModel(modelName)) {
            container.appendChild(makeCloudBadge(14));
        }

        modelNameDisplay.appendChild(container);
    }

    function getModelStorageKey(model) {
        const key = `${storageKeyPrefix}${model.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
        console.log('[OllamaBro] getModelStorageKey - Model:', model, 'Generated Key:', key);
        return key;
    }

    async function loadModelChatState(modelToLoad) {
        console.log('[OllamaBro] loadModelChatState - Attempting to load for model:', modelToLoad);
        if (!chrome.storage || !chrome.storage.local) {
            console.warn('Chrome storage API not available.');
            return { conversations: {}, activeConversationId: null, systemPrompt: '', contextLimitOverride: null, params: null };
        }
        try {
            const key = getModelStorageKey(modelToLoad); // Key generation will also log
            const storageResult = await chrome.storage.local.get(key);
            console.log('[OllamaBro] loadModelChatState - Key used:', key, 'Data loaded from storage:', storageResult);

            let modelSpecificData = storageResult[key];
            let needsSave = false;

            if (modelSpecificData && typeof modelSpecificData === 'object') {
                // Data exists and is an object, proceed with checks
                // Ensure a deep copy for logging to avoid showing mutated object if it's referenced elsewhere
                try {
                    console.log(`Raw chat state loaded for ${modelToLoad}:`, JSON.parse(JSON.stringify(modelSpecificData)));
                } catch (e) {
                    console.warn(`[OllamaBro] loadModelChatState - Could not stringify modelSpecificData for logging for model ${modelToLoad}:`, modelSpecificData);
                }

                if (typeof modelSpecificData.conversations !== 'object' || modelSpecificData.conversations === null) {
                    modelSpecificData.conversations = {};
                    needsSave = true;
                }
                if (typeof modelSpecificData.activeConversationId === 'undefined') {
                    modelSpecificData.activeConversationId = null;
                    needsSave = true;
                }
                if (typeof modelSpecificData.systemPrompt === 'undefined') {
                    modelSpecificData.systemPrompt = '';
                    needsSave = true;
                }
                if (typeof modelSpecificData.contextLimitOverride === 'undefined') {
                    modelSpecificData.contextLimitOverride = null;
                    needsSave = true;
                }
                if (typeof modelSpecificData.params === 'undefined') {
                    modelSpecificData.params = null;
                    needsSave = true;
                }

                // Save back to storage if we initialized any missing fields
                if (needsSave) {
                    console.log(`[OllamaBro] loadModelChatState - Migrating old data for ${modelToLoad} with new fields`);
                    await chrome.storage.local.set({ [key]: modelSpecificData });
                }

                return modelSpecificData;
            } else if (modelSpecificData) {
                // Data exists but is NOT an object (e.g., string, number, boolean due to corruption)
                console.warn(`[OllamaBro] loadModelChatState - Data for model ${modelToLoad} is not an object:`, modelSpecificData, ". Resetting to default structure.");
                return { conversations: {}, activeConversationId: null, systemPrompt: '', contextLimitOverride: null, params: null }; // Return default structure
            }
            // modelSpecificData is null or undefined (no data for this key)
            console.log(`[OllamaBro] loadModelChatState - No data found for ${modelToLoad}. Returning default structure.`);
            return { conversations: {}, activeConversationId: null, systemPrompt: '', contextLimitOverride: null, params: null }; // Default if nothing stored
        } catch (error) {
            console.error('Error loading chat state:', error);
            return { conversations: {}, activeConversationId: null, systemPrompt: '', contextLimitOverride: null, params: null };
        }
    }

    function trimConversationMessages(conversation) {
        if (!conversation?.messages) return;
        if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
            conversation.messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
        }
    }

    async function saveModelChatState(modelToSave, modelData) {
        console.log('[OllamaBro] saveModelChatState - Attempting to save for model:', modelToSave, 'Data:', modelData);
        if (!chrome.storage || !chrome.storage.local) {
            console.warn('Chrome storage API not available.');
            return;
        }
        // Trim oversized conversations before persisting
        if (modelData?.conversations) {
            Object.values(modelData.conversations).forEach(trimConversationMessages);
        }
        try {
            const key = getModelStorageKey(modelToSave); // Key generation will also log
            await chrome.storage.local.set({ [key]: modelData });
            console.log('[OllamaBro] saveModelChatState - Key used:', key, 'Save successful.');
            console.log(`Chat state saved for ${modelToSave}`);
        } catch (error) {
            console.error('Error saving chat state:', error);
        }
    }

    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function getConversationSummary(messages) {
        if (!messages || messages.length === 0) return 'New Chat';
        const firstUserMessage = messages.find(msg => msg.role === 'user');
        return firstUserMessage ? firstUserMessage.content.substring(0, 40) : 'Chat'; // Max 40 chars for summary
    }

    function getCurrentConversationMessages(modelData) {
        if (modelData && modelData.activeConversationId && modelData.conversations && modelData.conversations[modelData.activeConversationId]) {
            return modelData.conversations[modelData.activeConversationId].messages || [];
        }
        return [];
    }

    function generateFilename(extension, modelName, messages) {
        const now = new Date();
        const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
        const summary = getConversationSummary(messages).replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 30) || 'chat';
        const cleanModelName = modelName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
        return `${summary}_${cleanModelName}_${timestamp}.${extension}`;
    }

    async function copyToClipboard(text, buttonElement) {
        try {
            await navigator.clipboard.writeText(text);
            if (buttonElement) {
                const originalInnerHTML = buttonElement.innerHTML;
                buttonElement.textContent = 'Copied!';
                buttonElement.disabled = true;
                setTimeout(() => {
                    buttonElement.innerHTML = originalInnerHTML;
                    buttonElement.disabled = false;
                }, 1500);
            }
        } catch (err) {
            console.error('Failed to copy text: ', err);
            if (buttonElement) {
                const originalInnerHTML = buttonElement.innerHTML;
                buttonElement.textContent = 'Error';
                setTimeout(() => {
                    buttonElement.innerHTML = originalInnerHTML;
                }, 1500);
            }
        }
    }

    function downloadMessage(text, filename, mimeType) {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async function exportConversation() {
        const modelData = await loadModelChatState(currentModelName);
        const messages = getCurrentConversationMessages(modelData);

        if (messages.length === 0) {
            alert('No messages to export.');
            return;
        }

        const lines = [];
        lines.push(`# Conversation with ${decodeURIComponent(currentModelName)}`);
        lines.push(`Exported: ${new Date().toLocaleString()}`);
        lines.push('');

        messages.forEach(msg => {
            const sender = msg.role === 'user' ? '## You' : `## ${decodeURIComponent(currentModelName)}`;
            lines.push(sender);
            lines.push('');
            lines.push(msg.content);
            lines.push('');
        });

        const markdownContent = lines.join('\n');
        const filename = generateFilename('md', currentModelName, messages);
        downloadMessage(markdownContent, filename, 'text/markdown;charset=utf-8');
    }

    function renderMarkdownWithThinking(text, isStreaming = false) {
        if (typeof text !== 'string' || text === null) text = '';

        // Parse think blocks - Deepseek R1 uses <think> tags
        // Support variations: <think>, <think >, </think>, </think >
        const thinkRegex = /<\s*think[^>]*>([\s\S]*?)<\/\s*think\s*>/gi;
        let thinkBlocks = [];

        // First, extract all think blocks and replace with placeholders
        let processedText = text.replace(thinkRegex, (match, content) => {
            const index = thinkBlocks.length;
            thinkBlocks.push(content.trim());
            console.log(`[Thinking] Found think block #${index}, length: ${content.length}`);
            // Use a special span that won't be affected by markdown/DOMPurify
            return `<span class="thinking-placeholder" data-index="${index}"></span>`;
        });

        console.log(`[Thinking] Total think blocks found: ${thinkBlocks.length}`);

        // Render markdown on the text (now without think blocks)
        let htmlContent;
        if (typeof marked !== 'undefined') {
            htmlContent = marked.parse(processedText, {
                breaks: true,
                gfm: true
            });
        } else {
            htmlContent = processedText;
        }

        // Sanitize - but keep our thinking-placeholder spans
        if (typeof DOMPurify !== 'undefined') {
            htmlContent = DOMPurify.sanitize(htmlContent, {
                ADD_ATTR: ['data-index'],
                ADD_TAGS: ['span']
            });
        }

        const container = document.createElement('div');
        container.innerHTML = htmlContent;

        // Replace thinking placeholders with actual thinking boxes
        const placeholders = container.querySelectorAll('.thinking-placeholder');
        console.log(`[Thinking] Placeholders found in DOM: ${placeholders.length}`);

        placeholders.forEach(placeholder => {
            const index = parseInt(placeholder.getAttribute('data-index'));
            if (thinkBlocks[index]) {
                console.log(`[Thinking] Creating box for block #${index}`);
                const thinkingBox = createThinkingBoxElement(thinkBlocks[index], isStreaming);
                placeholder.replaceWith(thinkingBox);
            } else {
                console.warn(`[Thinking] No content for block #${index}`);
            }
        });

        // Add copy buttons to code blocks
        container.querySelectorAll('pre').forEach(pre => {
            pre.style.position = 'relative';
            const code = pre.querySelector('code');

            if (code) {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'code-copy-button';
                copyBtn.textContent = 'Copy';
                copyBtn.addEventListener('click', async () => {
                    await navigator.clipboard.writeText(code.textContent);
                    copyBtn.textContent = 'Copied!';
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.textContent = 'Copy';
                        copyBtn.classList.remove('copied');
                    }, 2000);
                });
                pre.appendChild(copyBtn);
            }
        });

        // Apply syntax highlighting (skip thinking boxes)
        if (typeof hljs !== 'undefined') {
            container.querySelectorAll('pre code').forEach(block => {
                // Skip if inside thinking box
                if (!block.closest('.thinking-content')) {
                    hljs.highlightElement(block);
                }
            });
        }

        const fragment = document.createDocumentFragment();
        fragment.appendChild(container);
        return fragment;
    }

    function createThinkingBoxElement(content, isStreaming = false) {
        const container = document.createElement('div');
        container.className = 'thinking-container';

        const toggle = document.createElement('div');
        toggle.className = 'thinking-toggle';

        const brainIcon = createLucideIcon('brain', 16);
        brainIcon.className = 'thinking-icon';

        const indicator = document.createElement('span');
        indicator.className = 'thinking-indicator';
        indicator.textContent = isStreaming ? 'Thinking...' : 'Show thinking';

        const chevronIcon = createLucideIcon('chevron-right', 14);
        chevronIcon.className = 'thinking-chevron';

        toggle.appendChild(brainIcon);
        toggle.appendChild(indicator);
        toggle.appendChild(chevronIcon);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'thinking-content';

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = content;
        pre.appendChild(code);
        contentDiv.appendChild(pre);

        // Auto-expand if streaming
        if (isStreaming) {
            contentDiv.classList.add('expanded');
            toggle.classList.add('expanded');
        }

        toggle.addEventListener('click', () => {
            const isExpanded = contentDiv.classList.contains('expanded');
            contentDiv.classList.toggle('expanded');
            toggle.classList.toggle('expanded');
            indicator.textContent = isExpanded ? 'Show thinking' : 'Hide thinking';
        });

        container.appendChild(toggle);
        container.appendChild(contentDiv);

        return container;
    }

    // Collapse all expanded thinking boxes from previous bot messages
    function collapsePreviousThinkingBoxes() {
        // Find all thinking containers in the chat
        const allThinkingContainers = document.querySelectorAll('.thinking-container');
        allThinkingContainers.forEach(container => {
            const contentDiv = container.querySelector('.thinking-content');
            const toggle = container.querySelector('.thinking-toggle');
            const indicator = container.querySelector('.thinking-indicator');

            // Only collapse if currently expanded
            if (contentDiv && contentDiv.classList.contains('expanded')) {
                contentDiv.classList.remove('expanded');
                toggle.classList.remove('expanded');
                indicator.textContent = 'Show thinking';
            }
        });
    }

    // File processing functions
    const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const SUPPORTED_TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css', 'application/json', 'application/javascript'];
    const CODE_EXTENSIONS = ['.py', '.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.css', '.md', '.sql', '.sh', '.bash', '.yml', '.yaml', '.xml', '.txt', '.log', '.csv', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala'];
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

    function isImageFile(file) {
        return SUPPORTED_IMAGE_TYPES.includes(file.type);
    }

    function isTextFile(file) {
        const extension = '.' + file.name.split('.').pop().toLowerCase();
        return file.type.startsWith('text/') || 
               file.type === 'application/json' || 
               file.type === 'application/javascript' ||
               CODE_EXTENSIONS.includes(extension);
    }

    function validateFile(file) {
        const isImage = isImageFile(file);
        const isText = isTextFile(file);

        if (!isImage && !isText) {
            const ext = file.name.split('.').pop().toLowerCase();
            throw new Error(`Unsupported file type: .${ext}. Supported: images (JPEG, PNG, GIF, WebP) and text/code files`);
        }

        if (file.size > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${(file.size / (1024 * 1024)).toFixed(1)}MB. Maximum size: 10MB`);
        }

        return true;
    }

    async function extractTextContent(file) {
        try {
            return await file.text();
        } catch (error) {
            console.error('Error extracting text from file:', error);
            throw new Error(`Failed to read file content: ${error.message}`);
        }
    }

    async function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                // Remove the data:image/...;base64, prefix
                const base64String = reader.result.split(',')[1];
                resolve(base64String);
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    async function compressImage(file, maxWidth = 1024, maxHeight = 1024, quality = 0.8) {
        return new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
                // Calculate new dimensions while maintaining aspect ratio
                let { width, height } = img;
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width *= ratio;
                    height *= ratio;
                }

                canvas.width = width;
                canvas.height = height;

                // Draw and compress
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(resolve, file.type, quality);
            };

            img.onerror = () => reject(new Error('Failed to load image for compression'));
            img.src = URL.createObjectURL(file);
        });
    }

    async function processFileForUpload(file) {
        try {
            validateFile(file);

            const isImage = isImageFile(file);
            const isText = isTextFile(file);

            const result = {
                fileName: file.name,
                fileSize: file.size,
                mimeType: file.type,
                fileType: isImage ? 'image' : 'document'
            };

            if (isImage) {
                // Compress if the image is large
                let processedFile = file;
                if (file.size > 2 * 1024 * 1024) {
                    processedFile = await compressImage(file);
                }

                result.base64 = await fileToBase64(processedFile);
                result.previewUrl = URL.createObjectURL(processedFile);
                result.fileSize = processedFile.size;
            } else if (isText) {
                // Extract text content for documents
                result.textContent = await extractTextContent(file);
            }

            return result;
        } catch (error) {
            console.error('Error processing file:', error);
            throw error;
        }
    }

    function addFileToPreview(fileData, index) {
        const previewDiv = document.createElement('div');
        previewDiv.className = fileData.fileType === 'image' ? 'image-preview' : 'file-preview';
        previewDiv.dataset.index = index;

        if (fileData.fileType === 'image') {
            // Image preview with thumbnail
            const img = document.createElement('img');
            img.src = fileData.previewUrl;
            img.alt = fileData.fileName;
            previewDiv.appendChild(img);
        } else {
            // Document preview with icon and filename
            const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="file-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
            previewDiv.innerHTML = iconSvg;
            
            const fileInfo = document.createElement('div');
            fileInfo.className = 'file-info';
            
            const fileName = document.createElement('div');
            fileName.className = 'file-name';
            fileName.textContent = fileData.fileName;
            fileName.title = fileData.fileName;
            
            const fileSize = document.createElement('div');
            fileSize.className = 'file-size';
            fileSize.textContent = formatFileSize(fileData.fileSize);
            
            fileInfo.appendChild(fileName);
            fileInfo.appendChild(fileSize);
            previewDiv.appendChild(fileInfo);
        }

        const removeButton = document.createElement('button');
        removeButton.className = 'remove-image';
        removeButton.innerHTML = '×';
        removeButton.title = 'Remove file';
        removeButton.addEventListener('click', () => removeFileFromPreview(index));

        previewDiv.appendChild(removeButton);
        imagePreviewArea.appendChild(previewDiv);

        updatePreviewAreaVisibility();
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function removeFileFromPreview(index) {
        // Clean up the preview URL to prevent memory leaks
        if (selectedFiles[index] && selectedFiles[index].previewUrl) {
            URL.revokeObjectURL(selectedFiles[index].previewUrl);
        }

        selectedFiles.splice(index, 1);
        refreshFilePreview();
    }

    function refreshFilePreview() {
        imagePreviewArea.innerHTML = '';
        selectedFiles.forEach((fileData, index) => {
            addFileToPreview(fileData, index);
        });
        updatePreviewAreaVisibility();
    }

    function updatePreviewAreaVisibility() {
        if (selectedFiles.length > 0) {
            imagePreviewArea.style.display = 'flex';
        } else {
            imagePreviewArea.style.display = 'none';
        }
    }

    function clearSelectedFiles() {
        // Clean up preview URLs
        selectedFiles.forEach(fileData => {
            if (fileData.previewUrl) {
                URL.revokeObjectURL(fileData.previewUrl);
            }
        });
        selectedFiles = [];
        imagePreviewArea.innerHTML = '';
        updatePreviewAreaVisibility();
    }

    async function handleFileUpload(files) {
        for (const file of files) {
            try {
                const fileData = await processFileForUpload(file);
                selectedFiles.push(fileData);
                addFileToPreview(fileData, selectedFiles.length - 1);
            } catch (error) {
                alert(`Error processing file "${file.name}": ${error.message}`);
            }
        }
    }

    function addMessageToChatUI(sender, initialText, messageClass, modelDataForFilename, attachments = null, messageIndex = -1) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', messageClass);

        // Sender name (You or Model Name)
        const senderDiv = document.createElement('div');
        senderDiv.classList.add('message-sender');
        senderDiv.textContent = sender;
        messageDiv.appendChild(senderDiv);

        // Add attachments if present (for user messages)
        if (attachments && attachments.length > 0) {
            const attachmentsContainer = document.createElement('div');
            attachmentsContainer.classList.add('message-attachments');
            
            // Separate images and documents
            const images = attachments.filter(a => a.type === 'image' || (a.base64 && a.mimeType?.startsWith('image/')));
            const documents = attachments.filter(a => a.type === 'document' || (a.textContent && !a.base64));

            // Render images
            if (images.length > 0) {
                const imagesDiv = document.createElement('div');
                imagesDiv.classList.add('message-images');
                images.forEach(imageData => {
                    const img = document.createElement('img');
                    img.src = `data:${imageData.mimeType || imageData.fileType};base64,${imageData.base64}`;
                    img.alt = imageData.fileName || 'Uploaded image';
                    img.classList.add('message-image');
                    imagesDiv.appendChild(img);
                });
                attachmentsContainer.appendChild(imagesDiv);
            }

            // Render document attachments
            if (documents.length > 0) {
                const documentsDiv = document.createElement('div');
                documentsDiv.classList.add('message-documents');
                documents.forEach(doc => {
                    const docDiv = document.createElement('div');
                    docDiv.className = 'message-document';
                    
                    const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
                    docDiv.innerHTML = iconSvg;
                    
                    const fileName = document.createElement('span');
                    fileName.className = 'document-filename';
                    fileName.textContent = doc.fileName;
                    fileName.title = doc.fileName;
                    
                    docDiv.appendChild(fileName);
                    documentsDiv.appendChild(docDiv);
                });
                attachmentsContainer.appendChild(documentsDiv);
            }

            messageDiv.appendChild(attachmentsContainer);
        }

        // Message text content wrapper
        const textContentDiv = document.createElement('div');
        textContentDiv.classList.add('message-text-content');
        if (messageClass === 'bot-message') {
            const textToParse = (initialText === null || typeof initialText === 'undefined') ? '' : String(initialText);
            const fragment = renderMarkdownWithThinking(textToParse);
            textContentDiv.appendChild(fragment);
            textContentDiv.dataset.fullMessage = textToParse;
        } else {
            textContentDiv.textContent = initialText;
        }
        messageDiv.appendChild(textContentDiv);

        if (messageClass === 'user-message' && messageIndex >= 0) {
            const actionsDiv = document.createElement('div');
            actionsDiv.classList.add('message-actions');
            const editButton = document.createElement('button');
            editButton.classList.add('action-button', 'edit-button');
            editButton.title = 'Edit message';
            editButton.appendChild(createLucideIcon('pencil', 16));
            editButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isStreaming) return;
                enterEditMode(messageDiv, textContentDiv, messageIndex);
            });
            actionsDiv.appendChild(editButton);
            messageDiv.appendChild(actionsDiv);
        }

        if (messageClass === 'bot-message') {
            const actionsDiv = document.createElement('div');
            actionsDiv.classList.add('message-actions');

            // Copy Button
            const copyButton = document.createElement('button');
            copyButton.classList.add('action-button', 'copy-button');
            copyButton.title = 'Copy to clipboard';
            copyButton.appendChild(createLucideIcon('copy', 16));

            copyButton.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent message click if any
                copyToClipboard(textContentDiv.textContent, copyButton);
            });
            actionsDiv.appendChild(copyButton);

            // Download TXT Button
            const downloadTxtButton = document.createElement('button');
            downloadTxtButton.classList.add('action-button', 'download-txt-button');
            downloadTxtButton.title = 'Download as .txt';
            downloadTxtButton.appendChild(createLucideIcon('file-down', 16));

            downloadTxtButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                const currentMessages = getCurrentConversationMessages(await loadModelChatState(currentModelName));
                const filename = generateFilename('txt', currentModelName, currentMessages);
                downloadMessage(textContentDiv.textContent, filename, 'text/plain;charset=utf-8');
            });
            actionsDiv.appendChild(downloadTxtButton);

            // Download MD Button
            const downloadMdButton = document.createElement('button');
            downloadMdButton.classList.add('action-button', 'download-md-button');
            downloadMdButton.title = 'Download as .md';
            downloadMdButton.appendChild(createLucideIcon('file-code', 16));

            downloadMdButton.addEventListener('click', async (e) => {
                e.stopPropagation();
                const currentMessages = getCurrentConversationMessages(await loadModelChatState(currentModelName));
                const filename = generateFilename('md', currentModelName, currentMessages);
                // Basic MD: just the text. Could be enhanced to include sender.
                const mdContent = `## ${sender}\n\n${textContentDiv.textContent}`;
                downloadMessage(mdContent, filename, 'text/markdown;charset=utf-utf-8');
            });
            actionsDiv.appendChild(downloadMdButton);

            // Stop Button (only show during streaming)
            const stopButton = document.createElement('button');
            stopButton.classList.add('action-button', 'stop-button');
            stopButton.title = 'Stop generation';
            stopButton.style.display = 'none'; // Hidden by default
            stopButton.appendChild(createLucideIcon('square', 16));

            stopButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentAbortController) {
                    currentAbortController.abort();
                    stopButton.style.display = 'none';
                }
            });
            actionsDiv.appendChild(stopButton);

            // TTS Button
            const ttsButton = document.createElement('button');
            ttsButton.classList.add('action-button', 'tts-button');
            ttsButton.title = 'Read aloud';
            ttsButton.appendChild(createLucideIcon('audio-lines', 16));

            ttsButton.addEventListener('click', (e) => {
                e.stopPropagation();
                speakText(textContentDiv, ttsButton);
            });
            actionsDiv.appendChild(ttsButton);

            // Store reference to stop button for later use
            messageDiv.stopButton = stopButton;

            messageDiv.appendChild(actionsDiv);

            // Add metadata display if available
        }

        chatContainer.appendChild(messageDiv);
        scrollToBottom(true); // Force scroll on new message

        // Store reference to messageDiv for later use (e.g., adding metadata)
        textContentDiv.messageDiv = messageDiv;

        return textContentDiv; // Return the element where text is displayed for streaming
    }

    function updateBotMessageInUI(botTextElement, newContentChunk, streaming = false) {
        const previousRawFullText = botTextElement.dataset.fullMessage || '';
        const currentRawFullText = previousRawFullText + newContentChunk;

        // Debug: Log if we see think tags in the content
        if (newContentChunk.includes('<think') || newContentChunk.includes('</think>')) {
            console.log('[Thinking] Received chunk with think tag:', newContentChunk.substring(0, 100));
        }

        botTextElement.innerHTML = '';
        const fragment = renderMarkdownWithThinking(currentRawFullText, streaming);
        botTextElement.appendChild(fragment);

        botTextElement.dataset.fullMessage = currentRawFullText;

        // Only auto-scroll if user hasn't scrolled up
        scrollToBottom(false);
    }

    // Helper function to add metadata to an existing message
    function addMetadataToMessage(messageDiv, metadata) {
        if (!metadata || (!metadata.tokens && !metadata.promptTokens)) return;

        // Check if metadata already exists
        if (messageDiv.querySelector('.message-metadata')) return;

        const metadataDiv = document.createElement('div');
        metadataDiv.className = 'message-metadata';

        // Format metadata items with titles for tooltips
        const items = [];

        if (metadata.tokens) {
            items.push({
                icon: 'type',
                text: `${metadata.tokens}`,
                title: `Output tokens: ${metadata.tokens} tokens generated in the response`
            });
        }

        if (metadata.promptTokens) {
            items.push({
                icon: 'message-square',
                text: `${metadata.promptTokens}`,
                title: `Prompt tokens: ${metadata.promptTokens} tokens in the input/prompt`
            });
        }

        if (metadata.thinkingTokens) {
            items.push({
                icon: 'brain',
                text: `${metadata.thinkingTokens}`,
                title: `Thinking tokens: ~${metadata.thinkingTokens} tokens in the reasoning/thinking section`
            });
        }

        if (metadata.speed !== null && metadata.speed !== undefined && metadata.speed !== '0.0') {
            items.push({
                icon: 'zap',
                text: `${metadata.speed}`,
                title: `Generation speed: ${metadata.speed} tokens per second`
            });
        }

        if (metadata.duration) {
            items.push({
                icon: 'clock',
                text: `${metadata.duration}s`,
                title: `Generation time: ${metadata.duration} seconds to generate the response`
            });
        }

        items.forEach((item, index) => {
            const itemSpan = document.createElement('span');
            itemSpan.className = 'metadata-item';
            itemSpan.title = item.title;
            itemSpan.appendChild(createLucideIcon(item.icon, 12));
            const textSpan = document.createElement('span');
            textSpan.textContent = item.text;
            itemSpan.appendChild(textSpan);
            metadataDiv.appendChild(itemSpan);

            // Add divider between items
            if (index < items.length - 1) {
                const divider = document.createElement('span');
                divider.className = 'metadata-divider';
                divider.textContent = '·';
                metadataDiv.appendChild(divider);
            }
        });

        messageDiv.appendChild(metadataDiv);
    }

    async function displayConversationMessages(modelData, conversationId) {
        chatContainer.innerHTML = ''; // Clear current messages
        let messages = [];

        if (modelData.conversations[conversationId] && modelData.conversations[conversationId].messages) {
            messages = modelData.conversations[conversationId].messages;
            const totalMessages = messages.length;
            const startIndex = showFullHistory ? 0 : Math.max(0, totalMessages - MAX_VISIBLE_MESSAGES);

            if (startIndex > 0) {
                const loadMoreBtn = document.createElement('button');
                loadMoreBtn.className = 'load-more-messages-btn';
                loadMoreBtn.textContent = `↑ Load ${startIndex} earlier message${startIndex === 1 ? '' : 's'}`;
                loadMoreBtn.addEventListener('click', () => {
                    showFullHistory = true;
                    displayConversationMessages(modelData, conversationId);
                });
                chatContainer.appendChild(loadMoreBtn);
            }

            messages.slice(startIndex).forEach((msg, i) => {
                // Handle both old (images) and new (attachments) format for backward compatibility
                let attachments = msg.attachments;
                if (!attachments && msg.images) {
                    // Convert old images format to new attachments format
                    attachments = msg.images.map(img => ({
                        type: 'image',
                        base64: img.base64,
                        fileName: img.fileName,
                        fileSize: img.fileSize,
                        mimeType: img.fileType
                    }));
                }
                const textContentDiv = addMessageToChatUI(
                    msg.role === 'user' ? 'You' : currentModelName,
                    msg.content,
                    msg.role === 'user' ? 'user-message' : 'bot-message',
                    modelData,
                    attachments,
                    startIndex + i
                );

                // Add metadata to existing bot messages that have it stored
                if (msg.role === 'assistant' && msg.metadata && textContentDiv && textContentDiv.messageDiv) {
                    addMetadataToMessage(textContentDiv.messageDiv, msg.metadata);
                }
            });
        } else {
            addMessageToChatUI(currentModelName, `Hello! Start a new conversation with ${decodeURIComponent(currentModelName)}.`, 'bot-message', modelData);
        }

        // Update context indicator
        await updateContextIndicator(messages, modelData.systemPrompt, modelData);
        updateRegenerateButton();
    }

    async function startNewConversation(modelForNewChat = currentModelName) {
        console.log(`Starting new conversation for model: ${modelForNewChat}`);

        // Save current draft before switching
        const currentModelData = await loadModelChatState(modelForNewChat);
        if (currentModelData.activeConversationId && messageInput.value.trim()) {
            await saveDraft(currentModelData.activeConversationId, messageInput.value);
        }

        let modelData = await loadModelChatState(modelForNewChat);
        const newConversationId = generateUUID();
        modelData.conversations[newConversationId] = {
            id: newConversationId,
            messages: [],
            summary: 'New Chat',
            lastMessageTime: Date.now()
        };
        modelData.activeConversationId = newConversationId;
        await saveModelChatState(modelForNewChat, modelData);
        showFullHistory = false;
        displayConversationMessages(modelData, newConversationId);
        populateConversationSidebar(modelForNewChat, modelData);

        // Clear input and draft for new conversation
        messageInput.value = '';
        autoResizeInput();
        await clearDraft(newConversationId);
        messageInput.focus();
        return newConversationId;
    }

    async function switchActiveConversation(modelToSwitch, newConversationId) {
        console.log(`Switching to conversation ${newConversationId} for model ${modelToSwitch}`);

        // Save current draft before switching
        let currentModelData = await loadModelChatState(modelToSwitch);
        if (currentModelData.activeConversationId && messageInput.value.trim()) {
            await saveDraft(currentModelData.activeConversationId, messageInput.value);
        }

        let modelData = await loadModelChatState(modelToSwitch);
        if (modelData.conversations[newConversationId]) {
            modelData.activeConversationId = newConversationId;
            await saveModelChatState(modelToSwitch, modelData);
            showFullHistory = false;
            displayConversationMessages(modelData, newConversationId);
            populateConversationSidebar(modelToSwitch, modelData); // Refresh sidebar to highlight active

            // Load draft for the new conversation
            const draftText = await loadDraft(newConversationId);
            messageInput.value = draftText || '';
        } else {
            console.warn(`Conversation ${newConversationId} not found for model ${modelToSwitch}. Starting new one.`);
            await startNewConversation(modelToSwitch);
        }
        messageInput.focus();
    }

    async function handleDeleteConversation(modelOfConversation, conversationIdToDelete) {
        if (!confirm('Are you sure you want to delete this conversation? This action cannot be undone.')) {
            return;
        }
        console.log(`Deleting conversation ${conversationIdToDelete} for model ${modelOfConversation}`);
        let modelData = await loadModelChatState(modelOfConversation);
        if (modelData.conversations[conversationIdToDelete]) {
            delete modelData.conversations[conversationIdToDelete];
            if (modelData.activeConversationId === conversationIdToDelete) {
                modelData.activeConversationId = null;
                const remainingConvIds = Object.keys(modelData.conversations);
                if (remainingConvIds.length > 0) {
                    // Switch to the most recent remaining conversation
                    const sortedRemaining = remainingConvIds.map(id => modelData.conversations[id])
                        .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
                    modelData.activeConversationId = sortedRemaining[0].id;
                    await saveModelChatState(modelOfConversation, modelData);
                    switchActiveConversation(modelOfConversation, modelData.activeConversationId);
                } else {
                    await saveModelChatState(modelOfConversation, modelData); // Save cleared activeId
                    await startNewConversation(modelOfConversation); // No convs left, start a new one
                }
            } else {
                await saveModelChatState(modelOfConversation, modelData);
                populateConversationSidebar(modelOfConversation, modelData); // Just refresh sidebar if deleted conv wasn't active
            }
        } else {
            console.warn(`Conversation ${conversationIdToDelete} not found for deletion.`);
        }
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function highlightMatch(text, query) {
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return escapeHtml(text);
        return escapeHtml(text.slice(0, idx))
            + `<mark class="search-highlight">${escapeHtml(text.slice(idx, idx + query.length))}</mark>`
            + escapeHtml(text.slice(idx + query.length));
    }

    function getMatchSnippet(messages, query) {
        const q = query.toLowerCase();
        for (const msg of messages) {
            if (typeof msg.content !== 'string') continue;
            const idx = msg.content.toLowerCase().indexOf(q);
            if (idx === -1) continue;
            const start = Math.max(0, idx - 30);
            const end = Math.min(msg.content.length, idx + query.length + 60);
            const snippet = (start > 0 ? '…' : '') + msg.content.slice(start, end) + (end < msg.content.length ? '…' : '');
            return { snippet, matchIdx: idx - start + (start > 0 ? 1 : 0) };
        }
        return null;
    }

    // --- Tagging ---

    function getAllTags(modelData) {
        if (!modelData?.conversations) return [];
        const tagSet = new Set();
        Object.values(modelData.conversations).forEach(conv => (conv.tags || []).forEach(t => tagSet.add(t)));
        return [...tagSet].sort();
    }

    const tagFilterBar = document.getElementById('tagFilterBar');

    function renderTagFilterBar(modelData) {
        const allTags = getAllTags(modelData);
        tagFilterBar.innerHTML = '';
        if (allTags.length === 0) {
            tagFilterBar.classList.remove('has-tags');
            return;
        }
        tagFilterBar.classList.add('has-tags');
        allTags.forEach(tag => {
            const pill = document.createElement('button');
            pill.className = 'tag-filter-pill' + (sidebarTagFilter === tag ? ' active' : '');
            pill.textContent = '#' + tag;
            pill.addEventListener('click', async () => {
                sidebarTagFilter = sidebarTagFilter === tag ? '' : tag;
                const md = await loadModelChatState(currentModelName);
                renderTagFilterBar(md);
                populateConversationSidebar(currentModelName, md);
            });
            tagFilterBar.appendChild(pill);
        });
    }

    let activeTagPopover = null;

    function closeTagPopover() {
        if (activeTagPopover) {
            activeTagPopover.remove();
            activeTagPopover = null;
        }
    }

    function openTagEditor(convId, anchorEl, modelData) {
        closeTagPopover();
        const conv = modelData.conversations[convId];
        if (!conv) return;

        const popover = document.createElement('div');
        popover.className = 'tag-editor-popover';

        const input = document.createElement('input');
        input.className = 'tag-editor-input';
        input.placeholder = 'New tag name…';
        input.type = 'text';

        const existingDiv = document.createElement('div');
        existingDiv.className = 'tag-editor-existing';

        const hint = document.createElement('div');
        hint.className = 'tag-editor-hint';
        hint.textContent = 'Press Enter to add · click tag to remove';

        const refreshPills = () => {
            existingDiv.innerHTML = '';
            (conv.tags || []).forEach(tag => {
                const pill = document.createElement('span');
                pill.className = 'tag-editor-pill';
                pill.innerHTML = `#${escapeHtml(tag)} <span style="font-size:9px;opacity:0.7">×</span>`;
                pill.title = 'Remove tag';
                pill.addEventListener('click', async () => {
                    conv.tags = (conv.tags || []).filter(t => t !== tag);
                    if (sidebarTagFilter === tag) sidebarTagFilter = '';
                    await saveModelChatState(currentModelName, modelData);
                    refreshPills();
                    const md = await loadModelChatState(currentModelName);
                    renderTagFilterBar(md);
                    populateConversationSidebar(currentModelName, md);
                });
                existingDiv.appendChild(pill);
            });
        };
        refreshPills();

        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = input.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                if (val && !(conv.tags || []).includes(val)) {
                    conv.tags = [...(conv.tags || []), val];
                    await saveModelChatState(currentModelName, modelData);
                    refreshPills();
                    const md = await loadModelChatState(currentModelName);
                    renderTagFilterBar(md);
                    populateConversationSidebar(currentModelName, md);
                }
                input.value = '';
            } else if (e.key === 'Escape') {
                closeTagPopover();
            }
        });

        popover.appendChild(input);
        popover.appendChild(existingDiv);
        popover.appendChild(hint);
        document.body.appendChild(popover);
        activeTagPopover = popover;

        // Position below the anchor button
        const rect = anchorEl.getBoundingClientRect();
        popover.style.top = (rect.bottom + 6) + 'px';
        const left = Math.min(rect.left, window.innerWidth - 248);
        popover.style.left = Math.max(4, left) + 'px';

        input.focus();

        setTimeout(() => {
            document.addEventListener('click', function handler(e) {
                if (!popover.contains(e.target) && e.target !== anchorEl) {
                    closeTagPopover();
                    document.removeEventListener('click', handler);
                }
            });
        }, 0);
    }

    function populateConversationSidebar(modelForSidebar, modelData) {
        conversationList.innerHTML = '';
        if (!modelData || !modelData.conversations) return;

        renderTagFilterBar(modelData);

        let sortedConversations = Object.values(modelData.conversations)
            .sort((a, b) => b.lastMessageTime - a.lastMessageTime);

        // Apply search filter
        if (sidebarSearchQuery) {
            const q = sidebarSearchQuery.toLowerCase();
            sortedConversations = sortedConversations.filter(conv => {
                if ((conv.summary || '').toLowerCase().includes(q)) return true;
                return conv.messages && conv.messages.some(
                    msg => typeof msg.content === 'string' && msg.content.toLowerCase().includes(q)
                );
            });
        }

        // Apply tag filter
        if (sidebarTagFilter) {
            sortedConversations = sortedConversations.filter(conv =>
                (conv.tags || []).includes(sidebarTagFilter)
            );
        }

        if ((sidebarSearchQuery || sidebarTagFilter) && sortedConversations.length === 0) {
            const empty = document.createElement('div');
            empty.id = 'noSearchResults';
            empty.textContent = 'No matching chats';
            conversationList.appendChild(empty);
            return;
        }

        const q = sidebarSearchQuery;
        sortedConversations.forEach(conv => {
            const item = document.createElement('div');
            item.classList.add('conversation-item');
            item.dataset.conversationId = conv.id;
            if (conv.id === modelData.activeConversationId) item.classList.add('active');

            const summary = conv.summary || 'Chat';

            // Title
            const titleSpan = document.createElement('span');
            titleSpan.classList.add('conversation-item-title');
            titleSpan.title = summary;
            if (q) {
                titleSpan.innerHTML = highlightMatch(summary, q);
            } else {
                titleSpan.textContent = summary;
            }

            // Text column
            const textCol = document.createElement('div');
            textCol.className = 'conv-text-col';
            textCol.appendChild(titleSpan);

            // Snippet (search hit in message body, not title)
            if (q && !summary.toLowerCase().includes(q.toLowerCase())) {
                const match = getMatchSnippet(conv.messages || [], q);
                if (match) {
                    const snippetSpan = document.createElement('span');
                    snippetSpan.classList.add('conversation-item-snippet');
                    snippetSpan.innerHTML = highlightMatch(match.snippet, q);
                    textCol.appendChild(snippetSpan);
                }
            }

            // Tag pills
            const tags = conv.tags || [];
            if (tags.length > 0) {
                const tagsRow = document.createElement('div');
                tagsRow.className = 'conv-tags-row';
                tags.forEach(tag => {
                    const pill = document.createElement('span');
                    pill.className = 'conv-tag-pill';
                    pill.textContent = '#' + tag;
                    tagsRow.appendChild(pill);
                });
                textCol.appendChild(tagsRow);
            }

            // Tag button
            const tagButton = document.createElement('button');
            tagButton.className = 'tag-button';
            tagButton.title = 'Edit tags';
            tagButton.appendChild(createLucideIcon('tag', 12));

            // Delete button
            const deleteButton = document.createElement('button');
            deleteButton.classList.add('delete-conversation-button');
            deleteButton.appendChild(createLucideIcon('trash-2', 14));
            deleteButton.title = 'Delete chat';
            deleteButton.dataset.conversationId = conv.id;

            item.appendChild(textCol);
            item.appendChild(tagButton);
            item.appendChild(deleteButton);
            conversationList.appendChild(item);

            item.addEventListener('click', (e) => {
                if (deleteButton.contains(e.target) || tagButton.contains(e.target)) return;
                switchActiveConversation(modelForSidebar, conv.id);
            });
            tagButton.addEventListener('click', (e) => {
                e.stopPropagation();
                openTagEditor(conv.id, tagButton, modelData);
            });
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteConversation(modelForSidebar, conv.id);
            });
        });
    }

    // --- Model Parameter Functions ---

    function setupParamSync(sliderId, numberId, defaultVal) {
        const slider = document.getElementById(sliderId);
        const number = document.getElementById(numberId);
        if (!slider || !number) return;
        slider.addEventListener('input', () => {
            number.value = slider.value;
        });
        number.addEventListener('input', () => {
            if (number.value === '') {
                slider.value = defaultVal;
            } else {
                const val = parseFloat(number.value);
                if (!isNaN(val)) {
                    slider.value = Math.min(parseFloat(slider.max), Math.max(parseFloat(slider.min), val));
                }
            }
        });
    }

    function loadParamInputs(params) {
        const p = params || {};
        const setSliderAndNumber = (sliderId, numberId, val, defaultVal) => {
            const slider = document.getElementById(sliderId);
            const number = document.getElementById(numberId);
            if (slider) slider.value = (val != null) ? val : defaultVal;
            if (number) number.value = (val != null) ? val : '';
        };
        setSliderAndNumber('paramTemperatureSlider', 'paramTemperature', p.temperature ?? null, 0.8);
        setSliderAndNumber('paramTopPSlider', 'paramTopP', p.top_p ?? null, 0.9);
        setSliderAndNumber('paramTopKSlider', 'paramTopK', p.top_k ?? null, 40);
        setSliderAndNumber('paramRepeatPenaltySlider', 'paramRepeatPenalty', p.repeat_penalty ?? null, 1.1);
        const numPredict = document.getElementById('paramNumPredict');
        if (numPredict) numPredict.value = (p.num_predict != null) ? p.num_predict : '';
        const seed = document.getElementById('paramSeed');
        if (seed) seed.value = (p.seed != null) ? p.seed : '';
    }

    function collectParams() {
        const getFloat = (id) => {
            const el = document.getElementById(id);
            if (!el || el.value === '') return null;
            const v = parseFloat(el.value);
            return isNaN(v) ? null : v;
        };
        const getInt = (id) => {
            const el = document.getElementById(id);
            if (!el || el.value === '') return null;
            const v = parseInt(el.value, 10);
            return isNaN(v) ? null : v;
        };
        const params = {};
        const temperature = getFloat('paramTemperature');
        const top_p = getFloat('paramTopP');
        const top_k = getInt('paramTopK');
        const repeat_penalty = getFloat('paramRepeatPenalty');
        const num_predict = getInt('paramNumPredict');
        const seed = getInt('paramSeed');
        if (temperature != null) params.temperature = temperature;
        if (top_p != null) params.top_p = top_p;
        if (top_k != null) params.top_k = top_k;
        if (repeat_penalty != null) params.repeat_penalty = repeat_penalty;
        if (num_predict != null) params.num_predict = num_predict;
        if (seed != null && seed !== 0) params.seed = seed;
        return Object.keys(params).length > 0 ? params : null;
    }

    function resetParamInputs() {
        ['paramTemperature', 'paramTopP', 'paramTopK', 'paramRepeatPenalty', 'paramNumPredict', 'paramSeed'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const sliderDefaults = { paramTemperatureSlider: 0.8, paramTopPSlider: 0.9, paramTopKSlider: 40, paramRepeatPenaltySlider: 1.1 };
        for (const [id, def] of Object.entries(sliderDefaults)) {
            const el = document.getElementById(id);
            if (el) el.value = def;
        }
    }

    // --- Model Update Functions ---

    async function pullModel(modelName, statusEl, buttonEl, barEl = null) {
        const icon = buttonEl.querySelector('.lucide');
        buttonEl.disabled = true;
        buttonEl.classList.add('updating');
        statusEl.textContent = 'Connecting...';
        statusEl.className = 'update-status';
        if (barEl) barEl.style.width = '0%';

        try {
            const response = await fetch(`${PROXY_BASE}/proxy/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: modelName, stream: true })
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.error) {
                            throw new Error(json.error);
                        }
                        if (json.status) {
                            let text = json.status;
                            if (json.total && json.completed) {
                                const pct = Math.round((json.completed / json.total) * 100);
                                text += ` ${pct}%`;
                                if (barEl) barEl.style.width = pct + '%';
                            }
                            statusEl.textContent = text;
                        }
                    } catch (parseErr) {
                        if (parseErr.message !== 'Unexpected end of JSON input') {
                            throw parseErr;
                        }
                    }
                }
            }

            if (barEl) barEl.style.width = '100%';
            statusEl.textContent = 'Up to date';
            statusEl.className = 'update-status success';
        } catch (err) {
            statusEl.textContent = `Error: ${err.message}`;
            statusEl.className = 'update-status error';
        } finally {
            buttonEl.disabled = false;
            buttonEl.classList.remove('updating');
        }
    }

    async function updateCurrentModel() {
        const statusEl = document.getElementById('updateCurrentModelStatus');
        const buttonEl = document.getElementById('updateCurrentModelButton');
        if (!statusEl || !buttonEl || !currentModelName) return;
        await pullModel(currentModelName, statusEl, buttonEl);
    }

    async function updateAllModels() {
        const statusEl = document.getElementById('updateAllModelsStatus');
        const buttonEl = document.getElementById('updateAllModelsButton');
        if (!statusEl || !buttonEl) return;

        buttonEl.disabled = true;
        buttonEl.classList.add('updating');
        statusEl.className = 'update-status';

        try {
            const res = await fetch(`${PROXY_BASE}/proxy/api/tags`);
            if (!res.ok) throw new Error('Could not fetch model list');
            const data = await res.json();
            const models = (data.models || []).map(m => m.name);

            if (models.length === 0) {
                statusEl.textContent = 'No models found';
                return;
            }

            for (let i = 0; i < models.length; i++) {
                const name = models[i];
                statusEl.textContent = `[${i + 1}/${models.length}] Updating ${name}...`;
                statusEl.className = 'update-status';

                try {
                    const response = await fetch(`${PROXY_BASE}/proxy/api/pull`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, stream: true })
                    });

                    if (!response.ok) throw new Error(`Server error: ${response.status}`);

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const json = JSON.parse(line);
                                if (json.error) throw new Error(json.error);
                                if (json.status) {
                                    let text = `[${i + 1}/${models.length}] ${name}: ${json.status}`;
                                    if (json.total && json.completed) {
                                        const pct = Math.round((json.completed / json.total) * 100);
                                        text += ` ${pct}%`;
                                    }
                                    statusEl.textContent = text;
                                }
                            } catch (parseErr) {
                                if (parseErr.message !== 'Unexpected end of JSON input') throw parseErr;
                            }
                        }
                    }
                } catch (modelErr) {
                    statusEl.textContent = `[${i + 1}/${models.length}] ${name}: Error — ${modelErr.message}`;
                    statusEl.className = 'update-status error';
                    await new Promise(r => setTimeout(r, 1500)); // brief pause before next model
                }
            }

            statusEl.textContent = `All ${models.length} models up to date`;
            statusEl.className = 'update-status success';
        } catch (err) {
            statusEl.textContent = `Error: ${err.message}`;
            statusEl.className = 'update-status error';
        } finally {
            buttonEl.disabled = false;
            buttonEl.classList.remove('updating');
        }
    }

    // --- End Model Update Functions ---

    async function populateMgmtModelList() {
        const listEl = document.getElementById('mgmtModelList');
        if (!listEl) return;

        listEl.innerHTML = '<span class="mgmt-loading">Loading...</span>';

        try {
            let models = availableModels.length > 0 ? availableModels : [];
            if (models.length === 0) {
                const res = await fetch(`${PROXY_BASE}/proxy/api/tags`);
                if (!res.ok) throw new Error('Could not fetch model list');
                const data = await res.json();
                models = data.models || [];
            }

            if (models.length === 0) {
                listEl.innerHTML = '<span class="mgmt-empty">No local models found.</span>';
                return;
            }

            listEl.innerHTML = '';

            for (const model of models) {
                const row = document.createElement('div');
                row.className = 'mgmt-model-row';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'mgmt-model-name';
                nameSpan.textContent = model.name;
                nameSpan.title = model.name;
                row.appendChild(nameSpan);

                const capsSpan = document.createElement('span');
                capsSpan.className = 'mgmt-model-caps';
                row.appendChild(capsSpan);

                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'mgmt-model-size';
                if (model.size && model.size > 0) {
                    sizeSpan.textContent = (model.size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
                }
                row.appendChild(sizeSpan);

                const delBtn = document.createElement('button');
                delBtn.className = 'mgmt-delete-btn';
                delBtn.title = `Delete ${model.name}`;
                delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
                delBtn.addEventListener('click', async () => {
                    if (!confirm(`Delete "${model.name}"?\n\nThis will permanently remove the model from disk.`)) return;
                    delBtn.disabled = true;
                    await deleteOllamaModel(model.name, row);
                });
                row.appendChild(delBtn);

                listEl.appendChild(row);

                // Show cloud badge synchronously
                if (isCloudModel(model.name)) {
                    capsSpan.appendChild(makeCloudBadge(13));
                }
            }
            if (typeof lucide !== 'undefined') lucide.createIcons({ el: listEl });
        } catch (err) {
            listEl.innerHTML = `<span class="mgmt-error">Error: ${err.message}</span>`;
        }
    }

    async function deleteOllamaModel(name, rowEl) {
        try {
            const res = await fetch(`${PROXY_BASE}/proxy/api/delete`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (res.ok) {
                rowEl.remove();
                availableModels = availableModels.filter(m => m.name !== name);
                populateModelDropdown(availableModels, currentModelName);
            } else {
                const err = await res.json().catch(() => ({}));
                alert(`Failed to delete "${name}": ${err.error || res.statusText}`);
                const btn = rowEl.querySelector('.mgmt-delete-btn');
                if (btn) btn.disabled = false;
            }
        } catch (e) {
            alert(`Error deleting model: ${e.message}`);
            const btn = rowEl.querySelector('.mgmt-delete-btn');
            if (btn) btn.disabled = false;
        }
    }

    async function populateLlamaCppModelList() {
        const listEl = document.getElementById('llamaCppModelList');
        if (!listEl) return;
        listEl.innerHTML = '<span class="mgmt-loading">Loading...</span>';
        try {
            const res = await fetch(`${PROXY_BASE}/api/llamacpp/models`);
            if (!res.ok) throw new Error('Could not fetch llama.cpp models');
            const data = await res.json();
            const models = data.models || [];
            if (models.length === 0) {
                listEl.innerHTML = '<span class="mgmt-empty">No .gguf files found in configured directory.</span>';
                return;
            }
            listEl.innerHTML = '';
            for (const model of models) {
                const row = document.createElement('div');
                row.className = 'mgmt-model-row';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'mgmt-model-name';
                nameSpan.textContent = model.name;
                nameSpan.title = model.path;
                row.appendChild(nameSpan);

                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'mgmt-model-size';
                if (model.size > 0) sizeSpan.textContent = (model.size / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
                row.appendChild(sizeSpan);

                const isRunning = data.currentModel && data.currentModel === model.path;
                const delBtn = document.createElement('button');
                delBtn.className = 'mgmt-delete-btn';
                delBtn.title = isRunning ? 'Stop the server before deleting' : `Delete ${model.name}`;
                delBtn.disabled = isRunning;
                delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
                delBtn.addEventListener('click', async () => {
                    if (!confirm(`Delete "${model.name}"?\n\nThis will permanently remove the file from disk.`)) return;
                    delBtn.disabled = true;
                    try {
                        const r = await fetch(`${PROXY_BASE}/api/llamacpp/delete`, {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ modelPath: model.path })
                        });
                        if (r.ok) {
                            row.remove();
                            availableModels = availableModels.filter(m => m._path !== model.path);
                            populateModelDropdown();
                        } else {
                            const err = await r.json().catch(() => ({}));
                            alert(`Failed to delete: ${err.error || r.statusText}`);
                            delBtn.disabled = false;
                        }
                    } catch (e) {
                        alert(`Error: ${e.message}`);
                        delBtn.disabled = false;
                    }
                });
                row.appendChild(delBtn);
                listEl.appendChild(row);
            }
            if (typeof lucide !== 'undefined') lucide.createIcons({ el: listEl });
        } catch (err) {
            listEl.innerHTML = `<span class="mgmt-error">Error: ${err.message}</span>`;
        }
    }

    // Convert llmfit's HuggingFace-style model names to Ollama pull names (best effort)
    function llmfitNameToOllama(hfName) {
        const lower = hfName.toLowerCase();
        const sizeMatch = lower.match(/[-/](\d+(?:\.\d+)?)b(?:$|[-_])/);
        const tag = sizeMatch ? sizeMatch[1] + 'b' : null;
        const t = n => tag ? `${n}:${tag}` : n;
        if (lower.includes('deepseek-r1-distill'))    return t('deepseek-r1');
        if (lower.includes('deepseek-r1'))             return t('deepseek-r1');
        if (lower.includes('deepseek-v3'))             return t('deepseek-v3');
        if (lower.includes('deepseek-v2'))             return t('deepseek-v2');
        if (lower.includes('gemma-3') || lower.includes('gemma3')) return t('gemma3');
        if (lower.includes('gemma-2') || lower.includes('gemma2')) return t('gemma2');
        if (lower.includes('llama-3.2'))               return t('llama3.2');
        if (lower.includes('llama-3.1'))               return t('llama3.1');
        if (lower.includes('llama-3'))                 return t('llama3');
        if (lower.includes('llama-2'))                 return t('llama2');
        if (lower.includes('qwen3'))                   return t('qwen3');
        if (lower.includes('qwen2.5-coder'))           return t('qwen2.5-coder');
        if (lower.includes('qwen2.5'))                 return t('qwen2.5');
        if (lower.includes('phi-4') || lower.includes('phi4')) return 'phi4';
        if (lower.includes('phi-3') || lower.includes('phi3')) return t('phi3');
        if (lower.includes('mixtral'))                 return t('mixtral');
        if (lower.includes('mistral'))                 return t('mistral');
        if (lower.includes('codellama'))               return t('codellama');
        if (lower.includes('yi-coder'))                return t('yi-coder');
        if (lower.includes('yi'))                      return t('yi');
        if (lower.includes('solar'))                   return t('solar');
        // fallback: strip org prefix, lowercase, remove common suffixes
        return hfName.replace(/^[^/]+\//, '').toLowerCase()
            .replace(/-(it|instruct|chat|hf)$/g, '').replace(/-\d+b/, '');
    }

    function buildLlmfitCard(m) {
        const fitLower = (m.fit_level || '').toLowerCase();
        const ollamaName = llmfitNameToOllama(m.name);
        const org = m.name.includes('/') ? m.name.split('/')[0] : null;
        const modelName = m.name.replace(/^[^/]+\//, '');

        const card = document.createElement('div');
        card.className = 'llmfit-card';

        // Header: name + fit badge
        const header = document.createElement('div');
        header.className = 'llmfit-card-header';

        const nameWrap = document.createElement('div');
        nameWrap.className = 'llmfit-card-name';
        if (org) {
            const orgEl = document.createElement('div');
            orgEl.className = 'llmfit-card-org';
            orgEl.textContent = org;
            nameWrap.appendChild(orgEl);
        }
        const nameText = document.createElement('div');
        nameText.textContent = modelName;
        nameWrap.appendChild(nameText);
        header.appendChild(nameWrap);

        const fitEl = document.createElement('span');
        fitEl.className = `llmfit-fit ${fitLower}`;
        fitEl.textContent = m.fit_level || '?';
        header.appendChild(fitEl);
        card.appendChild(header);

        // Stats grid
        const stats = document.createElement('div');
        stats.className = 'llmfit-card-stats';
        const addStat = (label, value) => {
            if (!value && value !== 0) return;
            const s = document.createElement('span');
            s.className = 'llmfit-stat';
            s.innerHTML = `<span class="llmfit-stat-label">${label}</span><span class="llmfit-stat-value">${value}</span>`;
            stats.appendChild(s);
        };
        addStat('Speed', m.estimated_tps ? `${m.estimated_tps} t/s` : null);
        addStat('VRAM', m.utilization_pct ? `${m.utilization_pct}%` : null);
        addStat('Quant', m.best_quant);
        addStat('Mode', m.run_mode);
        addStat('Size', m.parameter_count);
        addStat('Category', m.category);
        card.appendChild(stats);

        // Use case
        if (m.use_case) {
            const uc = document.createElement('div');
            uc.className = 'llmfit-use-case';
            uc.textContent = m.use_case;
            card.appendChild(uc);
        }

        // Footer: score bar + pull button
        const footer = document.createElement('div');
        footer.className = 'llmfit-card-footer';

        const track = document.createElement('div');
        track.className = 'llmfit-score-track';
        const fill = document.createElement('div');
        fill.className = 'llmfit-score-fill';
        fill.style.width = `${Math.min(100, m.score || 0)}%`;
        track.appendChild(fill);
        footer.appendChild(track);

        const scoreLabel = document.createElement('span');
        scoreLabel.className = 'llmfit-score-label';
        scoreLabel.textContent = `Score ${Math.round(m.score || 0)}/100`;
        footer.appendChild(scoreLabel);

        const pullBtn = document.createElement('button');
        pullBtn.className = 'llmfit-pull-btn';
        pullBtn.title = `Pull ${ollamaName}`;
        pullBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Pull`;
        pullBtn.addEventListener('click', () => {
            closeLlmfitModal();
            // Ensure settings modal is open and Model Management section is expanded
            const settingsModal = document.getElementById('settingsModal');
            if (settingsModal && !settingsModal.classList.contains('active')) {
                openSettingsModal();
            }
            const mgmtBody = document.getElementById('modelMgmtSectionBody');
            if (mgmtBody && !mgmtBody.classList.contains('expanded')) {
                toggleSection('modelMgmtSectionToggle', 'modelMgmtSectionBody');
            }
            const input = document.getElementById('pullNewModelInput');
            if (input) {
                input.value = ollamaName;
                setTimeout(() => { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);
            }
        });
        footer.appendChild(pullBtn);
        card.appendChild(footer);

        return card;
    }

    async function openLlmfitModal() {
        const modal = document.getElementById('llmfitModal');
        const loading = document.getElementById('llmfitModalLoading');
        const body = document.getElementById('llmfitModalBody');
        if (!modal) return;

        // Reset to loading state
        if (body) { body.style.display = 'none'; body.innerHTML = ''; }
        if (loading) loading.style.display = 'flex';
        modal.classList.add('active');
        if (typeof lucide !== 'undefined') lucide.createIcons({ el: loading });

        try {
            const res = await fetch(`${PROXY_BASE}/api/llmfit/recommend`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                throw new Error(err.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            const models = data.models || [];

            if (loading) loading.style.display = 'none';
            if (!body) return;
            body.style.display = 'block';

            if (models.length === 0) {
                body.innerHTML = '<div class="llmfit-unavail">No recommendations returned.</div>';
                return;
            }

            // Group by fit level
            const groups = { Perfect: [], Good: [], Marginal: [], 'Too Tight': [] };
            for (const m of models) {
                const key = m.fit_level || 'Marginal';
                (groups[key] = groups[key] || []).push(m);
            }

            const groupOrder = ['Perfect', 'Good', 'Marginal', 'Too Tight'];
            const groupLabels = {
                Perfect: '🟢 Perfect',
                Good: '🟡 Good',
                Marginal: '🟠 Marginal',
                'Too Tight': '🔴 Too Large'
            };

            const canRun = groups.Perfect.length + groups.Good.length + groups.Marginal.length;

            // Filter bar
            const filterBar = document.createElement('div');
            filterBar.className = 'llmfit-filter-bar';

            const allBtn = document.createElement('button');
            allBtn.className = 'llmfit-filter-btn active';
            allBtn.textContent = `All (${models.length})`;
            allBtn.dataset.filter = 'all';
            filterBar.appendChild(allBtn);

            for (const key of groupOrder) {
                const count = (groups[key] || []).length;
                if (count === 0) continue;
                const btn = document.createElement('button');
                btn.className = 'llmfit-filter-btn';
                btn.textContent = `${groupLabels[key]} (${count})`;
                btn.dataset.filter = key;
                filterBar.appendChild(btn);
            }
            body.appendChild(filterBar);

            // Summary line
            const summary = document.createElement('div');
            summary.className = 'llmfit-summary';
            summary.textContent = `${models.length} models analyzed · ${canRun} can run on your hardware`;
            body.appendChild(summary);

            // Group sections
            const groupSections = [];
            for (const key of groupOrder) {
                const list = groups[key];
                if (!list || list.length === 0) continue;

                const section = document.createElement('div');
                section.dataset.group = key;

                const heading = document.createElement('div');
                heading.className = 'llmfit-group-heading';
                heading.textContent = `${groupLabels[key]} (${list.length})`;
                section.appendChild(heading);

                const cards = document.createElement('div');
                cards.className = 'llmfit-cards';
                for (const m of list) cards.appendChild(buildLlmfitCard(m));
                section.appendChild(cards);

                body.appendChild(section);
                groupSections.push(section);
            }

            // Wire filter buttons
            const filterBtns = filterBar.querySelectorAll('.llmfit-filter-btn');
            filterBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    filterBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const filter = btn.dataset.filter;
                    groupSections.forEach(s => {
                        s.style.display = (filter === 'all' || s.dataset.group === filter) ? '' : 'none';
                    });
                });
            });

        } catch (err) {
            if (loading) loading.style.display = 'none';
            if (body) {
                body.style.display = 'block';
                const msg = (err.message.includes('not found') || err.message.includes('Failed to fetch'))
                    ? 'llmfit not available. Install it from <code>cargo install llmfit</code> to see hardware recommendations.'
                    : `Error: ${err.message}`;
                body.innerHTML = `<div class="llmfit-unavail">${msg}</div>`;
            }
        }
    }

    function closeLlmfitModal() {
        const modal = document.getElementById('llmfitModal');
        if (modal) modal.classList.remove('active');
    }

    function toggleSection(toggleId, bodyId) {
        const toggle = document.getElementById(toggleId);
        const body = document.getElementById(bodyId);
        if (!toggle || !body) return;
        const isExpanded = body.classList.contains('expanded');
        body.classList.toggle('expanded', !isExpanded);
        toggle.classList.toggle('expanded', !isExpanded);
        if (!isExpanded && typeof lucide !== 'undefined') lucide.createIcons();
    }

    function toggleParamSection() {
        toggleSection('paramSectionToggle', 'paramSectionBody');
    }

    // Settings modal functions
    function openSettingsModal() {
        // Refresh memory count every time modal opens
        loadMemoryStatus();

        // Update model name label in the update button
        const updateNameEl = document.getElementById('updateCurrentModelName');
        if (updateNameEl && currentModelName) {
            updateNameEl.textContent = decodeURIComponent(currentModelName);
        }
        // Reset update status on open
        const updateStatusEl = document.getElementById('updateCurrentModelStatus');
        if (updateStatusEl) { updateStatusEl.textContent = ''; updateStatusEl.className = 'update-status'; }

        // Populate installed models list in Model Management tab
        if (document.getElementById('mgmtModelList')) populateMgmtModelList();

        // Load current settings
        loadModelChatState(currentModelName).then(modelData => {
            // Load system prompt
            const prompt = modelData.systemPrompt || '';
            systemPromptInput.value = prompt;
            updateSystemPromptTokenCount();

            // Load context limit
            const contextLimit = modelData.contextLimitOverride;
            if (contextLimit && contextLimit > 0) {
                contextLimitInput.value = contextLimit;
            } else {
                contextLimitInput.value = '';
            }
            updateContextLimitInfo();

            // Load model params (always populate so inputs are ready when section expands)
            loadParamInputs(modelData.params);
        });

        // Refresh persona presets only if section is already expanded
        const personaBody = document.getElementById('personaSectionBody');
        if (personaBody && personaBody.classList.contains('expanded')) {
            loadPersonaPresets().then(presets => {
                renderPersonaPresets(presets);
                hideNewPresetForm();
            });
        } else {
            hideNewPresetForm();
        }

        // Load TTS settings
        loadTTSSettings();

        settingsModal.classList.add('active');
    }

    function closeSettingsModal() {
        settingsModal.classList.remove('active');
        stopKokoroStatusPoll();
        // Restore focus to input when modal closes
        messageInput.focus();
    }

    function updateSystemPromptTokenCount() {
        const tokens = estimateTokens(systemPromptInput.value);
        systemPromptTokenCount.textContent = `${tokens} tokens`;
    }

    function updateInputTokenCount() {
        const val = messageInput.value;
        if (val.trim()) {
            inputTokenCount.textContent = `${estimateTokens(val)} tokens`;
            inputTokenCount.style.display = 'block';
        } else {
            inputTokenCount.style.display = 'none';
        }
    }

    function updateContextLimitInfo() {
        const isCloud = isCloudModel(currentModelName);
        const autoLimit = isCloud ? formatContextLimit(CLOUD_CONTEXT_LIMIT) : formatContextLimit(DEFAULT_CONTEXT_LIMIT);
        const modelType = isCloud ? 'cloud' : 'local';
        contextLimitInfo.textContent = `Auto-detecting: ${autoLimit} (${modelType} model). Set to 0 or leave empty for auto.`;
    }

    async function saveSystemPrompt() {
        try {
            const newPrompt = systemPromptInput.value.trim();
            const contextLimitValue = contextLimitInput.value.trim();

            let modelData = await loadModelChatState(currentModelName);
            modelData.systemPrompt = newPrompt;

            // Parse and save context limit override
            const parsedLimit = parseInt(contextLimitValue, 10);
            if (contextLimitValue && !isNaN(parsedLimit) && parsedLimit > 0) {
                modelData.contextLimitOverride = parsedLimit;
            } else {
                modelData.contextLimitOverride = null; // Use auto-detection
            }

            // Collect and save model params
            modelData.params = collectParams();

            await saveModelChatState(currentModelName, modelData);

            // Update context indicator to reflect new system prompt size
            const currentMessages = getCurrentConversationMessages(modelData);
            await updateContextIndicator(currentMessages, newPrompt, modelData);

            // Save TTS settings
            await saveTTSSettings();

            console.log('[OllamaBro] Settings saved for model:', currentModelName);
        } finally {
            closeSettingsModal();
        }
    }

    async function clearSystemPrompt() {
        systemPromptInput.value = '';
        updateSystemPromptTokenCount();
        let modelData = await loadModelChatState(currentModelName);
        modelData.systemPrompt = '';
        modelData.contextLimitOverride = null; // Also clear context limit override
        await saveModelChatState(currentModelName, modelData);

        const currentMessages = getCurrentConversationMessages(modelData);
        await updateContextIndicator(currentMessages, '', modelData);

        // Clear active persona badge
        activePersonaName = '';
        updatePersonaBadge();
        loadPersonaPresets().then(renderPersonaPresets);

        console.log('[OllamaBro] System prompt cleared for model:', currentModelName);
    }

    // --- Persona Preset Functions ---

    async function loadPersonaPresets() {
        if (!chrome.storage || !chrome.storage.local) return [...DEFAULT_PRESETS];
        try {
            const initKey = `${personaPresetsKey}_init`;
            const result = await chrome.storage.local.get([personaPresetsKey, initKey]);
            if (!result[initKey]) {
                // First run — seed with defaults, user owns the list from here
                const initial = DEFAULT_PRESETS.map(({ id, name, prompt }) => ({ id, name, prompt }));
                await chrome.storage.local.set({ [personaPresetsKey]: initial, [initKey]: true });
                return initial;
            }
            return result[personaPresetsKey] || [];
        } catch (error) {
            console.error('[OllamaBro] Error loading persona presets:', error);
            return [...DEFAULT_PRESETS];
        }
    }

    async function savePersonaPresets(presets) {
        if (!chrome.storage || !chrome.storage.local) return;
        try {
            await chrome.storage.local.set({ [personaPresetsKey]: presets });
        } catch (error) {
            console.error('[OllamaBro] Error saving persona presets:', error);
        }
    }

    function renderPersonaPresets(presets) {
        const list = document.getElementById('personaPresetsList');
        if (!list) return;
        list.innerHTML = '';

        if (presets.length === 0) {
            const empty = document.createElement('p');
            empty.style.cssText = 'font-size: var(--font-size-xs); color: var(--text-muted); padding: var(--space-sm) 0;';
            empty.textContent = 'No presets yet. Use the button below to add one.';
            list.appendChild(empty);
            return;
        }

        for (const preset of presets) {
            list.appendChild(createPresetViewRow(preset));
        }
    }

    function createPresetViewRow(preset) {
        const item = document.createElement('div');
        item.className = 'preset-item';
        item.dataset.presetId = preset.id;

        const info = document.createElement('div');
        info.className = 'preset-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'preset-item-name';
        nameEl.textContent = preset.name;

        const preview = document.createElement('div');
        preview.className = 'preset-item-preview';
        preview.textContent = preset.prompt;
        preview.title = preset.prompt;

        info.appendChild(nameEl);
        info.appendChild(preview);

        const actions = document.createElement('div');
        actions.className = 'preset-item-actions';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'preset-apply-button';
        const isActive = activePersonaName === preset.name;
        applyBtn.textContent = isActive ? 'Active' : 'Apply';
        if (isActive) applyBtn.classList.add('active');
        applyBtn.addEventListener('click', () => applyPersonaPreset(preset));

        const editBtn = document.createElement('button');
        editBtn.className = 'preset-edit-button';
        editBtn.title = 'Edit preset';
        editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';
        editBtn.addEventListener('click', () => openPresetEditInline(item, preset));

        actions.appendChild(applyBtn);
        actions.appendChild(editBtn);
        item.appendChild(info);
        item.appendChild(actions);
        return item;
    }

    function openPresetEditInline(itemEl, preset) {
        itemEl.innerHTML = '';
        itemEl.classList.add('preset-item-editing');

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'preset-name-input';
        nameInput.value = preset.name;
        nameInput.maxLength = 50;
        nameInput.placeholder = 'Preset name';

        const promptTextarea = document.createElement('textarea');
        promptTextarea.className = 'preset-prompt-input';
        promptTextarea.value = preset.prompt;
        promptTextarea.rows = 4;
        promptTextarea.placeholder = 'System prompt text...';

        const actionsRow = document.createElement('div');
        actionsRow.className = 'preset-edit-actions';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'modal-button danger';
        deleteBtn.style.marginRight = 'auto';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => deletePersonaPreset(preset.id));

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-button secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => loadPersonaPresets().then(renderPersonaPresets));

        const saveBtn = document.createElement('button');
        saveBtn.className = 'modal-button primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const newName = nameInput.value.trim();
            const newPrompt = promptTextarea.value.trim();
            if (!newName) { nameInput.focus(); return; }
            if (!newPrompt) { promptTextarea.focus(); return; }
            await updatePersonaPreset(preset.id, newName, newPrompt);
        });

        actionsRow.appendChild(deleteBtn);
        actionsRow.appendChild(cancelBtn);
        actionsRow.appendChild(saveBtn);
        itemEl.appendChild(nameInput);
        itemEl.appendChild(promptTextarea);
        itemEl.appendChild(actionsRow);
        nameInput.focus();
        nameInput.select();
    }

    async function updatePersonaPreset(id, name, prompt) {
        const presets = await loadPersonaPresets();
        const idx = presets.findIndex(p => p.id === id);
        if (idx === -1) return;
        const oldName = presets[idx].name;
        const updated = presets.map(p => p.id === id ? { id: p.id, name, prompt } : p);
        if (activePersonaName === oldName) {
            activePersonaName = name;
            updatePersonaBadge();
        }
        await savePersonaPresets(updated);
        renderPersonaPresets(updated);
    }

    function togglePersonaSection() {
        const toggle = document.getElementById('personaSectionToggle');
        const body = document.getElementById('personaSectionBody');
        if (!toggle || !body) return;
        const isExpanded = body.classList.contains('expanded');
        if (isExpanded) {
            body.classList.remove('expanded');
            toggle.classList.remove('expanded');
        } else {
            body.classList.add('expanded');
            toggle.classList.add('expanded');
            loadPersonaPresets().then(presets => {
                renderPersonaPresets(presets);
                hideNewPresetForm();
            });
        }
    }

    function applyPersonaPreset(preset) {
        if (systemPromptInput) {
            systemPromptInput.value = preset.prompt;
            updateSystemPromptTokenCount();
        }
        activePersonaName = preset.name;
        updatePersonaBadge();
        // Re-render to update Active/Apply button states
        loadPersonaPresets().then(renderPersonaPresets);
        console.log('[OllamaBro] Applied persona preset:', preset.name);
    }

    function updatePersonaBadge() {
        const badge = document.getElementById('personaBadge');
        if (!badge) return;
        if (activePersonaName) {
            badge.textContent = activePersonaName;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }

    async function deletePersonaPreset(id) {
        const presets = await loadPersonaPresets();
        const deleted = presets.find(p => p.id === id);
        const updated = presets.filter(p => p.id !== id);
        await savePersonaPresets(updated);
        if (deleted && activePersonaName === deleted.name) {
            activePersonaName = '';
            updatePersonaBadge();
        }
        renderPersonaPresets(updated);
    }

    async function saveNewPersonaPreset() {
        const nameInput = document.getElementById('newPresetName');
        const promptInput = document.getElementById('newPresetPrompt');
        const name = nameInput ? nameInput.value.trim() : '';
        const prompt = promptInput ? promptInput.value.trim() : '';
        if (!name) { if (nameInput) nameInput.focus(); return; }
        if (!prompt) { if (promptInput) promptInput.focus(); return; }

        const newPreset = { id: `user-${Date.now()}`, name, prompt, isDefault: false };
        const presets = await loadPersonaPresets();
        presets.push(newPreset);
        await savePersonaPresets(presets);
        hideNewPresetForm();
        renderPersonaPresets(presets);
        console.log('[OllamaBro] Saved new persona preset:', name);
    }

    function showNewPresetForm() {
        const form = document.getElementById('newPresetForm');
        const addBtn = document.getElementById('addNewPresetButton');
        if (form) { form.style.display = 'flex'; }
        if (addBtn) { addBtn.style.display = 'none'; }
        const nameInput = document.getElementById('newPresetName');
        if (nameInput) nameInput.focus();
    }

    function hideNewPresetForm() {
        const form = document.getElementById('newPresetForm');
        const addBtn = document.getElementById('addNewPresetButton');
        if (form) { form.style.display = 'none'; }
        if (addBtn) { addBtn.style.display = 'flex'; }
        const nameInput = document.getElementById('newPresetName');
        const promptInput = document.getElementById('newPresetPrompt');
        if (nameInput) nameInput.value = '';
        if (promptInput) promptInput.value = '';
    }

    // ── Slash Commands ───────────────────────────────────────────────────────

    async function loadSlashCommands() {
        try {
            const result = await chrome.storage.local.get([SLASH_COMMANDS_KEY, SLASH_COMMANDS_INIT_KEY]);
            if (!result[SLASH_COMMANDS_INIT_KEY]) {
                await chrome.storage.local.set({
                    [SLASH_COMMANDS_KEY]: DEFAULT_SLASH_COMMANDS,
                    [SLASH_COMMANDS_INIT_KEY]: true
                });
                return [...DEFAULT_SLASH_COMMANDS];
            }
            return result[SLASH_COMMANDS_KEY] || [];
        } catch (e) {
            console.error('[OllamaBro] Error loading slash commands:', e);
            return [...DEFAULT_SLASH_COMMANDS];
        }
    }

    async function saveSlashCommands(cmds) {
        try {
            await chrome.storage.local.set({ [SLASH_COMMANDS_KEY]: cmds });
            slashCommands = cmds;
        } catch (e) {
            console.error('[OllamaBro] Error saving slash commands:', e);
        }
    }

    function getSlashQuery() {
        const val = messageInput.value;
        const m = val.match(/^\/(\S*)$/);
        return m ? m[1] : null;
    }

    function showSlashPopup(filtered) {
        slashPopupFiltered = filtered;
        slashCommandPopup.innerHTML = '';
        slashPopupSelectedIndex = -1;
        if (filtered.length === 0) { hideSlashPopup(); return; }

        filtered.forEach((cmd, i) => {
            const item = document.createElement('div');
            item.className = 'slash-cmd-item';
            item.dataset.index = i;

            const trigger = document.createElement('span');
            trigger.className = 'slash-cmd-trigger';
            trigger.textContent = `/${cmd.trigger}`;

            const info = document.createElement('div');
            info.className = 'slash-cmd-info';

            const name = document.createElement('div');
            name.className = 'slash-cmd-name';
            name.textContent = cmd.name;

            const preview = document.createElement('div');
            preview.className = 'slash-cmd-preview';
            preview.textContent = cmd.body.replace(/\n/g, ' ');

            info.appendChild(name);
            info.appendChild(preview);
            item.appendChild(trigger);
            item.appendChild(info);

            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                applySlashCommand(cmd);
            });
            slashCommandPopup.appendChild(item);
        });

        const hint = document.createElement('div');
        hint.className = 'slash-cmd-hint';
        hint.textContent = '↑↓ navigate  ·  Enter / Tab to insert  ·  Esc to close';
        slashCommandPopup.appendChild(hint);

        slashCommandPopup.classList.add('visible');
    }

    function hideSlashPopup() {
        slashCommandPopup.classList.remove('visible');
        slashCommandPopup.innerHTML = '';
        slashPopupFiltered = [];
        slashPopupSelectedIndex = -1;
    }

    function setSlashPopupSelected(index) {
        const items = slashCommandPopup.querySelectorAll('.slash-cmd-item');
        items.forEach((el, i) => el.classList.toggle('selected', i === index));
        slashPopupSelectedIndex = index;
        if (items[index]) items[index].scrollIntoView({ block: 'nearest' });
    }

    function applySlashCommand(cmd) {
        messageInput.value = cmd.body;
        messageInput.focus();
        messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
        messageInput.dispatchEvent(new Event('input'));
        hideSlashPopup();
    }

    function handleSlashInput() {
        const query = getSlashQuery();
        if (query === null) { hideSlashPopup(); return; }
        const filtered = slashCommands.filter(cmd =>
            cmd.trigger.toLowerCase().startsWith(query.toLowerCase())
        );
        showSlashPopup(filtered);
    }

    // ── Slash Commands Settings ──────────────────────────────────────────────

    function initSlashCommandsSettings() {
        const sectionToggle = document.getElementById('slashCmdSectionToggle');
        if (!sectionToggle) return;

        sectionToggle.addEventListener('click', () => {
            toggleSection('slashCmdSectionToggle', 'slashCmdSectionBody');
            const body = document.getElementById('slashCmdSectionBody');
            if (body && body.classList.contains('expanded')) renderSlashCommandsList();
        });

        const addNewButton = document.getElementById('addNewSlashCmdButton');
        const newForm = document.getElementById('newSlashCmdForm');
        const cancelBtn = document.getElementById('cancelNewSlashCmdButton');
        const saveBtn = document.getElementById('saveNewSlashCmdButton');
        const triggerInput = document.getElementById('newSlashCmdTrigger');
        const nameInput = document.getElementById('newSlashCmdName');
        const bodyInput = document.getElementById('newSlashCmdBody');

        addNewButton.addEventListener('click', () => {
            newForm.style.display = 'flex';
            addNewButton.style.display = 'none';
            triggerInput.focus();
        });

        cancelBtn.addEventListener('click', () => {
            newForm.style.display = 'none';
            addNewButton.style.display = 'flex';
            triggerInput.value = '';
            nameInput.value = '';
            bodyInput.value = '';
        });

        saveBtn.addEventListener('click', async () => {
            const trigger = triggerInput.value.trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
            const name = nameInput.value.trim();
            const body = bodyInput.value;
            if (!trigger || !name || !body.trim()) return;
            const newCmd = { id: `cmd_${Date.now()}`, trigger, name, body };
            await saveSlashCommands([...slashCommands, newCmd]);
            newForm.style.display = 'none';
            addNewButton.style.display = 'flex';
            triggerInput.value = '';
            nameInput.value = '';
            bodyInput.value = '';
            renderSlashCommandsList();
        });
    }

    function renderSlashCommandsList() {
        const list = document.getElementById('slashCommandsList');
        if (!list) return;
        list.innerHTML = '';
        if (slashCommands.length === 0) {
            const empty = document.createElement('p');
            empty.style.cssText = 'font-size:var(--font-size-xs);color:var(--text-muted);padding:var(--space-sm) 0;';
            empty.textContent = 'No prompt templates. Add one below.';
            list.appendChild(empty);
            return;
        }
        for (const cmd of slashCommands) {
            list.appendChild(createSlashCommandRow(cmd));
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function createSlashCommandRow(cmd) {
        const item = document.createElement('div');
        item.className = 'preset-item';
        item.dataset.cmdId = cmd.id;

        const info = document.createElement('div');
        info.className = 'preset-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'preset-item-name';
        nameEl.innerHTML = `<code style="font-size:11px;color:var(--accent);">/${cmd.trigger}</code> — ${cmd.name}`;

        const preview = document.createElement('div');
        preview.className = 'preset-item-preview';
        preview.textContent = cmd.body.replace(/\n/g, ' ');
        preview.title = cmd.body;

        info.appendChild(nameEl);
        info.appendChild(preview);

        const actions = document.createElement('div');
        actions.className = 'preset-item-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'preset-edit-button';
        editBtn.title = 'Edit';
        editBtn.appendChild(createLucideIcon('pencil', 13));
        editBtn.addEventListener('click', () => startEditSlashCommand(cmd, item));

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'preset-edit-button';
        deleteBtn.title = 'Delete';
        deleteBtn.style.color = 'var(--error-text)';
        deleteBtn.appendChild(createLucideIcon('trash-2', 13));
        deleteBtn.addEventListener('click', async () => {
            await saveSlashCommands(slashCommands.filter(c => c.id !== cmd.id));
            renderSlashCommandsList();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        item.appendChild(info);
        item.appendChild(actions);
        return item;
    }

    function startEditSlashCommand(cmd, rowEl) {
        rowEl.classList.add('preset-item-editing');
        rowEl.innerHTML = '';

        const triggerInput = document.createElement('input');
        triggerInput.type = 'text';
        triggerInput.className = 'preset-name-input';
        triggerInput.placeholder = 'Trigger (e.g., translate)';
        triggerInput.value = cmd.trigger;
        triggerInput.maxLength = 30;

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'preset-name-input';
        nameInput.placeholder = 'Display name';
        nameInput.value = cmd.name;
        nameInput.maxLength = 50;

        const bodyInput = document.createElement('textarea');
        bodyInput.className = 'preset-prompt-input';
        bodyInput.placeholder = 'Template text...';
        bodyInput.value = cmd.body;
        bodyInput.rows = 3;

        const editActions = document.createElement('div');
        editActions.className = 'preset-edit-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-button secondary';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', renderSlashCommandsList);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'modal-button primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const newTrigger = triggerInput.value.trim().replace(/^\//, '').replace(/\s+/g, '-').toLowerCase();
            const newName = nameInput.value.trim();
            const newBody = bodyInput.value;
            if (!newTrigger || !newName || !newBody.trim()) return;
            await saveSlashCommands(slashCommands.map(c =>
                c.id === cmd.id ? { ...c, trigger: newTrigger, name: newName, body: newBody } : c
            ));
            renderSlashCommandsList();
        });

        editActions.appendChild(cancelBtn);
        editActions.appendChild(saveBtn);
        rowEl.appendChild(triggerInput);
        rowEl.appendChild(nameInput);
        rowEl.appendChild(bodyInput);
        rowEl.appendChild(editActions);
    }

    // Clear context modal functions
    function openClearContextModal() {
        clearContextModal.classList.add('active');
    }

    function closeClearContextModal() {
        clearContextModal.classList.remove('active');
        // Restore focus to input when modal closes
        messageInput.focus();
    }

    function openShortcutsModal() {
        shortcutsModal.classList.add('active');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }

    function closeShortcutsModal() {
        shortcutsModal.classList.remove('active');
        messageInput.focus();
    }

    async function clearContextKeepingSystemPrompt() {
        console.log(`Clearing messages while keeping system prompt for model: ${currentModelName}`);
        let modelData = await loadModelChatState(currentModelName);
        const systemPrompt = modelData.systemPrompt || '';

        // Reset conversations but preserve all settings
        modelData = {
            conversations: {},
            activeConversationId: null,
            systemPrompt: systemPrompt,
            contextLimitOverride: modelData.contextLimitOverride || null,
            params: modelData.params || null
        };

        await saveModelChatState(currentModelName, modelData);
        await startNewConversation(currentModelName);
        closeClearContextModal();
    }

    async function triggerLLMCompletion(modelData) {
        const activeConvId = modelData.activeConversationId;
        const currentConversation = modelData.conversations[activeConvId];

        // Show loading indicator - will hide when first content arrives or on error
        if (loadingIndicator) {
            loadingIndicator.style.display = 'block';
            loadingIndicator.textContent = 'Waiting for response...';
        }
        messageInput.disabled = true;
        sendButton.disabled = true;

        // Track if content has started arriving for gap-filling loading state
        let contentHasStarted = false;

        const botTextElement = addMessageToChatUI(currentModelName, '', 'bot-message', modelData);
        const botMessageDiv = botTextElement.parentElement;
        const stopButton = botMessageDiv.stopButton;

        // Create AbortController for this request
        currentAbortController = new AbortController();

        // Set streaming flag
        isStreaming = true;

        // Collapse previous thinking boxes to keep chat clean
        collapsePreviousThinkingBoxes();

        // Show stop button during streaming and add streaming class
        if (stopButton) {
            stopButton.style.display = 'flex';
        }
        if (botMessageDiv) {
            botMessageDiv.classList.add('streaming');
        }

        try {
            console.log(`Sending to /proxy/api/chat with model: ${currentModelName} for streaming.`);

            // Prepare messages for API - convert attachment data for Ollama format
            const apiMessages = currentConversation.messages
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(message => {
                    let content = message.content;
                    let images = undefined;

                    // Handle attachments (both images and documents)
                    // Support both new (attachments) and old (images) format for backward compatibility
                    const attachments = message.attachments || message.images;
                    
                    if (message.role === 'user' && attachments && attachments.length > 0) {
                        // Determine if using new attachments format or old images format
                        const isNewFormat = !!message.attachments;
                        
                        if (isNewFormat) {
                            // New format: attachments with type区分
                            const imageAttachments = message.attachments.filter(a => a.type === 'image' || a.base64);
                            const docAttachments = message.attachments.filter(a => a.type === 'document' || a.textContent);

                            // Add images to API message
                            if (imageAttachments.length > 0) {
                                images = imageAttachments.map(img => img.base64);
                            }

                            // Prepend document content to message
                            if (docAttachments.length > 0) {
                                const docContent = docAttachments.map(doc => {
                                    return `[File: ${doc.fileName}]\n\`\`\`\n${doc.textContent}\n\`\`\``;
                                }).join('\n\n');
                                content = docContent + '\n\n' + content;
                            }
                        } else {
                            // Old format: just images
                            images = attachments.map(img => img.base64);
                        }
                    }

                    const apiMessage = {
                        role: message.role,
                        content: content
                    };

                    // Add images if present
                    if (images && images.length > 0) {
                        apiMessage.images = images;
                    }

                    return apiMessage;
                });

            // Prepend system prompt if it exists
            if (modelData.systemPrompt && modelData.systemPrompt.trim()) {
                apiMessages.unshift({
                    role: 'system',
                    content: modelData.systemPrompt.trim()
                });
                console.log('[OllamaBro] System prompt prepended to API request');
            }

            const requestBody = {
                model: currentModelName,
                messages: apiMessages,
                stream: true
            };

            if (webSearchEnabled) requestBody._webSearch = true;
            if (deepResearchEnabled) requestBody._deepResearch = true;
            if (memoryEnabled) requestBody._memory = true;

            // Detect explicit save-to-memory intent in the last user message
            const lastUserMsg = apiMessages.filter(m => m.role === 'user').at(-1);
            if (lastUserMsg && detectMemorySaveIntent(lastUserMsg.content || '')) {
                requestBody._saveToMemory = lastUserMsg.content;
            }

            // Attach non-null model params as Ollama options
            const p = modelData.params || {};
            const options = {};
            if (p.temperature != null) options.temperature = p.temperature;
            if (p.top_p != null) options.top_p = p.top_p;
            if (p.top_k != null) options.top_k = p.top_k;
            if (p.repeat_penalty != null) options.repeat_penalty = p.repeat_penalty;
            if (p.num_predict != null) options.num_predict = p.num_predict;
            if (p.seed != null && p.seed !== 0) options.seed = p.seed;
            // Send context window override to Ollama so it's enforced server-side, not just in UI
            if (modelData.contextLimitOverride && modelData.contextLimitOverride > 0) {
                options.num_ctx = modelData.contextLimitOverride;
            }
            if (Object.keys(options).length > 0) requestBody.options = options;

            console.log('Request body for Ollama:', JSON.stringify(requestBody, null, 2));

            // --- Agent Mode Branch ---
            if (agentModeEnabled) {
                const configuredMaxSteps = Number.isInteger(agentConfig?.maxSteps) && agentConfig.maxSteps > 0
                    ? agentConfig.maxSteps : 15;
                const agentBody = {
                    messages: apiMessages,
                    model: currentModelName,
                    backend: currentModelBackend,
                    maxSteps: configuredMaxSteps
                };
                const agentResponse = await fetch(`${PROXY_BASE}/api/agent/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(agentBody),
                    signal: currentAbortController.signal
                });
                if (!agentResponse.ok) throw new Error(`Agent API Error: ${agentResponse.status}`);
                if (loadingIndicator) loadingIndicator.style.display = 'none';
                contentHasStarted = true;
                const agentReader = agentResponse.body.getReader();
                const finalText = await handleAgentStream(botTextElement, botMessageDiv, agentReader);

                if (stopButton) stopButton.style.display = 'none';
                if (botMessageDiv) botMessageDiv.classList.remove('streaming');

                const messageToSave = { role: 'assistant', content: finalText || '*(Agent response — see steps above)*' };
                currentConversation.messages.push(messageToSave);
                currentConversation.summary = getConversationSummary(currentConversation.messages);
                currentConversation.lastMessageTime = Date.now();

                // Auto-extract memories from agent exchange (fire-and-forget)
                if ((memoryEnabled || memoryAutoExtract) && lastUserMsg && finalText) {
                    triggerMemoryExtraction(lastUserMsg.content, finalText);
                }

                await updateContextIndicator(currentConversation.messages, modelData.systemPrompt, modelData);
                return;
            }
            // --- End Agent Mode Branch ---

            const chatEndpoint = currentModelBackend === 'llamacpp'
                ? `${PROXY_BASE}/api/llamacpp/chat`
                : `${PROXY_BASE}/proxy/api/chat`;

            const response = await fetch(chatEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: currentAbortController.signal // Add abort signal
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Failed to get error text from non-OK response.');
                console.error('Ollama API Error (stream):', response.status, errorText);
                throw new Error(`Ollama API Error: ${response.status} ${errorText || response.statusText}`);
            }

            if (!response.body) {
                throw new Error('ReadableStream not available in response body.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let done = false;

            console.log('Starting to read stream...');
            let accumulatedThinking = '';
            let accumulatedContent = '';
            let hasThinking = false;
            let messageMetadata = null;
            let streamBuf = '';

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) {
                    streamBuf += decoder.decode(value, { stream: true });
                    const lines = streamBuf.split('\n');
                    streamBuf = lines.pop(); // hold back any incomplete trailing line
                    for (const jsonStr of lines) {
                        if (!jsonStr.trim()) continue;
                        try {
                            const jsonResponse = JSON.parse(jsonStr);
                            console.log('Parsed JSON response:', jsonResponse); // Log parsed object

                            // Handle thinking content (Deepseek R1 style)
                            if (jsonResponse.message && typeof jsonResponse.message.thinking === 'string') {
                                accumulatedThinking += jsonResponse.message.thinking;
                                hasThinking = true;
                                console.log('Accumulated thinking:', accumulatedThinking.substring(0, 100) + '...');
                            }

                            // Handle regular content
                            if (jsonResponse.message && typeof jsonResponse.message.content === 'string') {
                                accumulatedContent += jsonResponse.message.content;
                                console.log('Accumulated content:', accumulatedContent.substring(0, 100) + '...');
                            }

                            // Hide loading indicator when content first starts arriving (gap-filling)
                            if (!contentHasStarted && (accumulatedContent || accumulatedThinking)) {
                                contentHasStarted = true;
                                if (loadingIndicator) {
                                    loadingIndicator.style.display = 'none';
                                }
                            }

                            // Update UI with combined content
                            if (jsonResponse.message && (typeof jsonResponse.message.content === 'string' || typeof jsonResponse.message.thinking === 'string')) {
                                // Combine thinking and content with think tags for display
                                let displayText = '';
                                if (hasThinking && accumulatedThinking) {
                                    displayText += `<think>\n${accumulatedThinking}\n</think>\n\n`;
                                }
                                displayText += accumulatedContent;

                                botTextElement.innerHTML = '';
                                // Pass true for isStreaming to auto-expand the thinking box
                                const fragment = renderMarkdownWithThinking(displayText, true);
                                botTextElement.appendChild(fragment);
                                botTextElement.dataset.fullMessage = displayText;

                                chatContainer.scrollTop = chatContainer.scrollHeight;
                            } else {
                                console.log('jsonResponse.message.content/thinking is missing or not a string.');
                                // It's possible for 'done' messages to have no content, which is fine.
                                if (!jsonResponse.done) {
                                    console.warn('Received a non-done chunk without message content.');
                                }
                            }

                            if (jsonResponse.done) {
                                console.log('Stream finished by Ollama (jsonResponse.done is true)');
                                done = true;
                                // Hide stop button and remove streaming class when streaming is complete
                                if (stopButton) {
                                    stopButton.style.display = 'none';
                                }
                                if (botMessageDiv) {
                                    botMessageDiv.classList.remove('streaming');
                                }

                                // Capture metrics from final response
                                if (jsonResponse.eval_count !== undefined) {
                                    // Use eval_duration if available, otherwise fall back to total_duration
                                    const durationNs = jsonResponse.eval_duration || jsonResponse.total_duration;
                                    const duration = durationNs ? (durationNs / 1e9).toFixed(2) : null;
                                    // Calculate speed: tokens / seconds (duration is in nanoseconds)
                                    let speed = null;
                                    if (durationNs && durationNs > 0 && jsonResponse.eval_count > 0) {
                                        const durationSeconds = durationNs / 1e9;
                                        speed = (jsonResponse.eval_count / durationSeconds).toFixed(1);
                                    }

                                    // Estimate thinking tokens (rough approximation: ~4 chars per token)
                                    const thinkingTokens = hasThinking && accumulatedThinking
                                        ? Math.ceil(accumulatedThinking.length / 4)
                                        : null;

                                    messageMetadata = {
                                        tokens: jsonResponse.eval_count,
                                        promptTokens: jsonResponse.prompt_eval_count,
                                        thinkingTokens: thinkingTokens,
                                        speed: speed,
                                        duration: duration
                                    };
                                    console.log('Message metadata captured:', messageMetadata);
                                    console.log('Raw API values:', {
                                        eval_count: jsonResponse.eval_count,
                                        eval_duration: jsonResponse.eval_duration,
                                        prompt_eval_count: jsonResponse.prompt_eval_count,
                                        total_duration: jsonResponse.total_duration
                                    });
                                }
                            }
                        } catch (e) {
                            console.warn('Failed to parse JSON chunk from stream:', jsonStr, e);
                        }
                    }
                }
            }
            console.log('Stream reading complete.');

            // Detect "only thinking, no response" — Qwen3 and similar reasoning models on
            // llama.cpp sometimes stop after the thinking phase without generating actual content.
            // Handles both paths: reasoning_content field (hasThinking) and raw <think> tags in content.
            const contentMinusThink = accumulatedContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            const onlyThinkingGenerated = (hasThinking && accumulatedThinking && !accumulatedContent.trim())
                || (!hasThinking && !contentMinusThink && /<think>/i.test(accumulatedContent));
            if (onlyThinkingGenerated) {
                console.warn('[Stream] Only thinking generated — no actual content from model. Showing fallback note.');
                const note = '*(No response was generated — the model stopped after its thinking phase. Try rephrasing your message or reducing context length.)*';
                // Set accumulatedContent so finalBotMessageToSave builds cleanly
                if (hasThinking) {
                    accumulatedContent = note; // thinking is in accumulatedThinking
                } else {
                    accumulatedContent += '\n\n' + note; // raw <think> path — keep tags for saving
                }
                const displayText = hasThinking
                    ? `<think>\n${accumulatedThinking}\n</think>\n\n${note}`
                    : accumulatedContent;
                botTextElement.innerHTML = '';
                botTextElement.appendChild(renderMarkdownWithThinking(displayText, false));
                botTextElement.dataset.fullMessage = displayText;
            }

            // Add metadata display to the message
            if (messageMetadata && botMessageDiv) {
                addMetadataToMessage(botMessageDiv, messageMetadata);
            }

            // Build final message with thinking if present
            let finalBotMessageToSave = '';
            if (hasThinking && accumulatedThinking) {
                finalBotMessageToSave = `<think>\n${accumulatedThinking}\n</think>\n\n${accumulatedContent}`;
            } else {
                finalBotMessageToSave = accumulatedContent;
            }

            // Update the dataset to ensure consistency
            botTextElement.dataset.fullMessage = finalBotMessageToSave;
            const messageToSave = { role: 'assistant', content: finalBotMessageToSave };
            if (messageMetadata) {
                messageToSave.metadata = messageMetadata;
            }
            currentConversation.messages.push(messageToSave);
            currentConversation.summary = getConversationSummary(currentConversation.messages);
            currentConversation.lastMessageTime = Date.now();

            // Auto-extract memories from this exchange (fire-and-forget)
            if ((memoryEnabled || memoryAutoExtract) && lastUserMsg) {
                triggerMemoryExtraction(lastUserMsg.content, accumulatedContent);
            }

            // Update context indicator after receiving response
            await updateContextIndicator(currentConversation.messages, modelData.systemPrompt, modelData);

        } catch (error) {
            if (error.name === 'AbortError') {
                // User stopped generation — save whatever was streamed so far, no error shown
                console.log('Request aborted by user');
                const partialContent = botTextElement ? (botTextElement.dataset.fullMessage || '').trim() : '';
                if (partialContent) {
                    currentConversation.messages.push({ role: 'assistant', content: partialContent });
                    currentConversation.summary = getConversationSummary(currentConversation.messages);
                    currentConversation.lastMessageTime = Date.now();
                }
            } else {
                console.error('Error in triggerLLMCompletion:', error);
                let errorMessage = 'Error communicating with the model. Please check the proxy server and Ollama status.';

                if (error.message && error.message.includes('Ollama API Error')) {
                    errorMessage = error.message;

                    // Handle vision model specific errors
                    if (selectedFiles.length > 0 && (
                        error.message.includes('exit status 2') ||
                        error.message.includes('runner process has terminated') ||
                        error.message.includes('500')
                    )) {
                        errorMessage = `This model (${currentModelName}) may not support images. Try a vision model like LLaVA instead.`;
                        console.warn(`[Vision Error] Model ${currentModelName} failed with images:`, error.message);
                    }
                }

                updateBotMessageInUI(botTextElement, `\n\n[Error: ${errorMessage}]`);
                const currentBotContent = botTextElement.dataset.fullMessage || botTextElement.textContent || '';
                currentConversation.messages.push({ role: 'assistant', content: currentBotContent });
                currentConversation.lastMessageTime = Date.now();
            }
        } finally {
            console.log('triggerLLMCompletion finally block completed');

            // Reset streaming flag
            isStreaming = false;

            // Hide stop button and clear abort controller
            if (stopButton) {
                stopButton.style.display = 'none';
            }
            currentAbortController = null;
            if (botTextElement) botTextElement.dataset.fullMessage = '';

            // Remove streaming class from message
            if (botMessageDiv) {
                botMessageDiv.classList.remove('streaming');
            }

            // Always hide the loading indicator when done, with null check
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
            messageInput.disabled = false;
            sendButton.disabled = false;
            messageInput.focus();

            await saveModelChatState(currentModelName, modelData);
            populateConversationSidebar(currentModelName, modelData);
            console.log('UI unlocked, state saved, sidebar repopulated in finally block.');
            updateRegenerateButton();
        }
    }

    async function sendMessageToOllama(prompt) {
        if (!prompt || prompt.trim() === '') return;

        // Clear draft for current conversation when sending
        let modelData = await loadModelChatState(currentModelName);
        if (modelData.activeConversationId) {
            await clearDraft(modelData.activeConversationId);
        }

        modelData = await loadModelChatState(currentModelName);
        if (!modelData.activeConversationId || !modelData.conversations[modelData.activeConversationId]) {
            console.warn('No active or valid conversation found, attempting to start a new one.');
            await startNewConversation(currentModelName);
            modelData = await loadModelChatState(currentModelName);
            if (!modelData.activeConversationId || !modelData.conversations[modelData.activeConversationId]) {
                console.error('Failed to start or find an active conversation after attempting to create one.');
                addMessageToChatUI('System', 'Error: Could not establish an active conversation. Please try refreshing or creating a new chat manually.', 'error-message', modelData);
                return;
            }
        }
        const activeConvId = modelData.activeConversationId;
        const currentConversation = modelData.conversations[activeConvId];

        // Prepare user message with attachments if any
        const userMessage = { role: 'user', content: prompt };
        if (selectedFiles.length > 0) {
            userMessage.attachments = selectedFiles.map(file => ({
                type: file.fileType,
                base64: file.base64 || null,
                textContent: file.textContent || null,
                fileName: file.fileName,
                fileSize: file.fileSize,
                mimeType: file.mimeType
            }));
        }

        // Push message first so index is correct, then add to UI
        currentConversation.messages.push(userMessage);
        currentConversation.summary = getConversationSummary(currentConversation.messages);
        currentConversation.lastMessageTime = Date.now();
        addMessageToChatUI('You', prompt, 'user-message', modelData, userMessage.attachments, currentConversation.messages.length - 1);

        messageInput.value = '';
        autoResizeInput();
        clearSelectedFiles(); // Clear files after sending

        await triggerLLMCompletion(modelData);
    }

    function enterEditMode(messageDiv, textContentDiv, messageIndex) {
        if (messageDiv.classList.contains('editing')) return;
        messageDiv.classList.add('editing');
        const originalText = textContentDiv.textContent;
        textContentDiv.style.display = 'none';
        const actionsDiv = messageDiv.querySelector('.message-actions');
        if (actionsDiv) actionsDiv.style.display = 'none';

        const editContainer = document.createElement('div');
        editContainer.classList.add('message-edit-container');

        const textarea = document.createElement('textarea');
        textarea.classList.add('message-edit-textarea');
        textarea.value = originalText;

        const buttonRow = document.createElement('div');
        buttonRow.classList.add('message-edit-buttons');

        const saveBtn = document.createElement('button');
        saveBtn.classList.add('message-edit-save');
        saveBtn.textContent = 'Save & Send';

        const cancelBtn = document.createElement('button');
        cancelBtn.classList.add('message-edit-cancel');
        cancelBtn.textContent = 'Cancel';

        buttonRow.appendChild(saveBtn);
        buttonRow.appendChild(cancelBtn);
        editContainer.appendChild(textarea);
        editContainer.appendChild(buttonRow);
        messageDiv.appendChild(editContainer);

        // Auto-resize
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        });
        textarea.focus();
        textarea.style.height = textarea.scrollHeight + 'px';

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancelBtn.click();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveBtn.click();
            }
        });

        saveBtn.addEventListener('click', async () => {
            const newContent = textarea.value.trim();
            if (!newContent) return;
            exitEditMode(messageDiv, textContentDiv, actionsDiv, editContainer);
            await saveEditedMessage(messageIndex, newContent);
        });

        cancelBtn.addEventListener('click', () => {
            exitEditMode(messageDiv, textContentDiv, actionsDiv, editContainer);
        });
    }

    function exitEditMode(messageDiv, textContentDiv, actionsDiv, editContainer) {
        messageDiv.classList.remove('editing');
        textContentDiv.style.display = '';
        if (actionsDiv) actionsDiv.style.display = '';
        if (editContainer && editContainer.parentNode === messageDiv) {
            messageDiv.removeChild(editContainer);
        }
    }

    async function saveEditedMessage(messageIndex, newContent) {
        if (isStreaming) return;
        let modelData = await loadModelChatState(currentModelName);
        const activeConvId = modelData.activeConversationId;
        if (!activeConvId || !modelData.conversations[activeConvId]) return;
        const conversation = modelData.conversations[activeConvId];

        // Preserve images from original message if present
        const originalMsg = conversation.messages[messageIndex];
        const updatedMsg = { ...originalMsg, content: newContent };
        delete updatedMsg.metadata;

        // Truncate and replace
        conversation.messages = conversation.messages.slice(0, messageIndex);
        conversation.messages.push(updatedMsg);
        conversation.summary = getConversationSummary(conversation.messages);
        conversation.lastMessageTime = Date.now();

        await saveModelChatState(currentModelName, modelData);
        displayConversationMessages(modelData, activeConvId);
        await triggerLLMCompletion(modelData);
    }

    async function regenerateLastResponse() {
        if (isStreaming) return;
        let modelData = await loadModelChatState(currentModelName);
        const activeConvId = modelData.activeConversationId;
        if (!activeConvId || !modelData.conversations[activeConvId]) return;
        const conversation = modelData.conversations[activeConvId];
        const messages = conversation.messages;
        if (messages.length === 0 || messages[messages.length - 1].role !== 'assistant') return;

        conversation.messages = messages.slice(0, messages.length - 1);
        conversation.lastMessageTime = Date.now();
        await saveModelChatState(currentModelName, modelData);
        displayConversationMessages(modelData, activeConvId);
        await triggerLLMCompletion(modelData);
    }

    function updateRegenerateButton() {
        document.querySelectorAll('.regenerate-button').forEach(btn => btn.remove());
        if (isStreaming) return;
        const allBotMessages = chatContainer.querySelectorAll('.bot-message');
        if (allBotMessages.length === 0) return;
        const lastBotMessage = allBotMessages[allBotMessages.length - 1];
        const actionsDiv = lastBotMessage.querySelector('.message-actions');
        if (!actionsDiv) return;

        const regenBtn = document.createElement('button');
        regenBtn.classList.add('action-button', 'regenerate-button');
        regenBtn.title = 'Regenerate response';
        regenBtn.appendChild(createLucideIcon('refresh-cw', 16));
        regenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            regenerateLastResponse();
        });
        actionsDiv.insertBefore(regenBtn, actionsDiv.firstChild);
    }


    async function clearAllConversationsForModel(modelToClear) {
        // This function now just opens the clear context modal
        // The actual clearing is handled by clearContextKeepingSystemPrompt()
        console.log(`Opening clear context modal for model: ${modelToClear}`);
        openClearContextModal();
    }

    async function switchModel(newModelName) {
        const oldModelName = currentModelName;
        if (newModelName === oldModelName) return;
        const wasLlamaCpp = currentModelBackend === 'llamacpp';
        currentModelBackend = 'ollama';
        currentLlamaCppPath = null;
        if (wasLlamaCpp) checkServerStatus();
        console.log('[OllamaBro] switchModel - Switching from:', oldModelName, 'to:', newModelName);
        console.log(`Switching model to: ${newModelName}`);

        // Save draft for current conversation before switching
        let oldModelData = await loadModelChatState(oldModelName);
        if (oldModelData.activeConversationId && messageInput.value.trim()) {
            await saveDraft(oldModelData.activeConversationId, messageInput.value);
        }

        currentModelName = newModelName;
        chrome.storage.local.set({ lastUsedOllamaModel: newModelName });
        sidebarSearchQuery = '';
        sidebarTagFilter = '';
        conversationSearchInput.value = '';
        clearSearchButton.style.display = 'none';
        updateModelDisplay(currentModelName);

        // Clear any selected images when switching models
        clearSelectedFiles();

        // Show image upload UI (users can upload images to any model, API will error if unsupported)
        toggleFileUploadUI(true);

        let modelData = await loadModelChatState(currentModelName);
        if (!modelData.activeConversationId || !modelData.conversations[modelData.activeConversationId]) {
            await startNewConversation(currentModelName); // Start new if no active or no convs
        } else {
            displayConversationMessages(modelData, modelData.activeConversationId);
            populateConversationSidebar(currentModelName, modelData);

            // Load draft for the new conversation
            const draftText = await loadDraft(modelData.activeConversationId);
            messageInput.value = draftText || '';
        }
        messageInput.disabled = false;
        sendButton.disabled = false;
        messageInput.focus();
    }

    async function switchToLlamaCpp(cppModel) {
        // Save draft for current conversation
        const oldModelData = await loadModelChatState(currentModelName);
        if (oldModelData.activeConversationId && messageInput.value.trim()) {
            await saveDraft(oldModelData.activeConversationId, messageInput.value);
        }

        // Disable web search / deep research (Ollama-only features)
        if (webSearchEnabled) {
            webSearchEnabled = false;
            webSearchButton.classList.remove('active');
            webSearchButton.title = 'Web Search: OFF';
        }
        if (deepResearchEnabled) {
            deepResearchEnabled = false;
            deepResearchButton.classList.remove('active');
            deepResearchButton.title = 'Deep Research: OFF';
        }

        // Show loading state
        messageInput.disabled = true;
        sendButton.disabled = true;
        const prevDisplay = modelNameDisplay.textContent;
        modelNameDisplay.textContent = 'Starting model...';
        updateServerStatusDot('degraded', 'llama.cpp: loading...');

        try {
            const resp = await fetch(`${PROXY_BASE}/api/llamacpp/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelPath: cppModel._path })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${resp.status}`);
            }

            // Switch succeeded — update state
            currentModelBackend = 'llamacpp';
            currentLlamaCppPath = cppModel._path;
            currentModelName = cppModel.name;
            sidebarSearchQuery = '';
            sidebarTagFilter = '';
            conversationSearchInput.value = '';
            clearSearchButton.style.display = 'none';
            updateModelDisplay(currentModelName);
        clearSelectedFiles();
            toggleFileUploadUI(false); // vision not supported via llama.cpp yet
            checkServerStatus();

            let modelData = await loadModelChatState(currentModelName);
            if (!modelData.activeConversationId || !modelData.conversations[modelData.activeConversationId]) {
                await startNewConversation(currentModelName);
            } else {
                displayConversationMessages(modelData, modelData.activeConversationId);
                populateConversationSidebar(currentModelName, modelData);
                const draftText = await loadDraft(modelData.activeConversationId);
                messageInput.value = draftText || '';
            }
        } catch (err) {
            console.error('[llama.cpp] Failed to load model:', err);
            modelNameDisplay.textContent = prevDisplay;
            addMessageToChatUI('System', `⚡ Failed to start llama.cpp model: ${err.message}`, 'bot-message');
            checkServerStatus();
        } finally {
            messageInput.disabled = false;
            sendButton.disabled = false;
            messageInput.focus();
        }
    }

    async function fetchAvailableModels() {
        availableModels = [];
        llamaCppModels = [];

        // Fetch Ollama models
        try {
            const response = await fetch(`${PROXY_BASE}/proxy/api/tags`);
            if (response.ok) {
                const data = await response.json();
                availableModels = (data.models || []).map(m => ({ ...m, _backend: 'ollama' }));
            } else {
                console.error('Failed to fetch Ollama models:', response.status);
            }
        } catch (e) {
            console.warn('[OllamaBro] Could not fetch Ollama models:', e);
        }

        // Fetch llama.cpp models
        try {
            const lcResp = await fetch(`${PROXY_BASE}/api/llamacpp/models`);
            if (lcResp.ok) {
                const lcData = await lcResp.json();
                llamaCppModels = lcData.models || [];
                // Merge into availableModels with backend tag
                const cppEntries = llamaCppModels.map(m => ({
                    name: m.name,
                    size: m.size,
                    _backend: 'llamacpp',
                    _path: m.path
                }));
                availableModels = availableModels.concat(cppEntries);
            }
        } catch (e) {
            console.warn('[OllamaBro] Could not fetch llama.cpp models:', e);
        }

        return availableModels;
    }

    function populateModelDropdown(models, currentModel) {
        modelSwitcherDropdown.innerHTML = '';
        const ul = document.createElement('ul');

        const ollamaModels = models.filter(m => m._backend !== 'llamacpp');
        const cppModels = models.filter(m => m._backend === 'llamacpp');

        if (ollamaModels.length === 0 && cppModels.length === 0) {
            const noModelsItem = document.createElement('li');
            noModelsItem.textContent = 'No models found.';
            noModelsItem.classList.add('model-dropdown-item', 'no-models');
            ul.appendChild(noModelsItem);
            modelSwitcherDropdown.appendChild(ul);
            return;
        }

        function buildModelRow(modelName, modelSize, isCloud) {
            const modelNameContainer = document.createElement('div');
            modelNameContainer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:100%';

            const modelNameSpan = document.createElement('span');
            modelNameSpan.textContent = modelName;
            modelNameContainer.appendChild(modelNameSpan);

            const detailsContainer = document.createElement('div');
            detailsContainer.style.cssText = 'display:flex;align-items:center;gap:8px';

            if (isCloud) detailsContainer.appendChild(makeCloudBadge(14));

            if (modelSize) {
                const sizeSpan = document.createElement('span');
                sizeSpan.classList.add('model-size');
                const sizeGB = (modelSize / (1024 * 1024 * 1024)).toFixed(2);
                sizeSpan.textContent = `${sizeGB} GB`;
                sizeSpan.style.color = 'var(--text-muted)';
                sizeSpan.style.fontSize = '0.9em';
                detailsContainer.appendChild(sizeSpan);
            }

            if (detailsContainer.children.length > 0) modelNameContainer.appendChild(detailsContainer);
            return modelNameContainer;
        }

        // Ollama models
        ollamaModels.forEach(model => {
            const modelName = model.name || model;
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = '#';
            a.appendChild(buildModelRow(modelName, model.size, isCloudModel(modelName)));
            a.dataset.modelName = modelName;
            li.classList.add('model-dropdown-item');
            if (modelName === currentModel) li.classList.add('active-model');
            a.addEventListener('click', async (e) => {
                e.preventDefault();
                if (modelName !== currentModelName) await switchModel(modelName);
                modelSwitcherDropdown.style.display = 'none';
                ul.querySelectorAll('li.model-dropdown-item').forEach(i => i.classList.remove('active-model'));
                li.classList.add('active-model');
            });
            li.appendChild(a);
            ul.appendChild(li);
        });

        // llama.cpp section
        if (cppModels.length > 0) {
            const sep = document.createElement('li');
            sep.className = 'model-dropdown-separator';
            sep.innerHTML = '<span>⚡ llama.cpp</span>';
            ul.appendChild(sep);

            cppModels.forEach(model => {
                const li = document.createElement('li');
                const a = document.createElement('a');
                a.href = '#';
                a.appendChild(buildModelRow(model.name, model.size, false));
                a.dataset.modelName = model.name;
                li.classList.add('model-dropdown-item');
                if (model.name === currentModel) li.classList.add('active-model');
                a.addEventListener('click', async (e) => {
                    e.preventDefault();
                    modelSwitcherDropdown.style.display = 'none';
                    await switchToLlamaCpp(model);
                });
                li.appendChild(a);
                ul.appendChild(li);
            });
        }

        modelSwitcherDropdown.appendChild(ul);
    }

    async function init() {
        let urlModel = new URLSearchParams(window.location.search).get('model');
        if (!urlModel) {
            // No model in URL — pick last used Ollama model, or fall back to first available
            const models = await fetchAvailableModels();
            const ollamaModels = models.filter(m => m._backend !== 'llamacpp');
            const stored = await chrome.storage.local.get('lastUsedOllamaModel');
            const lastUsed = stored.lastUsedOllamaModel;
            const match = lastUsed && ollamaModels.find(m => m.name === lastUsed);
            urlModel = match ? lastUsed : (ollamaModels[0] ? ollamaModels[0].name : null);
            if (!urlModel) {
                modelNameDisplay.textContent = 'No models found.';
                addMessageToChatUI('System', 'No Ollama models found. Make sure Ollama is running.', 'bot-message');
                messageInput.disabled = true; sendButton.disabled = true;
                return;
            }
        }
        currentModelName = urlModel;
        console.log('[OllamaBro] init - Initializing chat for model from URL:', currentModelName);
        updateModelDisplay(currentModelName);

        // Show image upload UI (users can upload images to any model, API will error if unsupported)
        toggleFileUploadUI(true);

        let modelData = await loadModelChatState(currentModelName);
        if (!modelData.activeConversationId || !modelData.conversations[modelData.activeConversationId]) {
            await startNewConversation(currentModelName);
        } else {
            displayConversationMessages(modelData, modelData.activeConversationId);
            populateConversationSidebar(currentModelName, modelData);

            // Load draft for active conversation
            const draftText = await loadDraft(modelData.activeConversationId);
            if (draftText) {
                messageInput.value = draftText;
            }
        }

        messageInput.disabled = false;
        sendButton.disabled = false;
        messageInput.focus();

        // Sidebar collapse/expand persistence
        const savedSidebarState = await chrome.storage.local.get(sidebarStateKey);
        if (savedSidebarState && savedSidebarState[sidebarStateKey] === 'collapsed') {
            conversationSidebar.classList.add('collapsed');
            collapseSidebarButton.innerHTML = '&#x2192;'; // Right arrow
        } else {
            conversationSidebar.classList.remove('collapsed');
            collapseSidebarButton.innerHTML = '&#x2190;'; // Left arrow
        }

        // Initialize Lucide icons for new elements
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        // Load slash commands
        slashCommands = await loadSlashCommands();

        // Setup scroll detection
        chatContainer.addEventListener('scroll', handleScroll, { passive: true });

        // Start persistent server status indicator
        startServerStatusPoll();
    }

    // Message history navigation (persistent via chrome.storage.local)
    const MESSAGE_HISTORY_KEY = 'inputMessageHistory';
    const messageHistory = [];
    let historyIndex = -1;
    let historyDraft = '';

    // Load persisted history on startup
    chrome.storage.local.get(MESSAGE_HISTORY_KEY, (result) => {
        const saved = result[MESSAGE_HISTORY_KEY];
        if (Array.isArray(saved)) messageHistory.push(...saved);
    });

    function pushToHistory(text) {
        if (!text.trim()) return;
        if (messageHistory[messageHistory.length - 1] === text) return; // no duplicates
        messageHistory.push(text);
        if (messageHistory.length > 50) messageHistory.shift();
        historyIndex = -1;
        chrome.storage.local.set({ [MESSAGE_HISTORY_KEY]: messageHistory });
    }

    messageInput.addEventListener('keydown', (e) => {
        // Slash command popup navigation takes priority
        if (slashCommandPopup.classList.contains('visible')) {
            const items = slashCommandPopup.querySelectorAll('.slash-cmd-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashPopupSelected(Math.min(slashPopupSelectedIndex + 1, items.length - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashPopupSelected(Math.max(slashPopupSelectedIndex - 1, 0));
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const idx = slashPopupSelectedIndex >= 0 ? slashPopupSelectedIndex : 0;
                if (slashPopupFiltered[idx]) applySlashCommand(slashPopupFiltered[idx]);
                return;
            }
            if (e.key === 'Escape') {
                hideSlashPopup();
                return;
            }
        }

        if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            pushToHistory(messageInput.value);
            sendMessageToOllama(messageInput.value);
            return;
        }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        if (messageHistory.length === 0) return;
        e.preventDefault();

        if (e.key === 'ArrowUp') {
            if (historyIndex === -1) {
                historyDraft = messageInput.value; // save current draft on first navigation
                historyIndex = messageHistory.length - 1;
            } else if (historyIndex > 0) {
                historyIndex--;
            }
            messageInput.value = messageHistory[historyIndex];
        } else { // ArrowDown
            if (historyIndex === -1) return;
            if (historyIndex < messageHistory.length - 1) {
                historyIndex++;
                messageInput.value = messageHistory[historyIndex];
            } else {
                historyIndex = -1;
                messageInput.value = historyDraft;
            }
        }
        // Move cursor to end
        messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
    });

    // Event Listeners
    sendButton.addEventListener('click', () => { pushToHistory(messageInput.value); sendMessageToOllama(messageInput.value); });
    messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey && !slashCommandPopup.classList.contains('visible')) { e.preventDefault(); pushToHistory(messageInput.value); sendMessageToOllama(messageInput.value); } });

    // Auto-resize the main message input to fit its content
    function autoResizeInput() {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
        updateInputTokenCount();
    }

    // Save draft as user types (debounced) + slash command detection
    let draftSaveTimeout;
    messageInput.addEventListener('input', () => {
        autoResizeInput();
        handleSlashInput();
        clearTimeout(draftSaveTimeout);
        draftSaveTimeout = setTimeout(async () => {
            const modelData = await loadModelChatState(currentModelName);
            if (modelData.activeConversationId && messageInput.value.trim()) {
                await saveDraft(modelData.activeConversationId, messageInput.value);
            }
        }, 500); // Save 500ms after user stops typing
    });

    // Scroll to bottom button
    const scrollToBottomButton = document.getElementById('scrollToBottomButton');
    if (scrollToBottomButton) {
        scrollToBottomButton.addEventListener('click', () => {
            scrollToBottom(true);
            isUserScrolledUp = false;
            scrollToBottomButton.style.display = 'none';
        });
    }

    clearChatButton.addEventListener('click', () => openClearContextModal());
    exportChatButton.addEventListener('click', exportConversation);

    newChatButton.addEventListener('click', () => startNewConversation(currentModelName));

    conversationSearchInput.addEventListener('input', async () => {
        sidebarSearchQuery = conversationSearchInput.value;
        clearSearchButton.style.display = sidebarSearchQuery ? 'flex' : 'none';
        const modelData = await loadModelChatState(currentModelName);
        populateConversationSidebar(currentModelName, modelData);
    });

    clearSearchButton.addEventListener('click', async () => {
        conversationSearchInput.value = '';
        sidebarSearchQuery = '';
        clearSearchButton.style.display = 'none';
        const modelData = await loadModelChatState(currentModelName);
        populateConversationSidebar(currentModelName, modelData);
        conversationSearchInput.focus();
    });

    // Settings modal event listeners
    if (settingsButton) {
        settingsButton.addEventListener('click', openSettingsModal);
    }

    const modelParamsButton = document.getElementById('modelParamsButton');
    if (modelParamsButton) {
        modelParamsButton.addEventListener('click', () => {
            openSettingsModal();
            // Ensure the Model Parameters section is expanded
            const body = document.getElementById('paramSectionBody');
            const toggle = document.getElementById('paramSectionToggle');
            if (body && !body.classList.contains('expanded')) {
                body.classList.add('expanded');
                toggle.classList.add('expanded');
                if (typeof lucide !== 'undefined') lucide.createIcons();
            }
        });
    }

    if (closeSettingsModalButton) {
        closeSettingsModalButton.addEventListener('click', closeSettingsModal);
    }

    if (saveSystemPromptButton) {
        saveSystemPromptButton.addEventListener('click', saveSystemPrompt);
    }

    if (clearSystemPromptButton) {
        clearSystemPromptButton.addEventListener('click', clearSystemPrompt);
    }

    if (systemPromptInput) {
        systemPromptInput.addEventListener('input', updateSystemPromptTokenCount);
    }

    // Model parameter event listeners
    const paramSectionToggle = document.getElementById('paramSectionToggle');
    if (paramSectionToggle) {
        paramSectionToggle.addEventListener('click', toggleParamSection);
    }

    const paramResetButton = document.getElementById('paramResetButton');
    if (paramResetButton) {
        paramResetButton.addEventListener('click', resetParamInputs);
    }

    const updateCurrentModelButton = document.getElementById('updateCurrentModelButton');
    if (updateCurrentModelButton) {
        updateCurrentModelButton.addEventListener('click', updateCurrentModel);
    }

    const appearanceSectionToggle = document.getElementById('appearanceSectionToggle');
    if (appearanceSectionToggle) {
        appearanceSectionToggle.addEventListener('click', () => toggleSection('appearanceSectionToggle', 'appearanceSectionBody'));
    }

    const modelMgmtSectionToggle = document.getElementById('modelMgmtSectionToggle');
    if (modelMgmtSectionToggle) {
        modelMgmtSectionToggle.addEventListener('click', () => toggleSection('modelMgmtSectionToggle', 'modelMgmtSectionBody'));
    }

    const updateAllModelsButton = document.getElementById('updateAllModelsButton');
    if (updateAllModelsButton) {
        updateAllModelsButton.addEventListener('click', updateAllModels);
    }

    // Pull new model UI
    const pullNewModelButton = document.getElementById('pullNewModelButton');
    const pullNewModelInput = document.getElementById('pullNewModelInput');
    const pullNewModelProgress = document.getElementById('pullNewModelProgress');
    const pullNewModelBar = document.getElementById('pullNewModelBar');
    const pullNewModelStatus = document.getElementById('pullNewModelStatus');
    if (pullNewModelButton && pullNewModelInput) {
        pullNewModelButton.addEventListener('click', async () => {
            const name = pullNewModelInput.value.trim();
            if (!name) return;
            pullNewModelProgress.style.display = 'block';
            pullNewModelBar.style.width = '0%';
            await pullModel(name, pullNewModelStatus, pullNewModelButton, pullNewModelBar);
            populateMgmtModelList();
        });
        pullNewModelInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') pullNewModelButton.click();
        });
    }

    const refreshMgmtListButton = document.getElementById('refreshMgmtListButton');
    if (refreshMgmtListButton) {
        refreshMgmtListButton.addEventListener('click', populateMgmtModelList);
    }

    const openLlmfitButton = document.getElementById('openLlmfitButton');
    if (openLlmfitButton) {
        openLlmfitButton.addEventListener('click', openLlmfitModal);
    }

    const closeLlmfitModalButton = document.getElementById('closeLlmfitModal');
    if (closeLlmfitModalButton) {
        closeLlmfitModalButton.addEventListener('click', closeLlmfitModal);
    }

    const llmfitModal = document.getElementById('llmfitModal');
    if (llmfitModal) {
        llmfitModal.addEventListener('click', e => { if (e.target === llmfitModal) closeLlmfitModal(); });
    }

    // Set up bidirectional slider ↔ number sync
    setupParamSync('paramTemperatureSlider', 'paramTemperature', 0.8);
    setupParamSync('paramTopPSlider', 'paramTopP', 0.9);
    setupParamSync('paramTopKSlider', 'paramTopK', 40);
    setupParamSync('paramRepeatPenaltySlider', 'paramRepeatPenalty', 1.1);

    // Collapsible section toggles for System Prompt, Context Window, TTS
    const systemPromptSectionToggle = document.getElementById('systemPromptSectionToggle');
    if (systemPromptSectionToggle) {
        systemPromptSectionToggle.addEventListener('click', () => toggleSection('systemPromptSectionToggle', 'systemPromptSectionBody'));
    }

    const contextWindowSectionToggle = document.getElementById('contextWindowSectionToggle');
    if (contextWindowSectionToggle) {
        contextWindowSectionToggle.addEventListener('click', () => toggleSection('contextWindowSectionToggle', 'contextWindowSectionBody'));
    }

    const ttsSectionToggle = document.getElementById('ttsSectionToggle');
    if (ttsSectionToggle) {
        ttsSectionToggle.addEventListener('click', () => toggleSection('ttsSectionToggle', 'ttsSectionBody'));
    }

    const llamaCppSectionToggle = document.getElementById('llamaCppSectionToggle');
    if (llamaCppSectionToggle) {
        llamaCppSectionToggle.addEventListener('click', () => {
            toggleSection('llamaCppSectionToggle', 'llamaCppSectionBody');
            const body = document.getElementById('llamaCppSectionBody');
            if (body && body.classList.contains('expanded')) loadLlamaCppSettings();
        });
    }

    const saveLlamaCppConfigBtn = document.getElementById('saveLlamaCppConfig');
    if (saveLlamaCppConfigBtn) {
        saveLlamaCppConfigBtn.addEventListener('click', saveLlamaCppSettings);
    }

    const stopLlamaCppBtn = document.getElementById('stopLlamaCppServer');
    if (stopLlamaCppBtn) {
        stopLlamaCppBtn.addEventListener('click', async () => {
            await fetch(`${PROXY_BASE}/api/llamacpp/stop`, { method: 'POST' }).catch(() => {});
            currentModelBackend = 'ollama';
            currentLlamaCppPath = null;
            loadLlamaCppSettings();
        });
    }

    // --- Agent Settings Section ---

    const TOOL_LABELS = {
        webSearch: 'Web Search',
        fetchPage: 'Fetch Page',
        getDateTime: 'Get Date/Time',
        math: 'Math Eval',
        readFile: 'Read File',
        writeFile: 'Write File',
        listDirectory: 'List Directory',
        findFiles: 'Find Files',
        deleteFile: 'Delete File',
        runCode: 'Run Code',
        runShell: 'Run Shell',
    };

    let agentConfig = {
        maxSteps: 15,
        allowedDirs: [],
        blockedPaths: ['C:\\Windows\\System32', 'C:\\Windows\\SysWOW64'],
        toolPermissions: {
            webSearch: 'auto', fetchPage: 'auto', getDateTime: 'auto', math: 'auto',
            readFile: 'confirm', writeFile: 'confirm', listDirectory: 'confirm',
            findFiles: 'confirm', deleteFile: 'confirm',
            runCode: 'disabled', runShell: 'disabled'
        }
    };

    async function loadAgentConfig() {
        try {
            const resp = await fetch(`${PROXY_BASE}/api/agent/config`);
            if (resp.ok) agentConfig = await resp.json();
        } catch {}
        renderAgentSettings();
    }

    function renderAgentSettings() {
        // Max steps slider
        const slider = document.getElementById('agentMaxStepsSlider');
        const sliderVal = document.getElementById('agentMaxStepsValue');
        if (slider) { slider.value = agentConfig.maxSteps; }
        if (sliderVal) sliderVal.textContent = agentConfig.maxSteps;

        // Tool permissions
        const permContainer = document.getElementById('agentToolPermissions');
        if (permContainer) {
            permContainer.innerHTML = '';
            const perms = agentConfig.toolPermissions || {};
            for (const [tool, perm] of Object.entries(perms)) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;';
                const label = document.createElement('span');
                label.style.cssText = 'flex:1;font-size:var(--font-size-sm);color:var(--text-secondary)';
                label.textContent = TOOL_LABELS[tool] || tool;
                const sel = document.createElement('select');
                sel.className = 'settings-select';
                sel.dataset.tool = tool;
                sel.style.cssText = 'width:100px;font-size:var(--font-size-xs)';
                ['auto', 'confirm', 'disabled'].forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = v;
                    if (v === perm) opt.selected = true;
                    sel.appendChild(opt);
                });
                // runShell is always min 'confirm'
                if (tool === 'runShell' && perm === 'auto') sel.value = 'confirm';
                row.append(label, sel);
                permContainer.appendChild(row);
            }
        }

        // Allowed dirs list
        renderPathList('agentAllowedDirsList', agentConfig.allowedDirs || [], 'allowedDir');
        // Blocked paths list
        renderPathList('agentBlockedPathsList', agentConfig.blockedPaths || [], 'blockedPath');
    }

    function renderPathList(containerId, items, type) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        items.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;';
            const span = document.createElement('span');
            span.style.cssText = 'flex:1;font-size:var(--font-size-xs);color:var(--text-secondary);word-break:break-all;';
            span.textContent = p;
            const removeBtn = document.createElement('button');
            removeBtn.className = 'modal-button secondary';
            removeBtn.style.cssText = 'padding:2px 8px;font-size:var(--font-size-xs)';
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', () => {
                if (type === 'allowedDir') agentConfig.allowedDirs.splice(i, 1);
                else agentConfig.blockedPaths.splice(i, 1);
                renderAgentSettings();
            });
            row.append(span, removeBtn);
            container.appendChild(row);
        });
    }

    async function saveAgentConfig() {
        // Collect tool permissions from selects
        const perms = {};
        document.querySelectorAll('#agentToolPermissions select[data-tool]').forEach(sel => {
            perms[sel.dataset.tool] = sel.value;
        });
        agentConfig.toolPermissions = perms;

        const slider = document.getElementById('agentMaxStepsSlider');
        if (slider) agentConfig.maxSteps = parseInt(slider.value, 10);

        const statusEl = document.getElementById('agentConfigStatus');
        try {
            const resp = await fetch(`${PROXY_BASE}/api/agent/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(agentConfig)
            });
            if (resp.ok && statusEl) {
                statusEl.textContent = 'Saved';
                setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
            }
        } catch (e) {
            if (statusEl) statusEl.textContent = 'Error saving';
        }
    }

    function initAgentSettings() {
        const agentSectionToggle = document.getElementById('agentSectionToggle');
        if (agentSectionToggle) {
            agentSectionToggle.addEventListener('click', () => {
                toggleSection('agentSectionToggle', 'agentSectionBody');
                const body = document.getElementById('agentSectionBody');
                if (body && body.classList.contains('expanded')) loadAgentConfig();
            });
        }

        const slider = document.getElementById('agentMaxStepsSlider');
        const sliderVal = document.getElementById('agentMaxStepsValue');
        if (slider && sliderVal) {
            slider.addEventListener('input', () => { sliderVal.textContent = slider.value; });
        }

        const saveBtn = document.getElementById('saveAgentConfig');
        if (saveBtn) saveBtn.addEventListener('click', saveAgentConfig);

        const addDirBtn = document.getElementById('agentAddAllowedDir');
        if (addDirBtn) {
            addDirBtn.addEventListener('click', () => {
                const inp = document.getElementById('agentNewAllowedDir');
                if (inp && inp.value.trim()) {
                    agentConfig.allowedDirs.push(inp.value.trim());
                    inp.value = '';
                    renderAgentSettings();
                }
            });
        }

        const addBlockedBtn = document.getElementById('agentAddBlockedPath');
        if (addBlockedBtn) {
            addBlockedBtn.addEventListener('click', () => {
                const inp = document.getElementById('agentNewBlockedPath');
                if (inp && inp.value.trim()) {
                    agentConfig.blockedPaths.push(inp.value.trim());
                    inp.value = '';
                    renderAgentSettings();
                }
            });
        }
    }

    initAgentSettings();

    // ===== Memory Settings & Management =====

    const MEMORY_AUTO_INJECT_KEY = 'memoryAutoInject';
    const MEMORY_AUTO_EXTRACT_KEY = 'memoryAutoExtract';
    let memoryAutoExtract = false;
    let _allMemories = []; // cached list for filtering

    // Fire-and-forget: ask the model to extract memorable facts from a completed exchange
    function triggerMemoryExtraction(userMessage, assistantMessage) {
        if (!userMessage || !assistantMessage) return;
        const model = currentModelName;
        if (!model) return;
        fetch(`${PROXY_BASE}/api/memory/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userMessage, assistantMessage, model })
        })
        .then(r => r.json())
        .then(data => {
            if (data.saved > 0) {
                console.log(`[Memory] Auto-extracted ${data.saved} fact(s):`, data.facts);
            }
        })
        .catch(err => console.warn('[Memory] Extraction request failed:', err.message));
    }

    async function loadMemoryStatus() {
        const badge = document.getElementById('memoryStatusBadge');
        if (!badge) return;
        try {
            const r = await fetch(`${PROXY_BASE}/api/memory/status`);
            const s = await r.json();
            if (s.available) {
                badge.textContent = `✓ nomic-embed-text ready · ${s.count} memories`;
                badge.className = 'memory-status-badge ok';
            } else {
                badge.textContent = s.reason || 'nomic-embed-text not found';
                badge.className = 'memory-status-badge warn';
            }
        } catch {
            badge.textContent = 'Proxy unreachable';
            badge.className = 'memory-status-badge warn';
        }
    }

    async function openMemoryModal() {
        const modal = document.getElementById('memoryModal');
        if (!modal) return;
        closeSettingsModal();
        modal.classList.add('active');
        await refreshMemoryList();
    }

    function closeMemoryModal() {
        const modal = document.getElementById('memoryModal');
        if (modal) modal.classList.remove('active');
    }

    async function refreshMemoryList(filter = '') {
        const listEl = document.getElementById('memoryList');
        const countEl = document.getElementById('memoryCountLabel');
        if (!listEl) return;

        try {
            const r = await fetch(`${PROXY_BASE}/api/memory`);
            _allMemories = await r.json();
        } catch {
            listEl.innerHTML = '<div class="memory-empty">Failed to load memories.</div>';
            return;
        }

        const query = filter.trim().toLowerCase();
        const shown = query
            ? _allMemories.filter(m => m.text.toLowerCase().includes(query))
            : _allMemories;

        if (countEl) countEl.textContent = `${_allMemories.length} stored`;

        if (shown.length === 0) {
            listEl.innerHTML = `<div class="memory-empty">${_allMemories.length === 0 ? 'No memories yet.' : 'No matches.'}</div>`;
            return;
        }

        listEl.innerHTML = '';
        for (const mem of shown) {
            const item = document.createElement('div');
            item.className = 'memory-item';

            const textPart = document.createElement('div');
            textPart.className = 'memory-item-text';
            textPart.textContent = mem.text;

            if (mem.timestamp) {
                const meta = document.createElement('span');
                meta.className = 'memory-item-meta';
                const d = new Date(mem.timestamp);
                meta.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${mem.source ? ' · ' + mem.source : ''}`;
                textPart.appendChild(meta);
            }

            const delBtn = document.createElement('button');
            delBtn.className = 'memory-item-del';
            delBtn.title = 'Delete memory';
            delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
            delBtn.addEventListener('click', async () => {
                try {
                    await fetch(`${PROXY_BASE}/api/memory/${encodeURIComponent(mem.id)}`, { method: 'DELETE' });
                    await refreshMemoryList(document.getElementById('memorySearchInput')?.value || '');
                    loadMemoryStatus();
                } catch { /* ignore */ }
            });

            item.appendChild(textPart);
            item.appendChild(delBtn);
            listEl.appendChild(item);
        }
    }

    function initMemorySettings() {
        const toggle = document.getElementById('memorySectionToggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                toggleSection('memorySectionToggle', 'memorySectionBody');
                const body = document.getElementById('memorySectionBody');
                if (body && body.classList.contains('expanded')) loadMemoryStatus();
            });
        }

        // Auto-inject preference
        const autoInjectCb = document.getElementById('memoryAutoInjectToggle');
        if (autoInjectCb) {
            chrome.storage.local.get([MEMORY_AUTO_INJECT_KEY], r => {
                const saved = r[MEMORY_AUTO_INJECT_KEY] ?? false;
                autoInjectCb.checked = saved;
                if (saved && !memoryEnabled) {
                    memoryEnabled = true;
                    memoryButton.classList.add('active');
                    memoryButton.title = 'Memory: ON';
                }
            });
            autoInjectCb.addEventListener('change', () => {
                const checked = autoInjectCb.checked;
                chrome.storage.local.set({ [MEMORY_AUTO_INJECT_KEY]: checked });
                memoryEnabled = checked;
                memoryButton.classList.toggle('active', checked);
                memoryButton.title = checked ? 'Memory: ON' : 'Memory: OFF';
            });
        }

        // Auto-extract preference
        const autoExtractCb = document.getElementById('memoryAutoExtractToggle');
        if (autoExtractCb) {
            chrome.storage.local.get([MEMORY_AUTO_EXTRACT_KEY], r => {
                const saved = r[MEMORY_AUTO_EXTRACT_KEY] ?? false;
                autoExtractCb.checked = saved;
                memoryAutoExtract = saved;
            });
            autoExtractCb.addEventListener('change', () => {
                memoryAutoExtract = autoExtractCb.checked;
                chrome.storage.local.set({ [MEMORY_AUTO_EXTRACT_KEY]: memoryAutoExtract });
            });
        }

        // Open memory manager button
        const openBtn = document.getElementById('openMemoryManager');
        if (openBtn) openBtn.addEventListener('click', openMemoryModal);

        // Memory modal wiring
        const closeBtn = document.getElementById('closeMemoryModal');
        if (closeBtn) closeBtn.addEventListener('click', closeMemoryModal);

        const memoryModal = document.getElementById('memoryModal');
        if (memoryModal) {
            memoryModal.addEventListener('click', e => {
                if (e.target === memoryModal) closeMemoryModal();
            });
        }

        // Add memory
        const addBtn = document.getElementById('memoryAddBtn');
        const addInput = document.getElementById('memoryAddInput');
        if (addBtn && addInput) {
            addBtn.addEventListener('click', async () => {
                const text = addInput.value.trim();
                if (!text) return;
                addBtn.disabled = true;
                try {
                    await fetch(`${PROXY_BASE}/api/memory`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text, source: 'manual' })
                    });
                    addInput.value = '';
                    await refreshMemoryList(document.getElementById('memorySearchInput')?.value || '');
                    loadMemoryStatus();
                } catch { /* ignore */ } finally {
                    addBtn.disabled = false;
                }
            });
            addInput.addEventListener('keydown', e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addBtn.click();
            });
        }

        // Search/filter
        const searchInput = document.getElementById('memorySearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                refreshMemoryList(searchInput.value);
            });
        }

        // Clear all
        const clearBtn = document.getElementById('memoryClearAllBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (!confirm('Delete all memories? This cannot be undone.')) return;
                try {
                    await fetch(`${PROXY_BASE}/api/memory/all`, { method: 'DELETE' });
                    await refreshMemoryList('');
                    loadMemoryStatus();
                } catch { /* ignore */ }
            });
        }
    }

    initMemorySettings();

    // Slash command popup: close when input loses focus (unless clicking popup itself)
    messageInput.addEventListener('blur', () => {
        setTimeout(hideSlashPopup, 150);
    });

    // Init slash commands settings section
    initSlashCommandsSettings();

    // Persona preset event listeners
    const personaSectionToggle = document.getElementById('personaSectionToggle');
    if (personaSectionToggle) {
        personaSectionToggle.addEventListener('click', togglePersonaSection);
    }

    const addNewPresetButton = document.getElementById('addNewPresetButton');
    if (addNewPresetButton) {
        addNewPresetButton.addEventListener('click', showNewPresetForm);
    }

    const saveNewPresetButton = document.getElementById('saveNewPresetButton');
    if (saveNewPresetButton) {
        saveNewPresetButton.addEventListener('click', saveNewPersonaPreset);
    }

    const cancelNewPresetButton = document.getElementById('cancelNewPresetButton');
    if (cancelNewPresetButton) {
        cancelNewPresetButton.addEventListener('click', hideNewPresetForm);
    }

    // Clear context modal event listeners
    if (closeClearContextModalButton) {
        closeClearContextModalButton.addEventListener('click', closeClearContextModal);
    }

    if (cancelClearContextButton) {
        cancelClearContextButton.addEventListener('click', closeClearContextModal);
    }

    if (confirmClearContextButton) {
        confirmClearContextButton.addEventListener('click', clearContextKeepingSystemPrompt);
    }

    // Close modals on backdrop click
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) closeSettingsModal();
        });
    }

    if (clearContextModal) {
        clearContextModal.addEventListener('click', (e) => {
            if (e.target === clearContextModal) closeClearContextModal();
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const inInput = document.activeElement === messageInput || document.activeElement === systemPromptInput;
        const anyModalOpen = (settingsModal && settingsModal.classList.contains('active')) ||
                             (clearContextModal && clearContextModal.classList.contains('active')) ||
                             (shortcutsModal && shortcutsModal.classList.contains('active'));

        // Escape: close modals or abort generation
        if (e.key === 'Escape') {
            if (settingsModal && settingsModal.classList.contains('active')) { closeSettingsModal(); return; }
            if (clearContextModal && clearContextModal.classList.contains('active')) { closeClearContextModal(); return; }
            if (shortcutsModal && shortcutsModal.classList.contains('active')) { closeShortcutsModal(); return; }
            if (dashboardModal && dashboardModal.classList.contains('active')) { closeDashboardModal(); return; }
            if (isStreaming && currentAbortController) {
                currentAbortController.abort();
            }
            return;
        }

        // Alt+H — show shortcuts panel
        if (e.key.toLowerCase() === 'h' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            shortcutsModal && shortcutsModal.classList.contains('active') ? closeShortcutsModal() : openShortcutsModal();
            return;
        }

        // Don't fire Ctrl shortcuts when a modal is open or user is in system prompt textarea
        if (anyModalOpen || document.activeElement === systemPromptInput) return;

        // Alt+N — new chat (Ctrl+N is reserved by Chrome for new window)
        if (e.key.toLowerCase() === 'n' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            startNewConversation(currentModelName);
        }

        // Alt+V — toggle voice input
        if (e.key.toLowerCase() === 'v' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            if (micButton && micButton.style.display !== 'none') micButton.click();
        }

        // Alt+I — add file (open file picker)
        if (e.key.toLowerCase() === 'i' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            if (fileButton && fileButton.style.display !== 'none') fileInput && fileInput.click();
        }

        // Alt+W — toggle web search
        if (e.key.toLowerCase() === 'w' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            webSearchButton.click();
        }

        // Alt+R — toggle deep research
        if (e.key.toLowerCase() === 'r' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            deepResearchButton.click();
        }

        // Alt+A — toggle agent mode
        if (e.key.toLowerCase() === 'a' && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            e.preventDefault();
            agentModeButton.click();
        }

        if (e.ctrlKey && !e.shiftKey && !e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'd': {
                    e.preventDefault();
                    (async () => {
                        const modelData = await loadModelChatState(currentModelName);
                        if (modelData.activeConversationId) {
                            handleDeleteConversation(currentModelName, modelData.activeConversationId);
                        }
                    })();
                    break;
                }
                case 'r': {
                    e.preventDefault();
                    const botMessages = chatContainer.querySelectorAll('.bot-message');
                    const lastBot = botMessages[botMessages.length - 1];
                    if (lastBot) {
                        const ttsBtn = lastBot.querySelector('.tts-button');
                        const textDiv = lastBot.querySelector('.message-text-content');
                        if (ttsBtn && textDiv) speakText(textDiv, ttsBtn);
                    }
                    break;
                }
            }
        }
    });

    // Shortcuts modal event listeners
    if (closeShortcutsModalButton) {
        closeShortcutsModalButton.addEventListener('click', closeShortcutsModal);
    }
    if (shortcutsModal) {
        shortcutsModal.addEventListener('click', (e) => {
            if (e.target === shortcutsModal) closeShortcutsModal();
        });
    }
    const openShortcutsFromSettings = document.getElementById('openShortcutsFromSettings');
    if (openShortcutsFromSettings) {
        openShortcutsFromSettings.addEventListener('click', () => {
            closeSettingsModal();
            openShortcutsModal();
        });
    }

    // File upload event listeners
    if (fileButton && fileInput) {
        fileButton.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                handleFileUpload(Array.from(e.target.files));
                e.target.value = ''; // Clear the input so the same file can be selected again
            }
        });
    }

    // Drag and drop functionality
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        dragDropOverlay.classList.add('active');
    });

    document.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !document.contains(e.relatedTarget)) {
            dragDropOverlay.classList.remove('active');
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDropOverlay.classList.remove('active');

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            // Accept all valid files (images and text documents)
            handleFileUpload(Array.from(e.dataTransfer.files));
        }
    });

    // Clipboard paste — images (screenshots etc.) land in the preview, text pastes normally
    messageInput.addEventListener('paste', async (e) => {
        const items = Array.from(e.clipboardData?.items || []);
        const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
        if (imageItems.length === 0) return; // let default text paste through
        e.preventDefault();
        const files = imageItems.map(item => {
            const blob = item.getAsFile();
            const ext = item.type === 'image/jpeg' ? 'jpg' : 'png';
            return new File([blob], `clipboard-${Date.now()}.${ext}`, { type: item.type });
        });
        await handleFileUpload(files);
    });

    modelSwitcherButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (modelSwitcherDropdown.style.display === 'block') {
            modelSwitcherDropdown.style.display = 'none';
        } else {
            const models = await fetchAvailableModels();
            populateModelDropdown(models, currentModelName);
            modelSwitcherDropdown.style.display = 'block';
        }
    });

    document.addEventListener('click', (e) => {
        if (!modelSwitcherButton.contains(e.target) && !modelSwitcherDropdown.contains(e.target)) {
            modelSwitcherDropdown.style.display = 'none';
        }
    });

    collapseSidebarButton.addEventListener('click', async () => {
        conversationSidebar.classList.toggle('collapsed');
        const isCollapsed = conversationSidebar.classList.contains('collapsed');
        collapseSidebarButton.innerHTML = isCollapsed ? '&#x2192;' : '&#x2190;'; // Right/Left arrow
        await chrome.storage.local.set({ [sidebarStateKey]: isCollapsed ? 'collapsed' : 'expanded' });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Small delay to ensure the page is fully visible before focusing
            setTimeout(() => messageInput.focus(), 100);
        }
    });

    window.addEventListener('pagehide', () => {
        stopServerStatusPoll();
        stopKokoroStatusPoll();
        stopKokoroSpeech();
        if (recognition && isListening) { try { recognition.stop(); } catch (e) {} }
        if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
        if (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking) { speechSynthesis.cancel(); }
    }, { once: true });

    // ===== TTS State =====
    // Web Speech API state
    let ttsUtterance = null;
    let isSpeaking = false;
    let availableVoices = [];

    // Kokoro TTS state
    let kokoroAbortController = null;
    let kokoroAudioContext = null;
    let kokoroSources = [];
    let kokoroVoicesCache = null;

    // Load available Web Speech voices
    function loadWebSpeechVoices() {
        availableVoices = speechSynthesis.getVoices();
    }

    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = loadWebSpeechVoices;
    }

    // Get current TTS settings from storage
    async function getTTSSettings() {
        const settings = await chrome.storage.local.get('ttsSettings');
        return settings.ttsSettings || { engine: 'webSpeech', voice: 'Google US English' };
    }

    // ===== Main speak/stop dispatch =====

    async function speakText(textContentDiv, buttonElement) {
        if (isSpeaking) {
            stopSpeaking();
            return;
        }

        const rawText = textContentDiv.dataset.fullMessage || textContentDiv.textContent || '';
        const cleanText = rawText
            // Strip thinking tags
            .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
            .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
            // Strip markdown formatting
            .replace(/```[\s\S]*?```/g, ' code block ')      // fenced code blocks
            .replace(/`([^`]+)`/g, '$1')                      // inline code
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')         // images
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')          // links → keep text
            .replace(/^#{1,6}\s+/gm, '')                      // headings
            .replace(/(\*\*\*|___)(.*?)\1/g, '$2')            // bold+italic
            .replace(/(\*\*|__)(.*?)\1/g, '$2')               // bold
            .replace(/(\*|_)(.*?)\1/g, '$2')                  // italic
            .replace(/~~(.*?)~~/g, '$1')                      // strikethrough
            .replace(/^\s*[-*+]\s+/gm, '')                    // unordered list markers
            .replace(/^\s*\d+\.\s+/gm, '')                    // ordered list markers
            .replace(/^\s*>\s?/gm, '')                        // blockquotes
            .replace(/^---+$/gm, '')                          // horizontal rules
            .replace(/\|/g, ' ')                              // table pipes
            .replace(/\n{3,}/g, '\n\n')                       // collapse extra newlines
            .trim();

        if (!cleanText) {
            console.log('[TTS] No text to speak');
            return;
        }

        const settings = await getTTSSettings();

        if (settings.engine === 'kokoro') {
            await speakWithKokoro(cleanText, settings.voice, buttonElement);
        } else {
            await speakWithWebSpeech(cleanText, settings.voice, buttonElement);
        }
    }

    function stopSpeaking() {
        isSpeaking = false;

        // Stop Web Speech
        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }
        ttsUtterance = null;

        // Stop Kokoro
        stopKokoroSpeech();

        // Reset all TTS buttons
        document.querySelectorAll('.tts-button.speaking, .tts-button.loading').forEach(btn => {
            resetTTSButton(btn);
        });
    }

    // ===== Web Speech API =====

    async function speakWithWebSpeech(text, voiceId, buttonElement) {
        try {
            setTTSButtonState(buttonElement, 'speaking');

            if (availableVoices.length === 0) {
                loadWebSpeechVoices();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const selectedVoice = availableVoices.find(v => v.voiceURI === voiceId) || availableVoices[0];
            console.log(`[TTS] Web Speech with voice: ${selectedVoice?.name || 'default'}`);

            ttsUtterance = new SpeechSynthesisUtterance(text);
            if (selectedVoice) ttsUtterance.voice = selectedVoice;
            ttsUtterance.rate = 1.0;
            ttsUtterance.pitch = 1.0;

            ttsUtterance.onstart = () => {
                isSpeaking = true;
                console.log('[TTS] Started speaking');
            };

            ttsUtterance.onend = () => {
                console.log('[TTS] Finished speaking');
                isSpeaking = false;
                resetTTSButton(buttonElement);
            };

            ttsUtterance.onerror = (event) => {
                if (event.error === 'interrupted') {
                    console.log('[TTS] Speech interrupted');
                } else {
                    console.error('[TTS] Speech error:', event.error);
                }
                isSpeaking = false;
                resetTTSButton(buttonElement);
            };

            isSpeaking = true;
            speechSynthesis.speak(ttsUtterance);
        } catch (error) {
            console.error('[TTS] Error speaking text:', error);
            isSpeaking = false;
            resetTTSButton(buttonElement);
        }
    }

    // ===== Kokoro TTS =====

    async function speakWithKokoro(text, voice, buttonElement) {
        try {
            setTTSButtonState(buttonElement, 'loading');
            isSpeaking = true;

            kokoroAbortController = new AbortController();
            const response = await fetch(`${PROXY_BASE}/api/tts/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice: voice || undefined }),
                signal: kokoroAbortController.signal
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                if (response.status === 503) {
                    console.log('[TTS] Kokoro model is loading, retrying in 3s...');
                    setTTSButtonState(buttonElement, 'loading');
                    await new Promise(r => setTimeout(r, 3000));
                    if (!isSpeaking) return;
                    return speakWithKokoro(text, voice, buttonElement);
                }
                throw new Error(errData.error || `Server error ${response.status}`);
            }

            const sampleRate = parseInt(response.headers.get('X-Sample-Rate')) || 24000;
            kokoroAudioContext = new AudioContext({ sampleRate });
            let scheduledTime = kokoroAudioContext.currentTime;

            setTTSButtonState(buttonElement, 'speaking');

            const reader = response.body.getReader();
            let leftover = new Uint8Array(0);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Combine leftover bytes with new data
                const combined = new Uint8Array(leftover.length + value.length);
                combined.set(leftover);
                combined.set(value, leftover.length);

                // Align to 4-byte float32 boundary
                const usableBytes = combined.length - (combined.length % 4);
                if (usableBytes === 0) {
                    leftover = combined;
                    continue;
                }

                leftover = combined.slice(usableBytes);
                const float32 = new Float32Array(combined.buffer.slice(combined.byteOffset, combined.byteOffset + usableBytes));

                // Create AudioBuffer and schedule playback
                const audioBuffer = kokoroAudioContext.createBuffer(1, float32.length, sampleRate);
                audioBuffer.getChannelData(0).set(float32);

                const source = kokoroAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(kokoroAudioContext.destination);

                // Schedule seamlessly after previous chunk
                const startTime = Math.max(scheduledTime, kokoroAudioContext.currentTime);
                source.start(startTime);
                scheduledTime = startTime + audioBuffer.duration;

                kokoroSources.push(source);
                source.onended = () => {
                    const idx = kokoroSources.indexOf(source);
                    if (idx !== -1) kokoroSources.splice(idx, 1);
                };
            }

            // Wait for all audio to finish playing
            const remainingTime = scheduledTime - kokoroAudioContext.currentTime;
            if (remainingTime > 0) {
                await new Promise(resolve => setTimeout(resolve, remainingTime * 1000 + 100));
            }

            isSpeaking = false;
            resetTTSButton(buttonElement);
            cleanupKokoroAudio();

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[TTS] Kokoro playback aborted');
            } else {
                console.error('[TTS] Kokoro error:', error);
            }
            isSpeaking = false;
            resetTTSButton(buttonElement);
            cleanupKokoroAudio();
        }
    }

    function stopKokoroSpeech() {
        if (kokoroAbortController) {
            kokoroAbortController.abort();
            kokoroAbortController = null;
        }
        kokoroSources.forEach(source => {
            try { source.stop(); } catch (e) { /* already stopped */ }
        });
        kokoroSources = [];
        cleanupKokoroAudio();
    }

    function cleanupKokoroAudio() {
        if (kokoroAudioContext && kokoroAudioContext.state !== 'closed') {
            kokoroAudioContext.close().catch(() => {});
            kokoroAudioContext = null;
        }
    }

    // ===== TTS Button States =====

    function setTTSButtonState(buttonElement, state) {
        if (!buttonElement) return;
        buttonElement.innerHTML = '';
        buttonElement.classList.remove('speaking', 'loading');

        if (state === 'speaking') {
            buttonElement.appendChild(createLucideIcon('volume-x', 16));
            buttonElement.title = 'Stop';
            buttonElement.classList.add('speaking');
        } else if (state === 'loading') {
            buttonElement.appendChild(createLucideIcon('loader', 16));
            buttonElement.title = 'Loading...';
            buttonElement.classList.add('loading');
        }
    }

    function resetTTSButton(buttonElement) {
        if (!buttonElement) return;
        buttonElement.innerHTML = '';
        buttonElement.appendChild(createLucideIcon('audio-lines', 16));
        buttonElement.title = 'Read aloud';
        buttonElement.classList.remove('speaking', 'loading');
    }

    // ===== TTS Settings =====

    let kokoroStatusPollTimer = null;
    let ttsEngineListenersAttached = false;

    async function loadTTSSettings() {
        const settings = await chrome.storage.local.get('ttsSettings');
        const ttsSettings = settings.ttsSettings || { engine: 'webSpeech', voice: 'Google US English' };

        // Set engine radio
        const engineRadio = document.querySelector(`input[name="ttsEngine"][value="${ttsSettings.engine}"]`);
        if (engineRadio) engineRadio.checked = true;

        // Populate voices for the selected engine
        const voiceSelect = document.getElementById('ttsVoiceSelect');
        await populateVoicesForEngine(ttsSettings.engine, voiceSelect, ttsSettings.voice);

        // Show/hide Kokoro status and trigger model load if Kokoro is active
        updateKokoroStatusVisibility(ttsSettings.engine);
        if (ttsSettings.engine === 'kokoro') {
            triggerKokoroModelLoad();
        }

        // Listen for engine toggle changes (guard against duplicate attachments)
        if (!ttsEngineListenersAttached) {
            ttsEngineListenersAttached = true;
            document.querySelectorAll('input[name="ttsEngine"]').forEach(radio => {
                radio.addEventListener('change', async (e) => {
                    const engine = e.target.value;
                    const select = document.getElementById('ttsVoiceSelect');
                    const statusText = document.getElementById('ttsStatusText');
                    await populateVoicesForEngine(engine, select);

                    updateKokoroStatusVisibility(engine);

                    if (engine === 'kokoro') {
                        if (statusText) statusText.textContent = 'Kokoro TTS runs on the proxy server';
                        triggerKokoroModelLoad();
                    } else {
                        stopKokoroStatusPoll();
                        if (statusText) statusText.textContent = 'Click speaker icon on any response to hear it';
                    }
                });
            });
        }

        return ttsSettings;
    }

    function updateKokoroStatusVisibility(engine) {
        const statusEl = document.getElementById('kokoroModelStatus');
        if (statusEl) {
            statusEl.style.display = engine === 'kokoro' ? 'flex' : 'none';
        }
    }

    async function triggerKokoroModelLoad() {
        const statusEl = document.getElementById('kokoroModelStatus');
        const labelEl = document.getElementById('kokoroStatusLabel');
        if (!statusEl || !labelEl) return;

        // First, try to reach the proxy server directly
        try {
            const loadRes = await fetch(`${PROXY_BASE}/api/tts/load`, { method: 'POST' });
            if (loadRes.status === 404) {
                // Server is running but old code — need restart
                setKokoroStatusUI('loading', 'Restarting proxy server...');
                await requestProxyControl('restart');
                return;
            }
            if (!loadRes.ok) throw new Error(`Server error ${loadRes.status}`);
            const loadData = await loadRes.json();

            if (loadData.status === 'ready') {
                setKokoroStatusUI('ready', 'Model ready');
                return;
            }

            setKokoroStatusUI('loading', 'Downloading model (~86 MB)...');
            startKokoroStatusPoll();
            return;
        } catch (err) {
            // Server not reachable — try to auto-start via native messaging
            console.log('[TTS] Proxy not reachable, attempting auto-start...');
        }

        await requestProxyControl('start');
    }

    async function requestProxyControl(command) {
        setKokoroStatusUI('loading', command === 'restart' ? 'Restarting proxy server...' : 'Starting proxy server...');

        try {
            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                    { action: 'proxyControl', command },
                    (resp) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(resp);
                        }
                    }
                );
            });

            if (response.needsSetup) {
                setKokoroStatusUI('error', 'One-time setup needed: run install-native-host.bat from the project folder');
                return;
            }

            if (response.status === 'started' || response.status === 'restarted' || response.status === 'already_running') {
                // Server is up — now trigger Kokoro model load
                setKokoroStatusUI('loading', 'Proxy server running. Loading Kokoro model...');
                // Wait a moment then try to trigger model load
                await new Promise(r => setTimeout(r, 1000));
                try {
                    const loadRes = await fetch(`${PROXY_BASE}/api/tts/load`, { method: 'POST' });
                    if (loadRes.ok) {
                        const data = await loadRes.json();
                        if (data.status === 'ready') {
                            setKokoroStatusUI('ready', 'Model ready');
                            return;
                        }
                    }
                } catch (e) { /* will poll */ }
                setKokoroStatusUI('loading', 'Downloading model (~86 MB)...');
                startKokoroStatusPoll();
            } else if (response.status === 'start_failed' || response.status === 'restart_failed') {
                setKokoroStatusUI('error', 'Failed to start proxy server. Check that Node.js is installed.');
            } else if (response.error) {
                setKokoroStatusUI('error', response.error);
            }
        } catch (err) {
            console.error('[TTS] Native messaging failed:', err);
            setKokoroStatusUI('error', 'One-time setup needed: run install-native-host.bat from the project folder');
        }
    }

    function setKokoroStatusUI(status, label) {
        const statusEl = document.getElementById('kokoroModelStatus');
        const labelEl = document.getElementById('kokoroStatusLabel');
        if (!statusEl || !labelEl) return;

        statusEl.className = 'kokoro-model-status status-' + status;
        statusEl.style.display = 'flex';
        labelEl.textContent = label;
    }

    function startKokoroStatusPoll() {
        stopKokoroStatusPoll();
        let failCount = 0;
        kokoroStatusPollTimer = setInterval(async () => {
            try {
                const res = await fetch(`${PROXY_BASE}/api/tts/status`);
                if (res.status === 404) {
                    // Server running old code without TTS endpoints
                    failCount++;
                    if (failCount >= 3) {
                        setKokoroStatusUI('error', 'Proxy server outdated. Stop it and run: cd proxy_server && npm start');
                        stopKokoroStatusPoll();
                    }
                    return;
                }
                if (!res.ok) return;
                failCount = 0;
                const data = await res.json();

                if (data.status === 'ready') {
                    setKokoroStatusUI('ready', 'Model ready');
                    stopKokoroStatusPoll();
                } else if (data.status === 'error') {
                    setKokoroStatusUI('error', 'Model failed to load: ' + (data.error || 'unknown error'));
                    stopKokoroStatusPoll();
                } else {
                    setKokoroStatusUI('loading', 'Downloading model (~86 MB)...');
                }
            } catch (err) {
                failCount++;
                if (failCount >= 5) {
                    setKokoroStatusUI('error', 'Lost connection to proxy server');
                    stopKokoroStatusPoll();
                }
            }
        }, 2000);
    }

    function stopKokoroStatusPoll() {
        if (kokoroStatusPollTimer) {
            clearInterval(kokoroStatusPollTimer);
            kokoroStatusPollTimer = null;
        }
    }

    // ─── Server Status Indicator ──────────────────────────────────────────────

    let serverStatusPollTimer = null;

    function updateServerStatusDot(state, tooltip) {
        const dot = document.getElementById('serverStatusDot');
        if (!dot) return;
        dot.className = 'server-status-dot status-' + state;
        dot.title = tooltip;
    }

    async function checkServerStatus() {
        updateServerStatusDot('checking', 'Checking server...');
        if (currentModelBackend === 'llamacpp') {
            await checkLlamaCppStatusIndicator();
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const resp = await fetch(`${PROXY_BASE}/proxy/api/tags`, { signal: controller.signal });
            clearTimeout(timer);
            if (resp.ok) {
                const data = await resp.json();
                const count = (data.models || []).length;
                if (count > 0) {
                    updateServerStatusDot('connected', `Ollama connected · ${count} model${count !== 1 ? 's' : ''}`);
                } else {
                    updateServerStatusDot('degraded', 'Ollama running but no models found');
                }
            } else {
                updateServerStatusDot('degraded', `Ollama error (HTTP ${resp.status})`);
            }
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                updateServerStatusDot('degraded', 'Ollama not responding (timeout)');
            } else {
                updateServerStatusDot('disconnected', 'Proxy server not running (port 3456)');
            }
        }
    }

    async function checkLlamaCppStatusIndicator() {
        updateServerStatusDot('checking', 'Checking server...');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const resp = await fetch(`${PROXY_BASE}/api/llamacpp/status`, { signal: controller.signal });
            clearTimeout(timer);
            if (resp.ok) {
                const data = await resp.json();
                const state = data.status === 'ready' ? 'connected' : 'degraded';
                const label = data.status === 'ready'
                    ? `llama.cpp running · ${data.model || 'model loaded'}`
                    : `llama.cpp: ${data.status}`;
                updateServerStatusDot(state, label);
            } else {
                updateServerStatusDot('degraded', 'llama.cpp status unavailable');
            }
        } catch (e) {
            clearTimeout(timer);
            updateServerStatusDot('disconnected', 'Proxy server not running (port 3456)');
        }
    }

    function startServerStatusPoll() {
        stopServerStatusPoll();
        checkServerStatus();
        serverStatusPollTimer = setInterval(checkServerStatus, 15000);
    }

    function stopServerStatusPoll() {
        if (serverStatusPollTimer) {
            clearInterval(serverStatusPollTimer);
            serverStatusPollTimer = null;
        }
    }

    async function populateVoicesForEngine(engine, voiceSelect, selectedVoice) {
        if (!voiceSelect) return;

        if (engine === 'kokoro') {
            await populateKokoroVoices(voiceSelect, selectedVoice);
        } else {
            populateWebSpeechVoices(voiceSelect, selectedVoice);
        }
    }

    function populateWebSpeechVoices(voiceSelect, selectedVoice) {
        if (!voiceSelect) return;

        if (availableVoices.length === 0) {
            loadWebSpeechVoices();
            if (availableVoices.length === 0) {
                setTimeout(() => {
                    loadWebSpeechVoices();
                    populateWebSpeechVoices(voiceSelect, selectedVoice);
                }, 500);
                return;
            }
        }

        voiceSelect.innerHTML = '';

        const voicesByLang = {};
        availableVoices.forEach(voice => {
            const lang = voice.lang.split('-')[0];
            if (!voicesByLang[lang]) voicesByLang[lang] = [];
            voicesByLang[lang].push(voice);
        });

        Object.keys(voicesByLang).sort().forEach(lang => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = lang.toUpperCase();
            voicesByLang[lang].forEach(voice => {
                const option = document.createElement('option');
                option.value = voice.voiceURI;
                option.textContent = voice.name;
                optgroup.appendChild(option);
            });
            voiceSelect.appendChild(optgroup);
        });

        if (selectedVoice) voiceSelect.value = selectedVoice;
    }

    async function populateKokoroVoices(voiceSelect, selectedVoice) {
        if (!voiceSelect) return;
        voiceSelect.innerHTML = '<option value="">Loading Kokoro voices...</option>';

        try {
            if (!kokoroVoicesCache) {
                const response = await fetch(`${PROXY_BASE}/api/tts/voices`);
                if (response.status === 503) {
                    voiceSelect.innerHTML = '<option value="">Model loading, please wait...</option>';
                    setTimeout(() => populateKokoroVoices(voiceSelect, selectedVoice), 4000);
                    return;
                }
                if (!response.ok) throw new Error('Failed to fetch voices');
                const data = await response.json();
                kokoroVoicesCache = data.voices || [];
            }

            voiceSelect.innerHTML = '';

            if (kokoroVoicesCache.length === 0) {
                voiceSelect.innerHTML = '<option value="">No voices available</option>';
                return;
            }

            // Group voices by language
            const byLang = {};
            kokoroVoicesCache.forEach(v => {
                const lang = v.language || 'unknown';
                if (!byLang[lang]) byLang[lang] = [];
                byLang[lang].push(v);
            });

            const langLabels = { 'en-us': 'American English', 'en-gb': 'British English' };

            Object.entries(byLang).forEach(([lang, voices]) => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = langLabels[lang] || lang.toUpperCase();
                voices.forEach(v => {
                    const option = document.createElement('option');
                    option.value = v.id;
                    const genderIcon = v.gender === 'Female' ? '\u2640' : '\u2642';
                    option.textContent = `${v.name} ${genderIcon}${v.grade ? ' [' + v.grade + ']' : ''}`;
                    optgroup.appendChild(option);
                });
                voiceSelect.appendChild(optgroup);
            });

            if (selectedVoice) voiceSelect.value = selectedVoice;
            if (!voiceSelect.value && voiceSelect.options.length > 0) {
                voiceSelect.selectedIndex = 0;
            }
        } catch (error) {
            console.error('[TTS] Error fetching Kokoro voices:', error);
            voiceSelect.innerHTML = '<option value="">Could not load voices (is proxy server running?)</option>';
        }
    }

    async function saveTTSSettings() {
        const voiceSelect = document.getElementById('ttsVoiceSelect');
        const engineRadio = document.querySelector('input[name="ttsEngine"]:checked');
        if (!voiceSelect) return;

        const ttsSettings = {
            engine: engineRadio ? engineRadio.value : 'webSpeech',
            voice: voiceSelect.value
        };

        await chrome.storage.local.set({ ttsSettings });
        console.log('[TTS] Settings saved:', ttsSettings);

        // If Kokoro was selected, ensure model is pre-loaded
        if (ttsSettings.engine === 'kokoro') {
            triggerKokoroModelLoad();
        }

        stopKokoroStatusPoll();
    }

    // ─── llama.cpp Settings ───────────────────────────────────────────────────

    async function loadLlamaCppSettings() {
        const stored = await chrome.storage.local.get('llamaCppConfig');
        const config = stored.llamaCppConfig || {};

        try {
            const resp = await fetch(`${PROXY_BASE}/api/llamacpp/status`);
            if (resp.ok) {
                const status = await resp.json();
                const exeInput = document.getElementById('llamaCppExecutable');
                const dirInput = document.getElementById('llamaCppModelsDir');
                const gpuInput = document.getElementById('llamaCppGpuLayers');
                const ctxInput = document.getElementById('llamaCppCtxSize');
                const portInput = document.getElementById('llamaCppPort');
                const statusEl = document.getElementById('llamaCppServerStatus');

                if (exeInput) exeInput.value = config.executable || status.executable || 'C:\\llama.cpp\\llama-server.exe';
                if (dirInput) dirInput.value = config.modelsDir || status.modelsDir || 'C:\\llama.cpp';
                if (gpuInput) gpuInput.value = config.gpuLayers ?? status.gpuLayers ?? '-1';
                if (ctxInput) ctxInput.value = config.ctxSize ?? status.ctxSize ?? '32768';
                if (portInput) portInput.value = config.port || status.port || '8080';

                if (statusEl) {
                    const modelName = status.model ? ` — ${status.model}` : '';
                    statusEl.textContent = `Server: ${status.status}${modelName}`;
                }
            }
        } catch (e) {
            const statusEl = document.getElementById('llamaCppServerStatus');
            if (statusEl) statusEl.textContent = 'Server: proxy not running';
        }

        populateLlamaCppModelList();
    }

    async function saveLlamaCppSettings() {
        const config = {
            executable: (document.getElementById('llamaCppExecutable')?.value || '').trim(),
            modelsDir: (document.getElementById('llamaCppModelsDir')?.value || '').trim(),
            gpuLayers: document.getElementById('llamaCppGpuLayers')?.value || '-1',
            ctxSize: document.getElementById('llamaCppCtxSize')?.value || '32768',
            port: document.getElementById('llamaCppPort')?.value || '8080'
        };

        await chrome.storage.local.set({ llamaCppConfig: config });

        const statusEl = document.getElementById('llamaCppConfigStatus');
        try {
            const resp = await fetch(`${PROXY_BASE}/api/llamacpp/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            if (!resp.ok) {
                if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'var(--error-text)'; }
                return;
            }

            availableModels = []; // bust model cache so dropdown re-fetches

            // If a llama.cpp model is currently loaded, reload it so new settings take effect
            if (currentLlamaCppPath && currentModelBackend === 'llamacpp') {
                if (statusEl) { statusEl.textContent = 'Reloading model...'; statusEl.style.color = 'var(--text-muted)'; }
                const loadResp = await fetch(`${PROXY_BASE}/api/llamacpp/load`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modelPath: currentLlamaCppPath })
                });
                if (loadResp.ok) {
                    if (statusEl) { statusEl.textContent = 'Saved & reloaded!'; statusEl.style.color = 'var(--success)'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
                } else {
                    if (statusEl) { statusEl.textContent = 'Saved, but reload failed'; statusEl.style.color = 'var(--error-text)'; }
                }
            } else {
                if (statusEl) { statusEl.textContent = 'Saved!'; statusEl.style.color = 'var(--success)'; setTimeout(() => { statusEl.textContent = ''; }, 2000); }
            }
        } catch (e) {
            if (statusEl) { statusEl.textContent = 'Proxy unreachable'; statusEl.style.color = 'var(--error-text)'; }
        }
    }

    // ─── Dashboard ────────────────────────────────────────────────────────────

    function dashFmt(n) {
        if (n === null || n === undefined || isNaN(n)) return '—';
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toLocaleString();
    }

    async function computeDashboardStats() {
        // Ensure available models are loaded — fetchAvailableModels caches after first call
        await fetchAvailableModels();

        const allStorage = await chrome.storage.local.get(null);
        const stats = {
            totalTokens: 0,
            totalPromptTokens: 0,
            totalConversations: 0,
            totalUserMessages: 0,
            totalBotMessages: 0,
            totalImages: 0,
            speedSamples: [],
            modelStats: {},   // storageKey → { displayName, isCloud, installed, conversations, messages, tokens, speedSamples }
            dayActivity: {},  // 'YYYY-MM-DD' → message count
            longestConvMessages: 0,
            longestConvModel: '—',
        };

        // Build reverse-lookup without calling getModelStorageKey (avoids console spam)
        const sanitize = name => `${storageKeyPrefix}${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
        const knownKeyToName = {};
        const installedKeys = new Set();
        for (const m of availableModels) {
            const k = sanitize(m.name);
            knownKeyToName[k] = m.name;
            installedKeys.add(k);
        }

        for (const [key, data] of Object.entries(allStorage)) {
            if (!key.startsWith(storageKeyPrefix)) continue;
            if (!data || typeof data !== 'object' || !data.conversations) continue;

            const displayName = knownKeyToName[key] || key.slice(storageKeyPrefix.length);
            const installed = installedKeys.has(key);
            // Use isCloudModel with the real display name now that availableModels is populated
            const cloud = isCloudModel(displayName);

            if (!stats.modelStats[key]) {
                stats.modelStats[key] = {
                    displayName,
                    isCloud: cloud,
                    installed,
                    conversations: 0,
                    messages: 0,
                    tokens: 0,
                    speedSamples: [],
                };
            }
            const ms = stats.modelStats[key];

            for (const conv of Object.values(data.conversations)) {
                const msgs = conv.messages || [];
                if (msgs.length === 0) continue;

                stats.totalConversations++;
                ms.conversations++;

                let convMsgCount = 0;
                for (const msg of msgs) {
                    stats.totalBotMessages += msg.role === 'assistant' ? 1 : 0;
                    ms.messages++;
                    convMsgCount++;

                    if (msg.role === 'user') {
                        stats.totalUserMessages++;
                        // Handle both old (images) and new (attachments) format
                        if (msg.attachments && msg.attachments.length > 0) {
                            stats.totalImages += msg.attachments.filter(a => a.type === 'image' || a.base64).length;
                        } else if (msg.images && msg.images.length > 0) {
                            stats.totalImages += msg.images.length;
                        }
                    }

                    if (msg.role === 'assistant' && msg.metadata) {
                        if (msg.metadata.tokens) {
                            stats.totalTokens += msg.metadata.tokens;
                            ms.tokens += msg.metadata.tokens;
                        }
                        if (msg.metadata.promptTokens) {
                            stats.totalPromptTokens += msg.metadata.promptTokens;
                        }
                        const spd = parseFloat(msg.metadata.speed);
                        if (!isNaN(spd) && spd > 0) {
                            stats.speedSamples.push(spd);
                            ms.speedSamples.push(spd);
                        }
                    }
                }

                if (convMsgCount > stats.longestConvMessages) {
                    stats.longestConvMessages = convMsgCount;
                    stats.longestConvModel = displayName;
                }

                if (conv.lastMessageTime) {
                    const day = new Date(conv.lastMessageTime).toISOString().split('T')[0];
                    stats.dayActivity[day] = (stats.dayActivity[day] || 0) + convMsgCount;
                }
            }
        }

        // Most active day
        let mostActiveDay = '—', mostActiveDayCount = 0;
        for (const [day, count] of Object.entries(stats.dayActivity)) {
            if (count > mostActiveDayCount) { mostActiveDayCount = count; mostActiveDay = day; }
        }
        stats.mostActiveDay = mostActiveDay;
        stats.mostActiveDayCount = mostActiveDayCount;

        // Average speed
        stats.avgSpeed = stats.speedSamples.length
            ? (stats.speedSamples.reduce((a, b) => a + b, 0) / stats.speedSamples.length).toFixed(1)
            : null;

        // Most used model (by total messages)
        let topModel = '—', topModelMessages = 0;
        for (const ms of Object.values(stats.modelStats)) {
            if (ms.messages > topModelMessages) { topModelMessages = ms.messages; topModel = ms.displayName; }
        }
        stats.topModel = topModel;
        stats.topModelMessages = topModelMessages;

        // Local / cloud counts — based on currently installed models, not storage history
        stats.localModels = availableModels.filter(m => !isCloudModel(m.name)).length;
        stats.cloudModels = availableModels.filter(m => isCloudModel(m.name)).length;

        return stats;
    }

    function renderDashboard(stats) {
        const content = document.getElementById('dashboardContent');
        if (!content) return;

        const hasData = stats.totalConversations > 0;

        if (!hasData) {
            content.innerHTML = `<div class="dashboard-empty">
                No chat history yet. Start a conversation to see your stats here.
            </div>`;
            content.style.display = '';
            document.getElementById('dashboardLoading').style.display = 'none';
            if (typeof lucide !== 'undefined') lucide.createIcons({ el: content });
            return;
        }

        // Sort: installed first (by messages), then archived (by messages)
        const sortedModels = Object.values(stats.modelStats).sort((a, b) => {
            if (a.installed !== b.installed) return a.installed ? -1 : 1;
            return b.messages - a.messages;
        });

        const cloudSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="#3b82f6" viewBox="0 0 16 16" title="Cloud model"><path d="M4.406 3.342A5.53 5.53 0 0 1 8 2c2.69 0 4.923 2 5.166 4.579C14.758 6.804 16 8.137 16 9.773 16 11.569 14.502 13 12.687 13H3.781C1.708 13 0 11.366 0 9.318c0-1.763 1.266-3.223 2.942-3.593.143-.863.698-1.723 1.464-2.383z"/></svg>`;

        const modelRows = sortedModels.map((m, i) => {
            const avgSpd = m.speedSamples.length
                ? (m.speedSamples.reduce((a, b) => a + b, 0) / m.speedSamples.length).toFixed(1) + ' t/s'
                : '—';
            const cloudBadge = m.isCloud ? cloudSvg : '';
            const archivedBadge = !m.installed
                ? `<span style="font-size:10px;padding:1px 5px;background:rgba(115,115,115,0.15);color:var(--text-muted);border-radius:3px;margin-left:4px;">removed</span>`
                : '';
            const rowStyle = !m.installed ? 'opacity:0.55;' : '';
            return `<tr style="${rowStyle}">
                <td><div class="model-name-cell"><span class="model-rank">${i + 1}</span>${m.displayName}${cloudBadge}${archivedBadge}</div></td>
                <td>${m.conversations}</td>
                <td>${dashFmt(m.messages)}</td>
                <td>${m.tokens > 0 ? dashFmt(m.tokens) : '—'}</td>
                <td>${avgSpd}</td>
            </tr>`;
        }).join('');

        content.innerHTML = `
            <div class="dashboard-section">
                <div class="dashboard-stats-grid">
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon blue"><i data-lucide="zap"></i></div>
                        </div>
                        <div class="stat-value">${dashFmt(stats.totalTokens)}</div>
                        <div class="stat-label">Tokens Generated</div>
                        <div class="stat-sublabel">${dashFmt(stats.totalPromptTokens)} prompt tokens</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon purple"><i data-lucide="message-square"></i></div>
                        </div>
                        <div class="stat-value">${dashFmt(stats.totalUserMessages)}</div>
                        <div class="stat-label">Messages Sent</div>
                        <div class="stat-sublabel">${dashFmt(stats.totalBotMessages)} responses</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon green"><i data-lucide="folder-open"></i></div>
                        </div>
                        <div class="stat-value">${dashFmt(stats.totalConversations)}</div>
                        <div class="stat-label">Conversations</div>
                        <div class="stat-sublabel">${sortedModels.filter(m => m.installed).length} installed · ${sortedModels.filter(m => !m.installed).length} removed</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon amber"><i data-lucide="gauge"></i></div>
                        </div>
                        <div class="stat-value">${stats.avgSpeed !== null ? stats.avgSpeed : '—'}</div>
                        <div class="stat-label">Avg Speed</div>
                        <div class="stat-sublabel">tokens / second</div>
                    </div>
                </div>
            </div>

            <div class="dashboard-section">
                <div class="dashboard-stats-grid-3">
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon cyan"><i data-lucide="trophy"></i></div>
                        </div>
                        <div class="stat-value" style="font-size:1rem;word-break:break-word;">${stats.topModel}</div>
                        <div class="stat-label">Most Used Model</div>
                        <div class="stat-sublabel">${dashFmt(stats.topModelMessages)} messages</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon pink"><i data-lucide="image"></i></div>
                        </div>
                        <div class="stat-value">${dashFmt(stats.totalImages)}</div>
                        <div class="stat-label">Images Sent</div>
                        <div class="stat-sublabel">across all conversations</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon blue"><i data-lucide="server"></i></div>
                        </div>
                        <div class="local-cloud-split" style="margin-top:var(--space-xs);">
                            <div class="split-item">
                                <div class="split-value">${stats.localModels}</div>
                                <div class="split-label">Local</div>
                            </div>
                            <div class="split-divider"></div>
                            <div class="split-item">
                                <div class="split-value">${stats.cloudModels}</div>
                                <div class="split-label">Cloud</div>
                            </div>
                        </div>
                        <div class="stat-label" style="margin-top:var(--space-sm);">Models by Type</div>
                    </div>
                </div>
            </div>

            <div class="dashboard-section">
                <div class="dashboard-stats-grid-3">
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon amber"><i data-lucide="calendar"></i></div>
                        </div>
                        <div class="stat-value" style="font-size:1rem;">${stats.mostActiveDay}</div>
                        <div class="stat-label">Most Active Day</div>
                        <div class="stat-sublabel">${stats.mostActiveDayCount > 0 ? dashFmt(stats.mostActiveDayCount) + ' messages' : '—'}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon green"><i data-lucide="messages-square"></i></div>
                        </div>
                        <div class="stat-value">${stats.longestConvMessages}</div>
                        <div class="stat-label">Longest Conversation</div>
                        <div class="stat-sublabel" style="word-break:break-word;">${stats.longestConvModel}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-card-header">
                            <div class="stat-card-icon red"><i data-lucide="brain"></i></div>
                        </div>
                        <div class="stat-value">${dashFmt(stats.totalTokens + stats.totalPromptTokens)}</div>
                        <div class="stat-label">Total Tokens Processed</div>
                        <div class="stat-sublabel">input + output combined</div>
                    </div>
                </div>
            </div>

            ${sortedModels.length > 0 ? `
            <div class="dashboard-section">
                <div class="dashboard-section-title">Model Breakdown</div>
                <table class="dashboard-table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Convs</th>
                            <th>Messages</th>
                            <th>Tokens</th>
                            <th>Avg Speed</th>
                        </tr>
                    </thead>
                    <tbody>${modelRows}</tbody>
                </table>
            </div>` : ''}
        `;

        document.getElementById('dashboardLoading').style.display = 'none';
        content.style.display = '';
        if (typeof lucide !== 'undefined') lucide.createIcons({ el: content });
    }

    async function openDashboardModal() {
        const modal = document.getElementById('dashboardModal');
        const content = document.getElementById('dashboardContent');
        const loading = document.getElementById('dashboardLoading');
        if (!modal) return;

        // Reset to loading state
        if (content) content.style.display = 'none';
        if (loading) loading.style.display = 'flex';
        modal.classList.add('active');
        if (typeof lucide !== 'undefined') lucide.createIcons({ el: loading });

        const stats = await computeDashboardStats();
        renderDashboard(stats);
    }

    function closeDashboardModal() {
        const modal = document.getElementById('dashboardModal');
        if (modal) modal.classList.remove('active');
        messageInput.focus();
    }

    // Dashboard event listeners
    const dashboardButton = document.getElementById('dashboardButton');
    if (dashboardButton) {
        dashboardButton.addEventListener('click', openDashboardModal);
    }

    const closeDashboardModalButton = document.getElementById('closeDashboardModal');
    if (closeDashboardModalButton) {
        closeDashboardModalButton.addEventListener('click', closeDashboardModal);
    }

    const dashboardModal = document.getElementById('dashboardModal');
    if (dashboardModal) {
        dashboardModal.addEventListener('click', (e) => {
            if (e.target === dashboardModal) closeDashboardModal();
        });
    }

    // ── Theme System ──────────────────────────────────────────────────────────

    const LIGHT_THEMES = new Set([
        'github-light', 'solarized-light', 'catppuccin-latte',
        'kanagawa-lotus', 'rose-pine-dawn', 'nord-light', 'night-owl-light', 'one-light'
    ]);
    const HLJS_LIGHT_HREF = 'lib/github-light.min.css';
    const HLJS_DARK_HREF = 'lib/atom-one-dark.min.css';

    function applyTheme(themeId) {
        const root = document.documentElement;
        if (themeId === 'default-dark') {
            root.removeAttribute('data-theme');
        } else {
            root.setAttribute('data-theme', themeId);
        }
        const hljsLink = document.getElementById('hljs-theme');
        if (hljsLink) {
            hljsLink.href = LIGHT_THEMES.has(themeId) ? HLJS_LIGHT_HREF : HLJS_DARK_HREF;
        }
        document.querySelectorAll('.theme-swatch').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.themeId === themeId);
        });
    }

    async function loadSavedTheme() {
        try {
            const result = await chrome.storage.local.get(['activeTheme']);
            applyTheme(result.activeTheme || 'default-dark');
        } catch (e) {
            applyTheme('default-dark');
        }
    }

    document.querySelectorAll('.theme-swatch').forEach(btn => {
        btn.addEventListener('click', async () => {
            const themeId = btn.dataset.themeId;
            applyTheme(themeId);
            await chrome.storage.local.set({ activeTheme: themeId });
        });
    });

    await loadSavedTheme();

    // Sync saved llama.cpp config to proxy so settings survive extension reload
    chrome.storage.local.get('llamaCppConfig').then(stored => {
        const config = stored.llamaCppConfig;
        if (config && Object.keys(config).length > 0) {
            fetch(`${PROXY_BASE}/api/llamacpp/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            }).catch(e => console.warn('[llama.cpp] Could not sync config to proxy:', e));
        }
    });

    // ─────────────────────────────────────────────────────────────────────────

    init();

    // ═══════════════════════════════════════════════════════════════════════════
    // TAB MANAGER (Electron only)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isElectron) {
        let activeTabId = null;
        const tabStateCache = {};

        function captureTabState(tabId) {
            if (!tabId) return;
            tabStateCache[tabId] = {
                currentModelName: typeof currentModelName !== 'undefined' ? currentModelName : '',
                currentModelBackend: typeof currentModelBackend !== 'undefined' ? currentModelBackend : 'ollama',
                currentLlamaCppPath: typeof currentLlamaCppPath !== 'undefined' ? currentLlamaCppPath : null,
                webSearchEnabled: typeof webSearchEnabled !== 'undefined' ? webSearchEnabled : false,
                deepResearchEnabled: typeof deepResearchEnabled !== 'undefined' ? deepResearchEnabled : false,
                agentModeEnabled: typeof agentModeEnabled !== 'undefined' ? agentModeEnabled : false,
                memoryEnabled: typeof memoryEnabled !== 'undefined' ? memoryEnabled : false,
            };
        }

        function applyTabState(state) {
            if (!state) return;
            if (typeof state.currentModelName !== 'undefined' && state.currentModelName) {
                if (typeof currentModelName !== 'undefined') currentModelName = state.currentModelName;
            }
            if (typeof state.currentModelBackend !== 'undefined') {
                if (typeof currentModelBackend !== 'undefined') currentModelBackend = state.currentModelBackend;
            }
        }

        function renderTabBar(tabs) {
            const tabList = document.getElementById('tabList');
            if (!tabList) return;
            tabList.innerHTML = '';
            tabs.forEach(tab => {
                const el = document.createElement('div');
                el.className = 'tab-item' + (tab.id === activeTabId ? ' active' : '');
                el.dataset.tabId = tab.id;

                const titleSpan = document.createElement('span');
                titleSpan.className = 'tab-title';
                titleSpan.textContent = tab.title || 'New Chat';
                el.appendChild(titleSpan);

                const closeBtn = document.createElement('button');
                closeBtn.className = 'tab-close';
                closeBtn.textContent = '×';
                closeBtn.title = 'Close tab';
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                });
                el.appendChild(closeBtn);

                el.addEventListener('click', () => switchToTab(tab.id));
                tabList.appendChild(el);
            });
        }

        async function switchToTab(tabId) {
            if (tabId === activeTabId) return;
            captureTabState(activeTabId);
            activeTabId = tabId;
            const tabs = await window.electronAPI.tabs.getAll();
            renderTabBar(tabs);
            const tab = tabs.find(t => t.id === tabId);
            if (tab) {
                applyTabState(tabStateCache[tabId]);
                // Update model display if function exists
                if (typeof updateModelDisplay === 'function') {
                    updateModelDisplay(tab.model || '');
                }
            }
        }

        async function createTab(model) {
            captureTabState(activeTabId);
            const tab = await window.electronAPI.tabs.create({
                title: 'New Chat',
                model: model || (typeof currentModelName !== 'undefined' ? currentModelName : ''),
                backend: 'ollama'
            });
            const tabs = await window.electronAPI.tabs.getAll();
            activeTabId = tab.id;
            renderTabBar(tabs);
            // Reset chat state for new tab
            if (typeof clearConversation === 'function') clearConversation();
        }

        async function closeTab(tabId) {
            const tabs = await window.electronAPI.tabs.getAll();
            if (tabs.length <= 1) return; // keep at least one
            await window.electronAPI.tabs.remove(tabId);
            const remaining = await window.electronAPI.tabs.getAll();
            if (activeTabId === tabId) {
                activeTabId = remaining[0].id;
            }
            renderTabBar(remaining);
            if (activeTabId === remaining[0].id && tabId !== remaining[0].id) {
                // switched to new tab — nothing extra needed
            }
        }

        async function initTabs() {
            let tabs = await window.electronAPI.tabs.getAll();
            if (!tabs || tabs.length === 0) {
                await window.electronAPI.tabs.create({ title: 'New Chat', model: '', backend: 'ollama' });
                tabs = await window.electronAPI.tabs.getAll();
            }
            activeTabId = tabs[0].id;
            renderTabBar(tabs);
        }

        // Wire new tab button
        const newTabBtn = document.getElementById('newTabButton');
        if (newTabBtn) {
            newTabBtn.addEventListener('click', () => createTab());
        }

        // Wire window controls
        const winMin = document.getElementById('winMinimize');
        const winMax = document.getElementById('winMaximize');
        const winClose = document.getElementById('winClose');
        if (winMin) winMin.addEventListener('click', () => window.electronAPI.window.minimize());
        if (winMax) winMax.addEventListener('click', () => window.electronAPI.window.maximize());
        if (winClose) winClose.addEventListener('click', () => window.electronAPI.window.close());

        // Initialize tabs
        initTabs();

        // Expose activeTabId getter for use in storage rewrites
        window._getActiveTabId = () => activeTabId;
        window._updateTabTitle = async (title) => {
            if (!activeTabId) return;
            await window.electronAPI.tabs.update(activeTabId, { title });
            const tabs = await window.electronAPI.tabs.getAll();
            renderTabBar(tabs);
        };
    }

});
