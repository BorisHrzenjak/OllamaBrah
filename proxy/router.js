// proxy/router.js — Express app, CORS, middleware, registers all route handlers

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const memory = require('./memory');
const { handleProcessAttachments } = require('./attachments');
const {
    DEFAULT_OLLAMA_BASE_URL,
    fetchOllama,
    getConfiguredOllamaBaseUrl,
    setConfiguredOllamaBaseUrl,
} = require('./ollama');

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
    handleAgentPlan,
    handleAgentConfigGet,
    handleAgentConfigPost,
} = require('./tools');

const {
    handleLlamacppStatus,
    handleLlamacppConfig,
    handleLlamacppModels,
    handleLlamacppModelProfile,
    handleLlamacppLoad,
    handleLlamacppStop,
    handleLlamacppDelete,
    handleLlamacppChat,
    handleDetectContextLimit,
    handleLlmfitRecommend,
    handleResearch,
    handleAgentChat,
    handleAgentRunList,
    handleAgentRunCreate,
    handleAgentRunGet,
    handleAgentRunStream,
    handleAgentRunCancel,
    handleAgentRunResume,
    handleOllamaProxy,
    getLlamacppDiagnostics,
    getLlamaProcess,
} = require('./llm');

const PORT = 3456;
const extensionOrigin = 'chrome-extension://gkpfpdekobmonacdgjgbfehilnloaacm';

function normalizeFactText(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isFactGroundedInUserMessage(fact, userMessage) {
    const factNorm = normalizeFactText(fact);
    const userNorm = normalizeFactText(userMessage);
    if (!factNorm || !userNorm) return false;
    if (userNorm.includes(factNorm)) return true;

    const factTokens = factNorm.split(' ').filter(t => t.length >= 3);
    if (!factTokens.length) return false;
    const hits = factTokens.filter(token => userNorm.includes(token)).length;
    return hits >= Math.max(2, Math.ceil(factTokens.length * 0.5));
}

function extractSimpleMemoryFacts(userMessage) {
    const text = String(userMessage || '').trim();
    const facts = [];

    const patterns = [
        { re: /\bmy name is\s+([^,.!\n]+)/i, fmt: m => `User's name is ${m[1].trim()}` },
        { re: /\bi live in\s+([^,.!\n]+)/i, fmt: m => `User lives in ${m[1].trim()}` },
        { re: /\bi work with\s+([^,.!\n]+)/i, fmt: m => `User works with ${m[1].trim()}` },
        { re: /\bi use\s+([^,.!\n]+)\s+for\s+([^,.!\n]+)/i, fmt: m => `User uses ${m[1].trim()} for ${m[2].trim()}` },
        { re: /\bi prefer\s+([^,.!\n]+)/i, fmt: m => `User prefers ${m[1].trim()}` },
        { re: /\bmy birthday is\s+([^,.!\n]+)/i, fmt: m => `User's birthday is ${m[1].trim()}` },
        { re: /\bmy mom (?:is called|is named|is)\s+([^,.!\n]+)/i, fmt: m => `User's mom is named ${m[1].trim()}` },
        { re: /\bmy mother (?:is called|is named|is)\s+([^,.!\n]+)/i, fmt: m => `User's mother is named ${m[1].trim()}` },
        { re: /\bmy dad (?:is called|is named|is)\s+([^,.!\n]+)/i, fmt: m => `User's dad is named ${m[1].trim()}` },
        { re: /\bmy father (?:is called|is named|is)\s+([^,.!\n]+)/i, fmt: m => `User's father is named ${m[1].trim()}` },
        { re: /\bi have a brother(?:,?\s*(?:called|named)\s+([^,.!\n]+))?/i, fmt: m => m[1] ? `User has a brother named ${m[1].trim()}` : 'User has a brother' },
        { re: /\bi have a sister(?:,?\s*(?:called|named)\s+([^,.!\n]+))?/i, fmt: m => m[1] ? `User has a sister named ${m[1].trim()}` : 'User has a sister' },
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern.re);
        if (match) {
            const fact = pattern.fmt(match).replace(/\s+/g, ' ').trim();
            if (fact) facts.push(fact);
        }
    }

    return [...new Set(facts)];
}

function isLikelyMemoryNoise(fact, userMessage) {
    const factNorm = normalizeFactText(fact);
    const userNorm = normalizeFactText(userMessage);
    if (!factNorm) return true;

    if (/\bollamabrah\b|\bthe app\b|\bthis app\b/.test(factNorm)) {
        return true;
    }

    if (/\b(tavily|exa|whisper|kokoro|agent mode|semantic memory|web search|deep research|themes?)\b/.test(factNorm)) {
        return true;
    }

    if (/\b(template|prompt template|eli5|explain like i m 5|rewrite|summarize|brainstorm|outline)\b/.test(factNorm)) {
        const explicitPreference = /\b(i prefer|i like|my preference is|i want)\b/.test(userNorm);
        if (!explicitPreference) return true;
    }

    if (/\b(roadmap|implementation plan|release plan|task list|backlog|feature idea|feature request|improvement plan|project brief)\b/.test(factNorm)) {
        return true;
    }

    if (/\b(build|create|add|implement|ship|launch)\b.*\b(feature|workflow|integration|support|page|dashboard|agent|tool)\b/.test(factNorm)) {
        return true;
    }

    return false;
}

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
        const { KokoroTTS } = require('kokoro-js');
        const { env } = require('@huggingface/transformers');
        // Redirect model cache to a writable directory outside app.asar
        const cacheBase = process.env.USER_DATA_PATH
            ? path.join(process.env.USER_DATA_PATH, 'hf_cache')
            : path.join(os.homedir(), '.cache', 'ollama-brah', 'hf_cache');
        fs.mkdirSync(cacheBase, { recursive: true });
        env.allowLocalModels = false;
        env.useFSCache = true;
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
        const resp = await fetchOllama('/api/tags', {
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
            title: 'Chat cannot start yet',
            detail: 'Ollama is unavailable and llama.cpp is not ready as a fallback.'
        });
        addAction('retry', 'Check again', 'Run startup checks again after you make a change.');
        if (llamacpp.canUse || llamacpp.modelCount > 0) {
            addAction('switch_llamacpp', 'Use llama.cpp instead', 'Start chatting with an available GGUF model right away.', { backend: 'llamacpp' });
        }
        addAction('open_llamacpp_settings', 'Fix llama.cpp setup', 'Open Settings and review the executable path and models folder.', { section: 'llamaCpp' });
    }

    if (ollama.status === 'unreachable') {
        warnings.push({
            id: 'ollama_unreachable',
            title: 'Ollama is offline',
            detail: ollama.message
        });
        addAction('open_ollama_settings', 'Review Ollama server URL', 'Open Settings and check which Ollama server URL this app should use.', { section: 'ollama' });
        addAction('retry', 'Check again', 'Refresh startup checks after Ollama finishes starting.');
    } else if (ollama.status === 'no_models') {
        overallState = overallState === 'blocked' ? 'blocked' : 'degraded';
        blockingIssues.push({
            id: 'ollama_no_models',
            title: 'No Ollama model is ready yet',
            detail: 'Ollama is running, but there is nothing installed to chat with yet.'
        });
        addAction('open_model_management', 'Install a model', 'Open Settings and pull your first Ollama model.', { section: 'modelMgmt' });
        if (llamacpp.canUse || llamacpp.modelCount > 0) {
            addAction('switch_llamacpp', 'Use llama.cpp instead', 'Skip model install for now and chat with an available GGUF model.', { backend: 'llamacpp' });
        }
    }

    if (!memoryStatus.available) {
        if (overallState === 'ready') overallState = 'degraded';
        warnings.push({
            id: 'memory_unavailable',
            title: 'Memory support needs setup',
            detail: memoryStatus.reason || 'The embedding model for memory is not available.'
        });
        addAction('open_memory_settings', 'Fix memory setup', 'Open Settings and enable the embedding model used for memory.', { section: 'memory' });
    }

    if (!stt.scriptPresent || !stt.pythonAvailable || stt.whisperStatus === 'error') {
        if (overallState === 'ready') overallState = 'degraded';
        warnings.push({
            id: 'voice_unavailable',
            title: 'Voice input needs setup',
            detail: stt.message
        });
        addAction('open_tts_settings', 'Fix voice setup', 'Open Settings and review Whisper and Python requirements.', { section: 'tts' });
    }

    if (!llamacpp.canUse && llamacpp.status !== 'ready') {
        warnings.push({
            id: 'llamacpp_not_ready',
            title: 'llama.cpp fallback not ready',
            detail: llamacpp.message
        });
        addAction('open_llamacpp_settings', 'Fix llama.cpp setup', 'Open Settings and review the executable path and models folder.', { section: 'llamaCpp' });
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

app.get('/api/tts/self-test', async (req, res) => {
    try {
        if (kokoroStatus === 'not_loaded' || kokoroStatus === 'error') {
            await loadKokoroModel();
        }
        if (kokoroStatus === 'loading') {
            return res.status(503).json({ status: 'loading', message: 'Model is still loading' });
        }
        if (kokoroStatus !== 'ready' || !kokoroTTS) {
            return res.status(500).json({ status: 'error', error: kokoroLoadError || 'TTS model not available' });
        }

        const voice = 'af_heart';
        const text = 'Kokoro self test.';
        const startedAt = Date.now();
        const audio = await kokoroTTS.generate(text, { voice });
        const durationMs = Date.now() - startedAt;

        return res.json({
            status: 'ok',
            text,
            voice,
            sampleRate: audio.sampling_rate || 24000,
            samples: audio.audio?.length || 0,
            durationMs,
        });
    } catch (err) {
        console.error('[TTS] Self-test failed:', err);
        return res.status(500).json({
            status: 'error',
            error: err.message,
        });
    }
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

        req.on('aborted', () => { aborted = true; });
        res.on('close', () => {
            if (!res.writableEnded) aborted = true;
        });

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
app.post('/api/llamacpp/model-profile', handleLlamacppModelProfile);
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
app.post('/api/agent/plan', handleAgentPlan);
app.get('/api/agent/config', handleAgentConfigGet);
app.post('/api/agent/config', handleAgentConfigPost);
app.get('/api/agent/runs', handleAgentRunList);
app.post('/api/agent/runs', handleAgentRunCreate);
app.get('/api/agent/runs/:id', handleAgentRunGet);
app.get('/api/agent/runs/:id/stream', handleAgentRunStream);
app.post('/api/agent/runs/:id/cancel', handleAgentRunCancel);
app.post('/api/agent/runs/:id/resume', handleAgentRunResume);
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

app.post('/api/attachments/process', handleProcessAttachments);

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

app.get('/api/ollama/config', (req, res) => {
    const baseUrl = getConfiguredOllamaBaseUrl();
    res.json({
        baseUrl,
        usingDefault: baseUrl === DEFAULT_OLLAMA_BASE_URL,
    });
});

app.post('/api/ollama/config', (req, res) => {
    try {
        const { baseUrl } = req.body || {};
        const configured = setConfiguredOllamaBaseUrl(baseUrl);
        res.json({
            ok: true,
            baseUrl: configured,
            usingDefault: configured === DEFAULT_OLLAMA_BASE_URL,
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Invalid Ollama URL' });
    }
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

app.get('/api/memory/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 8, 20));
    if (!q) return res.json([]);
    try { res.json(await memory.searchMemories(q, limit)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/memory — add a memory manually
app.post('/api/memory', async (req, res) => {
    const { text, source, sourceType, conversationId, messageId, extractionMode, reviewed, origin } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
    try {
        const id = await memory.addMemory(text.trim(), {
            source: source || 'manual',
            sourceType: sourceType || source || 'manual',
            conversationId: conversationId || null,
            messageId: messageId || null,
            extractionMode: extractionMode || 'manual',
            reviewed: reviewed !== false,
            origin: origin || null,
        });
        const kind = sourceType || source || 'manual';
        console.log(`[Memory] Added (${kind}): "${text.slice(0, 80)}" (id: ${id})`);
        res.json({ id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/memory/:id', async (req, res) => {
    try { res.json(await memory.updateMemory(req.params.id, req.body || {})); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memory/dedupe', async (req, res) => {
    try { res.json(await memory.dedupeExistingMemories()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memory/cleanup-junk', async (req, res) => {
    try { res.json(await memory.cleanupJunkMemories()); }
    catch (err) { res.status(500).json({ error: err.message }); }
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
    const { userMessage, assistantMessage, model, backend, conversationId, userMessageId, assistantMessageId } = req.body || {};
    if (!userMessage || !assistantMessage || !model) {
        return res.status(400).json({ error: 'userMessage, assistantMessage, and model are required' });
    }

    const extractionPrompt =
        `You are a memory extraction assistant. Extract only durable facts that the USER explicitly stated and that would be useful in future conversations.\n\n` +
        `Extract ONLY:\n` +
        `- User preferences (e.g. "User prefers dark mode")\n` +
        `- Personal facts the user shared (e.g. "User works at Acme Corp")\n` +
        `- Ongoing project details (e.g. "User's project uses Python 3.11 and PostgreSQL")\n` +
        `- Important decisions the user made\n\n` +
        `Rules:\n` +
        `- Use only facts grounded in the USER message.\n` +
        `- Never infer, elaborate, summarize culture/history, or add related facts.\n` +
        `- Never store facts about OllamaBrah, app features, prompt templates, or one-off drafting instructions as memory.\n` +
        `- If the user only asked a question and shared no durable fact, return [].\n` +
        `- Return ONLY a raw JSON array of short strings. No explanation, no markdown fences.\n\n` +
        `User: ${userMessage.slice(0, 1200)}`;

    try {
        const responseText = await new Promise((resolve, reject) => {
            if (backend === 'llamacpp') {
                const diag = getLlamacppDiagnostics();
                const payload = JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: extractionPrompt }],
                    temperature: 0,
                    stream: false,
                });
                const req2 = http.request({
                    hostname: '127.0.0.1', port: diag.port || 8080, path: '/v1/chat/completions', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                }, (r) => {
                    let raw = '';
                    r.on('data', d => { raw += d; });
                    r.on('end', () => {
                        try { resolve(JSON.parse(raw).choices?.[0]?.message?.content || ''); }
                        catch { reject(new Error('Bad llama.cpp extraction response')); }
                    });
                    r.on('error', reject);
                });
                req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('Extraction timed out')); });
                req2.on('error', reject);
                req2.write(payload);
                req2.end();
                return;
            }

            const payload = JSON.stringify({
                model,
                messages: [{ role: 'user', content: extractionPrompt }],
                stream: false,
                options: { temperature: 0 }
            });
            fetchOllama('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                signal: AbortSignal.timeout(30000)
            }).then(async (r) => {
                const raw = await r.text();
                try { resolve(JSON.parse(raw).message?.content || ''); }
                catch { reject(new Error('Bad Ollama response')); }
            }).catch(err => {
                reject(err.name === 'TimeoutError' ? new Error('Extraction timed out') : err);
            });
        });

        // Pull out the first JSON array from the response
        const match = responseText.match(/\[[\s\S]*?\]/);
        let facts = [];
        if (match) {
            try { facts = JSON.parse(match[0]); } catch { facts = []; }
        }
        if (!Array.isArray(facts)) facts = [];
        const directFacts = extractSimpleMemoryFacts(userMessage);
        const directFactSet = new Set(directFacts.map(normalizeFactText));
        facts = [...facts, ...directFacts];
        if (facts.length === 0) return res.json({ candidates: [] });

        const candidates = [];
        const seenFacts = new Set();
        for (const fact of facts) {
            if (typeof fact === 'string' && fact.trim()) {
                const text = fact.trim();
                const normalized = normalizeFactText(text);
                if (!normalized || seenFacts.has(normalized)) continue;
                if (!directFactSet.has(normalized) && !isFactGroundedInUserMessage(text, userMessage)) continue;
                if (isLikelyMemoryNoise(text, userMessage)) continue;
                seenFacts.add(normalized);
                candidates.push({
                    text,
                    source: 'auto-extract',
                    sourceType: 'conversation',
                    extractionMode: 'auto',
                    reviewed: false,
                    conversationId: conversationId || null,
                    messageId: assistantMessageId || userMessageId || null,
                    origin: {
                        model,
                        backend: backend || 'ollama',
                        userMessageId: userMessageId || null,
                        assistantMessageId: assistantMessageId || null,
                    }
                });
            }
        }
        res.json({ candidates });
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
