// proxy/router.js — Express app, CORS, middleware, registers all route handlers

const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const memory = require('./memory');

const {
    handleSkillsList,
    handleSkillsReload,
    handleSkillsImport,
    handleSkillsImportUrl,
    handleSkillsDelete,
    handleSkillsDir,
    handleSkillsRunCli,
} = require('./skills');

const {
    handleSttStatus,
    handleSttLoad,
    handleSttTranscribe,
    getWhisperDiagnostics,
    getWhisperProcess,
    getWhisperStatus,
    setWhisperStatus,
} = require('./stt');

const {
    handleAgentPermission,
    handleAgentConfigGet,
    handleAgentConfigPost,
} = require('./tools');

const {
    handleLlamacppStatus,
    handleLlamacppConfig,
    handleLlamacppModels,
    handleLlamacppLoad,
    handleLlamacppStop,
    handleLlamacppDelete,
    handleLlamacppChat,
    handleDetectContextLimit,
    handleLlmfitRecommend,
    handleResearch,
    handleAgentChat,
    handleOllamaProxy,
    getLlamacppDiagnostics,
    getLlamaProcess,
} = require('./llm');

const PORT = 3456;
const OLLAMA_API_BASE_URL = 'http://localhost:11434';
const extensionOrigin = 'chrome-extension://gkpfpdekobmonacdgjgbfehilnloaacm';

// Kokoro TTS state
let kokoroTTS = null;
let kokoroStatus = 'not_loaded'; // 'not_loaded' | 'loading' | 'ready' | 'error'
let kokoroLoadError = null;

// Static Kokoro voice metadata (from kokoro-js VOICES constant)
const KOKORO_VOICES = [
    { id: 'af_heart', name: 'Heart', language: 'en-us', gender: 'Female', grade: 'A' },
    { id: 'af_alloy', name: 'Alloy', language: 'en-us', gender: 'Female', grade: 'C' },
    { id: 'af_aoede', name: 'Aoede', language: 'en-us', gender: 'Female', grade: 'C+' },
    { id: 'af_bella', name: 'Bella', language: 'en-us', gender: 'Female', grade: 'A-' },
    { id: 'af_jessica', name: 'Jessica', language: 'en-us', gender: 'Female', grade: 'D' },
    { id: 'af_kore', name: 'Kore', language: 'en-us', gender: 'Female', grade: 'C+' },
    { id: 'af_nicole', name: 'Nicole', language: 'en-us', gender: 'Female', grade: 'B-' },
    { id: 'af_nova', name: 'Nova', language: 'en-us', gender: 'Female', grade: 'C' },
    { id: 'af_river', name: 'River', language: 'en-us', gender: 'Female', grade: 'D' },
    { id: 'af_sarah', name: 'Sarah', language: 'en-us', gender: 'Female', grade: 'C+' },
    { id: 'af_sky', name: 'Sky', language: 'en-us', gender: 'Female', grade: 'C-' },
    { id: 'am_adam', name: 'Adam', language: 'en-us', gender: 'Male', grade: 'F+' },
    { id: 'am_echo', name: 'Echo', language: 'en-us', gender: 'Male', grade: 'D' },
    { id: 'am_eric', name: 'Eric', language: 'en-us', gender: 'Male', grade: 'D' },
    { id: 'am_fenrir', name: 'Fenrir', language: 'en-us', gender: 'Male', grade: 'C+' },
    { id: 'am_liam', name: 'Liam', language: 'en-us', gender: 'Male', grade: 'D' },
    { id: 'am_michael', name: 'Michael', language: 'en-us', gender: 'Male', grade: 'C+' },
    { id: 'am_onyx', name: 'Onyx', language: 'en-us', gender: 'Male', grade: 'D' },
    { id: 'am_puck', name: 'Puck', language: 'en-us', gender: 'Male', grade: 'C+' },
    { id: 'am_santa', name: 'Santa', language: 'en-us', gender: 'Male', grade: 'D-' },
    { id: 'bf_alice', name: 'Alice', language: 'en-gb', gender: 'Female', grade: 'D' },
    { id: 'bf_emma', name: 'Emma', language: 'en-gb', gender: 'Female', grade: 'B-' },
    { id: 'bf_isabella', name: 'Isabella', language: 'en-gb', gender: 'Female', grade: 'C' },
    { id: 'bf_lily', name: 'Lily', language: 'en-gb', gender: 'Female', grade: 'D' },
    { id: 'bm_daniel', name: 'Daniel', language: 'en-gb', gender: 'Male', grade: 'D' },
    { id: 'bm_fable', name: 'Fable', language: 'en-gb', gender: 'Male', grade: 'C' },
    { id: 'bm_george', name: 'George', language: 'en-gb', gender: 'Male', grade: 'C' },
    { id: 'bm_lewis', name: 'Lewis', language: 'en-gb', gender: 'Male', grade: 'D+' },
];

async function loadKokoroModel() {
    if (kokoroStatus === 'ready' || kokoroStatus === 'loading') return;
    kokoroStatus = 'loading';
    kokoroLoadError = null;
    console.log('[TTS] Loading Kokoro model (q8, ~86MB first time)...');
    try {
        const { KokoroTTS } = await import('kokoro-js');
        // Redirect model cache to a writable directory outside app.asar
        const { env } = await import('@huggingface/transformers');
        const cacheBase = process.env.USER_DATA_PATH
            ? path.join(process.env.USER_DATA_PATH, 'hf_cache')
            : path.join(os.homedir(), '.cache', 'ollama-brah', 'hf_cache');
        env.cacheDir = cacheBase;
        console.log('[TTS] Using cache dir:', cacheBase);
        kokoroTTS = await KokoroTTS.from_pretrained(
            'onnx-community/Kokoro-82M-v1.0-ONNX',
            { dtype: 'q8' }
        );
        kokoroStatus = 'ready';
        console.log('[TTS] Kokoro model loaded successfully');
    } catch (err) {
        kokoroStatus = 'error';
        kokoroLoadError = err.message;
        console.error('[TTS] Failed to load Kokoro model:', err);
    }
}

const corsOptions = {
    origin: function (origin, callback) {
        // No origin = same-origin or non-browser (Node http.request) — always allow
        // 'null' string = Electron renderer loaded via file:// — allow when running as Electron app
        // extensionOrigin = the Chrome extension — allow
        if (!origin || origin === extensionOrigin ||
            (origin === 'null' && process.env.ALLOWED_ORIGIN === 'electron-app')) {
            callback(null, true);
        } else {
            console.warn(`CORS: Request from origin '${origin}' blocked. Expected '${extensionOrigin}'`);
            callback(new Error('Not allowed by CORS'));
        }
    }
};

const app = express();
app.use(cors(corsOptions));
app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
        let data = '';
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            req.rawBody = data;
            try {
                req.body = JSON.parse(data);
            } catch (e) {
                // ignore
            }
            next();
        });
    } else {
        next();
    }
});

async function getOllamaDiagnostics() {
    const result = {
        status: 'unreachable',
        reachable: false,
        modelCount: 0,
        models: [],
        message: 'Ollama is not reachable.',
        error: null
    };

    try {
        const resp = await fetch(`${OLLAMA_API_BASE_URL}/api/tags`, {
            signal: AbortSignal.timeout(4000)
        });

        if (!resp.ok) {
            result.status = 'error';
            result.error = `HTTP ${resp.status}`;
            result.message = `Ollama returned HTTP ${resp.status}.`;
            return result;
        }

        const data = await resp.json();
        const models = data.models || [];
        result.reachable = true;
        result.models = models;
        result.modelCount = models.length;
        result.status = models.length > 0 ? 'ready' : 'no_models';
        result.message = models.length > 0
            ? `Ollama is running with ${models.length} installed model${models.length === 1 ? '' : 's'}.`
            : 'Ollama is running, but no models are installed yet.';
        return result;
    } catch (err) {
        result.error = err.name === 'TimeoutError' ? 'timeout' : err.message;
        result.message = err.name === 'TimeoutError'
            ? 'Ollama did not respond in time.'
            : `Ollama is not reachable: ${err.message}`;
        return result;
    }
}

async function buildReadinessReport() {
    const [ollama, memoryStatus] = await Promise.all([
        getOllamaDiagnostics(),
        memory.getStatus().catch(err => ({ available: false, reason: err.message, count: 0 }))
    ]);

    const stt = getWhisperDiagnostics();
    const llamacpp = getLlamacppDiagnostics();
    const blockingIssues = [];
    const warnings = [];
    const recommendedActions = [];

    const addAction = (id, label, description, meta = {}) => {
        if (recommendedActions.some(action => action.id === id)) return;
        recommendedActions.push({ id, label, description, ...meta });
    };

    const chatAvailable = ollama.status === 'ready' || llamacpp.canUse || llamacpp.status === 'ready';
    let overallState = 'ready';

    if (ollama.status === 'unreachable' && !(llamacpp.canUse || llamacpp.status === 'ready')) {
        overallState = 'blocked';
        blockingIssues.push({
            id: 'no_chat_backend',
            title: 'No chat backend is ready',
            detail: 'Ollama is unavailable and llama.cpp is not ready as a fallback.'
        });
        addAction('retry', 'Retry checks', 'Run readiness diagnostics again.');
        if (llamacpp.canUse || llamacpp.modelCount > 0) {
            addAction('switch_llamacpp', 'Switch to llama.cpp', 'Use an available GGUF model instead of Ollama.', { backend: 'llamacpp' });
        }
        addAction('open_llamacpp_settings', 'Configure llama.cpp', 'Open Settings and review your llama.cpp executable and models directory.', { section: 'llamaCpp' });
    }

    if (ollama.status === 'unreachable') {
        warnings.push({
            id: 'ollama_unreachable',
            title: 'Ollama is offline',
            detail: ollama.message
        });
        addAction('retry', 'Retry checks', 'Check again after starting Ollama.');
    } else if (ollama.status === 'no_models') {
        overallState = overallState === 'blocked' ? 'blocked' : 'degraded';
        blockingIssues.push({
            id: 'ollama_no_models',
            title: 'No Ollama models installed',
            detail: 'Ollama is running, but there are no models available to chat with yet.'
        });
        addAction('open_model_management', 'Open model management', 'Pull or update models from the Settings panel.', { section: 'modelMgmt' });
        if (llamacpp.canUse || llamacpp.modelCount > 0) {
            addAction('switch_llamacpp', 'Switch to llama.cpp', 'Use an available GGUF model instead of installing an Ollama model first.', { backend: 'llamacpp' });
        }
    }

    if (!memoryStatus.available) {
        if (overallState === 'ready') overallState = 'degraded';
        warnings.push({
            id: 'memory_unavailable',
            title: 'Memory support needs setup',
            detail: memoryStatus.reason || 'The embedding model for memory is not available.'
        });
        addAction('open_memory_settings', 'Enable memory support', 'Open Settings and review the memory requirements.', { section: 'memory' });
    }

    if (!stt.scriptPresent || !stt.pythonAvailable || stt.whisperStatus === 'error') {
        if (overallState === 'ready') overallState = 'degraded';
        warnings.push({
            id: 'voice_unavailable',
            title: 'Voice input needs setup',
            detail: stt.message
        });
        addAction('open_tts_settings', 'Review voice setup', 'Open Settings and review voice requirements.', { section: 'tts' });
    }

    if (!llamacpp.canUse && llamacpp.status !== 'ready') {
        warnings.push({
            id: 'llamacpp_not_ready',
            title: 'llama.cpp fallback not ready',
            detail: llamacpp.message
        });
        addAction('open_llamacpp_settings', 'Configure llama.cpp', 'Open Settings and review your llama.cpp executable and models directory.', { section: 'llamaCpp' });
    }

    const primaryBackend = ollama.status === 'ready' ? 'ollama' : ((llamacpp.canUse || llamacpp.status === 'ready') ? 'llamacpp' : null);

    return {
        checkedAt: new Date().toISOString(),
        overallState,
        chatAvailable,
        primaryBackend,
        blockingIssues,
        warnings,
        recommendedActions,
        checks: {
            proxy: {
                status: 'ready',
                message: 'Internal proxy is running.'
            },
            ollama,
            memory: memoryStatus,
            stt,
            llamacpp
        }
    };
}

// --- Server Management ---

let serverInstance = null;

app.post('/api/shutdown', (req, res) => {
    res.json({ status: 'shutting_down' });
    setTimeout(() => {
        const llamaProcess = getLlamaProcess();
        const whisperProcess = getWhisperProcess();
        if (llamaProcess) try { llamaProcess.kill(); } catch (e) {}
        if (whisperProcess) try { whisperProcess.kill(); } catch (e) {}
        if (serverInstance) serverInstance.close();
    }, 200);
});

// --- Kokoro TTS Endpoints ---

app.get('/api/tts/status', (req, res) => {
    res.json({
        status: kokoroStatus,
        error: kokoroLoadError
    });
});

app.get('/api/tts/voices', (req, res) => {
    // Voice list is static - no need to wait for model load
    res.json({ voices: KOKORO_VOICES });
});

app.post('/api/tts/load', async (req, res) => {
    // Pre-load the model so first TTS use is fast
    if (kokoroStatus === 'ready') {
        return res.json({ status: 'ready' });
    }
    if (kokoroStatus === 'loading') {
        return res.json({ status: 'loading' });
    }
    // Start loading in background, respond immediately
    loadKokoroModel();
    res.json({ status: 'loading' });
});

// Split text into sentences for chunked generation
function splitIntoSentences(text) {
    // Split on sentence-ending punctuation followed by space/newline, or on double newlines
    const chunks = text
        .split(/(?<=[.!?])\s+|(?:\r?\n){2,}/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    // Merge very short fragments into the previous chunk
    const merged = [];
    for (const chunk of chunks) {
        if (merged.length > 0 && chunk.length < 20) {
            merged[merged.length - 1] += ' ' + chunk;
        } else {
            merged.push(chunk);
        }
    }
    return merged.length > 0 ? merged : [text];
}

app.post('/api/tts/generate', async (req, res) => {
    const { text, voice } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'text is required' });
    }

    try {
        if (kokoroStatus === 'not_loaded' || kokoroStatus === 'error') {
            await loadKokoroModel();
        }
        if (kokoroStatus === 'loading') {
            return res.status(503).json({ status: 'loading', message: 'Model is loading, please try again shortly' });
        }
        if (kokoroStatus !== 'ready' || !kokoroTTS) {
            return res.status(500).json({ error: 'TTS model not available' });
        }

        const sentences = splitIntoSentences(text);
        console.log(`[TTS] Generating ${sentences.length} sentence(s) for ${text.length} chars`);

        res.setHeader('Content-Type', 'application/octet-stream');
        let sampleRateSent = false;
        let aborted = false;

        req.on('close', () => { aborted = true; });

        for (const sentence of sentences) {
            if (aborted) break;
            try {
                const audio = await kokoroTTS.generate(sentence, { voice: voice || undefined });
                const sampleRate = audio.sampling_rate || 24000;

                if (!sampleRateSent) {
                    res.setHeader('X-Sample-Rate', String(sampleRate));
                    sampleRateSent = true;
                }

                const pcmData = audio.audio; // Float32Array
                const buffer = Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
                res.write(buffer);
            } catch (sentenceErr) {
                console.error(`[TTS] Error generating sentence "${sentence.substring(0, 50)}...":`, sentenceErr.message);
                // Skip this sentence and continue with the rest
            }
        }

        res.end();
    } catch (err) {
        console.error('[TTS] Error generating speech:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.end();
        }
    }
});

// --- Whisper STT Routes ---

app.get('/api/stt/status', handleSttStatus);
app.post('/api/stt/load', handleSttLoad);
app.post('/api/stt/transcribe', handleSttTranscribe);

// --- llama.cpp Routes ---

app.get('/api/llamacpp/status', handleLlamacppStatus);
app.post('/api/llamacpp/config', handleLlamacppConfig);
app.get('/api/llamacpp/models', handleLlamacppModels);
app.post('/api/llamacpp/load', handleLlamacppLoad);
app.post('/api/llamacpp/stop', handleLlamacppStop);
app.delete('/api/llamacpp/delete', handleLlamacppDelete);
app.post('/api/llamacpp/chat', handleLlamacppChat);

// --- Context / Model Info Routes ---

app.get('/api/model/detect-context-limit', handleDetectContextLimit);
app.get('/api/llmfit/recommend', handleLlmfitRecommend);

// --- Research Route ---

app.post('/api/research', handleResearch);

// --- Agent Routes ---

app.post('/api/agent/permission', handleAgentPermission);
app.get('/api/agent/config', handleAgentConfigGet);
app.post('/api/agent/config', handleAgentConfigPost);
app.post('/api/agent/chat', handleAgentChat);

// --- Skills API ---

app.get('/api/skills/list', handleSkillsList);
app.post('/api/skills/reload', handleSkillsReload);
app.post('/api/skills/import', handleSkillsImport);
app.post('/api/skills/import-url', handleSkillsImportUrl);
app.delete('/api/skills/:name', handleSkillsDelete);
app.get('/api/skills/dir', handleSkillsDir);
app.post('/api/skills/run-cli', handleSkillsRunCli);

// --- API Keys Endpoints ---

app.get('/api/readiness', async (req, res) => {
    try {
        res.json(await buildReadinessReport());
    } catch (err) {
        res.status(500).json({
            overallState: 'blocked',
            chatAvailable: false,
            blockingIssues: [{
                id: 'readiness_failed',
                title: 'Readiness checks failed',
                detail: err.message
            }],
            warnings: [],
            recommendedActions: [{
                id: 'retry',
                label: 'Retry checks',
                description: 'Try the readiness checks again.'
            }],
            checks: {
                proxy: {
                    status: 'error',
                    message: err.message
                }
            }
        });
    }
});

// GET /api/keys — return whether each key is configured (never returns raw key value)
app.get('/api/keys', (req, res) => {
    res.json({
        tavilyConfigured: !!(process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY !== 'your_tavily_api_key_here'),
        exaConfigured:    !!(process.env.EXA_API_KEY    && process.env.EXA_API_KEY    !== 'your_exa_api_key_here'),
    });
});

// POST /api/keys — update API keys in process.env at runtime (no restart needed)
app.post('/api/keys', (req, res) => {
    const { tavilyApiKey, exaApiKey } = req.body || {};
    if (tavilyApiKey !== undefined) process.env.TAVILY_API_KEY = String(tavilyApiKey).trim();
    if (exaApiKey    !== undefined) process.env.EXA_API_KEY    = String(exaApiKey).trim();
    res.json({ ok: true });
});

// --- Memory Endpoints ---

// GET /api/memory/status — check if nomic-embed-text is available
app.get('/api/memory/status', async (req, res) => {
    try { res.json(await memory.getStatus()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/memory — list all stored memories
app.get('/api/memory', async (req, res) => {
    try { res.json(await memory.listMemories()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/memory — add a memory manually
app.post('/api/memory', async (req, res) => {
    const { text, source } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
    try {
        const id = await memory.addMemory(text.trim(), { source: source || 'manual' });
        console.log(`[Memory] Manually added: "${text.slice(0, 80)}" (id: ${id})`);
        res.json({ id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/memory/all — clear every memory
app.delete('/api/memory/all', async (req, res) => {
    try { await memory.clearMemories(); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/memory/:id — delete a single memory
app.delete('/api/memory/:id', async (req, res) => {
    try { await memory.deleteMemory(req.params.id); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/memory/extract — run LLM-based fact extraction on a conversation exchange
app.post('/api/memory/extract', async (req, res) => {
    const { userMessage, assistantMessage, model } = req.body || {};
    if (!userMessage || !assistantMessage || !model) {
        return res.status(400).json({ error: 'userMessage, assistantMessage, and model are required' });
    }

    // Strip <think> blocks — we only want the actual response content
    const cleanAssistant = assistantMessage.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const extractionPrompt =
        `You are a memory extraction assistant. Review this conversation exchange and extract any facts worth remembering for future conversations.\n\n` +
        `Extract ONLY:\n` +
        `- User preferences (e.g. "User prefers dark mode")\n` +
        `- Personal facts the user shared (e.g. "User works at Acme Corp")\n` +
        `- Ongoing project details (e.g. "User's project uses Python 3.11 and PostgreSQL")\n` +
        `- Important decisions or conclusions\n\n` +
        `Return ONLY a raw JSON array of short strings. If nothing is worth remembering, return []. No explanation, no markdown fences.\n\n` +
        `User: ${userMessage.slice(0, 800)}\n` +
        `Assistant: ${cleanAssistant.slice(0, 800)}`;

    try {
        const payload = JSON.stringify({
            model,
            messages: [{ role: 'user', content: extractionPrompt }],
            stream: false,
            options: { temperature: 0 }
        });

        const responseText = await new Promise((resolve, reject) => {
            const req2 = http.request({
                hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            }, (r) => {
                let raw = '';
                r.on('data', d => { raw += d; });
                r.on('end', () => {
                    try { resolve(JSON.parse(raw).message?.content || ''); }
                    catch { reject(new Error('Bad Ollama response')); }
                });
                r.on('error', reject);
            });
            req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('Extraction timed out')); });
            req2.on('error', reject);
            req2.write(payload);
            req2.end();
        });

        // Pull out the first JSON array from the response
        const match = responseText.match(/\[[\s\S]*?\]/);
        if (!match) return res.json({ saved: 0, facts: [] });

        let facts;
        try { facts = JSON.parse(match[0]); } catch { return res.json({ saved: 0, facts: [] }); }
        if (!Array.isArray(facts) || facts.length === 0) return res.json({ saved: 0, facts: [] });

        const saved = [];
        for (const fact of facts) {
            if (typeof fact === 'string' && fact.trim()) {
                await memory.addMemory(fact.trim(), { source: 'auto-extract', model });
                saved.push(fact.trim());
                console.log(`[Memory] Auto-extracted: "${fact.trim().slice(0, 80)}"`);
            }
        }
        res.json({ saved: saved.length, facts: saved });
    } catch (err) {
        console.warn('[Memory] Extraction failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- Ollama Proxy ---

app.all('/proxy/*', handleOllamaProxy);

module.exports = { app, PORT, serverInstance: null, buildReadinessReport, getOllamaDiagnostics };

// Export serverInstance setter so server.js can assign it after listen
module.exports.setServerInstance = function(inst) { serverInstance = inst; };
module.exports.getServerInstance = function() { return serverInstance; };
