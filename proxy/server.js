require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { URL } = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const memory = require('./memory');
const diffLib = require('diff');

// --- Web Search (Tavily + Jina Reader) ---

const SEARCH_TRIGGERS = [
    /\b(today|yesterday|this (week|month|year)|right now|currently|latest|recent|newest)\b/i,
    /\b(breaking|just announced|just released|as of \d{4})\b/i,
    /\b(what('s| is| are) the? (current|latest|newest|price|score|weather))\b/i,
    /\b(news about|update on|what happened (to|with|at)|who won|who is the current)\b/i,
    /\b(20(24|25|26))\b/,
    /\b(stock price|weather forecast|election results|release date)\b/i,
];

function heuristicNeedsSearch(text) {
    return SEARCH_TRIGGERS.some(re => re.test(text));
}

function extractUrls(text) {
    const urlRegex = /https?:\/\/[^\s)>,"'\]]+/g;
    return [...new Set(text.match(urlRegex) || [])];
}

// Jina Reader: fetches live page content as markdown, free, no API key needed
async function fetchPageViaJina(url, maxChars = 4000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s max
    try {
        const resp = await fetch(`https://r.jina.ai/${url}`, {
            headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
            signal: controller.signal
        });
        if (!resp.ok) throw new Error(`Jina HTTP ${resp.status}`);
        const text = await resp.text();
        return text.slice(0, maxChars);
    } finally {
        clearTimeout(timeout);
    }
}

// Fetch a URL as a raw Buffer (follows up to 5 redirects)
async function fetchBinaryUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && maxRedirects > 0) {
                resolve(fetchBinaryUrl(resp.headers.location, maxRedirects - 1));
                return;
            }
            const bufs = [];
            resp.on('data', d => bufs.push(d));
            resp.on('end', () => resolve(Buffer.concat(bufs)));
            resp.on('error', reject);
        }).on('error', reject);
    });
}

async function fetchTavilyResults(query) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey || apiKey === 'your_tavily_api_key_here') {
        console.warn('[Search] TAVILY_API_KEY not set in .env — skipping search');
        return null;
    }
    const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: apiKey,
            query: query.slice(0, 300),
            max_results: 5,
            search_depth: 'basic'
        })
    });
    if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
    return resp.json();
}

async function fetchExaResearch(query) {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey || apiKey === 'your_exa_api_key_here') {
        console.warn('[Research] EXA_API_KEY not set in .env — skipping deep research');
        return null;
    }
    console.log(`[Research] Querying Exa for: "${query.slice(0, 100)}"`);
    const resp = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: query.slice(0, 500),
            numResults: 5,
            type: 'auto',
            contents: {
                text: { maxCharacters: 2000 },
                highlights: { numSentences: 3, highlightsPerUrl: 3 }
            }
        })
    });
    if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        throw new Error(`Exa HTTP ${resp.status}: ${errorText}`);
    }
    return resp.json();
}

function formatExaResults(data) {
    if (!data?.results?.length) return null;
    const sections = data.results.map((r, i) => {
        const title = r.title || 'Untitled';
        const url = r.url || '';
        const lines = [
            `[${i + 1}] Title: ${title}`,
            `    URL: ${url}`,
        ];
        if (r.publishedDate) lines.push(`    Published: ${r.publishedDate.slice(0, 10)}`);
        if (r.text) lines.push(`\n${r.text.trim()}`);
        if (r.highlights?.length) lines.push(`\nKey highlights:\n${r.highlights.map(h => `- ${h}`).join('\n')}`);
        return lines.join('\n');
    });
    return sections.join('\n\n---\n\n');
}

const app = express();
const PORT = 3456;
const OLLAMA_API_BASE_URL = 'http://localhost:11434';
const extensionOrigin = 'chrome-extension://gkpfpdekobmonacdgjgbfehilnloaacm';

// Kokoro TTS state
let kokoroTTS = null;
let kokoroStatus = 'not_loaded'; // 'not_loaded' | 'loading' | 'ready' | 'error'
let kokoroLoadError = null;

// llama.cpp state
let llamaProcess = null;
let llamaCurrentModel = null;
let llamaStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let llamaPort = parseInt(process.env.LLAMACPP_PORT || '8080', 10);
let llamaExecutable = process.env.LLAMACPP_EXECUTABLE || 'C:\\llama.cpp\\llama-server.exe';
let llamaModelsDir = process.env.LLAMACPP_MODELS_DIR || 'C:\\llama.cpp';
let llamaGpuLayers = process.env.LLAMACPP_GPU_LAYERS || '-1';
let llamaCtxSize = parseInt(process.env.LLAMACPP_CTX_SIZE || '32768', 10);

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
        if (process.env.ALLOWED_ORIGIN === 'electron-app') {
            callback(null, true);
            return;
        }
        if (!origin || origin === extensionOrigin) {
            callback(null, true);
        } else {
            console.warn(`CORS: Request from origin '${origin}' blocked. Expected '${extensionOrigin}'`);
            callback(new Error('Not allowed by CORS'));
        }
    }
};
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

// --- Server Management ---

let serverInstance = null;

app.post('/api/shutdown', (req, res) => {
    res.json({ status: 'shutting_down' });
    setTimeout(() => {
        if (llamaProcess) try { llamaProcess.kill(); } catch (e) {}
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

// --- LLMFit Hardware Recommendations ---

app.get('/api/llmfit/recommend', (req, res) => {
    const proc = spawn('llmfit', ['--json', 'fit']);
    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = () => { done = true; };

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    proc.on('error', err => {
        if (done || res.headersSent) return;
        finish();
        res.status(500).json({ error: `llmfit not found or failed to start: ${err.message}` });
    });

    proc.on('close', code => {
        if (done || res.headersSent) return;
        finish();
        if (code !== 0) {
            return res.status(500).json({ error: stderr.trim() || `llmfit exited with code ${code}` });
        }
        try {
            res.json(JSON.parse(stdout));
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse llmfit output' });
        }
    });

    setTimeout(() => {
        if (done || res.headersSent) return;
        finish();
        proc.kill();
        res.status(504).json({ error: 'llmfit timed out' });
    }, 30000);
});

// --- Exa Research Endpoint ---

app.post('/api/research', async (req, res) => {
    const { query } = req.body;
    if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid query parameter' });
    }

    try {
        console.log(`[Research] Received research request: "${query.slice(0, 100)}"`);
        const result = await fetchExaResearch(query);

        if (!result) {
            return res.status(503).json({ error: 'EXA_API_KEY not configured' });
        }

        res.json(result);
    } catch (err) {
        console.error('[Research] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- llama.cpp ---

async function waitForLlamaServer(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await fetch(`http://127.0.0.1:${llamaPort}/health`, {
                signal: AbortSignal.timeout(2000)
            });
            if (resp.ok) return true;
        } catch (e) { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

app.get('/api/llamacpp/status', (req, res) => {
    res.json({
        status: llamaStatus,
        model: llamaCurrentModel ? path.basename(llamaCurrentModel) : null,
        modelPath: llamaCurrentModel,
        port: llamaPort,
        executable: llamaExecutable,
        modelsDir: llamaModelsDir,
        gpuLayers: llamaGpuLayers,
        ctxSize: llamaCtxSize
    });
});

app.post('/api/llamacpp/config', (req, res) => {
    const { executable, modelsDir, gpuLayers, port, ctxSize } = req.body || {};
    if (executable) llamaExecutable = executable;
    if (modelsDir) llamaModelsDir = modelsDir;
    if (gpuLayers !== undefined && gpuLayers !== null) llamaGpuLayers = String(gpuLayers);
    if (port) llamaPort = parseInt(port, 10);
    if (ctxSize) llamaCtxSize = parseInt(ctxSize, 10);
    console.log(`[llama.cpp] Config updated: exe=${llamaExecutable}, dir=${llamaModelsDir}, gpu=${llamaGpuLayers}, port=${llamaPort}, ctx=${llamaCtxSize}`);
    res.json({ ok: true });
});

app.get('/api/llamacpp/models', (req, res) => {
    try {
        const dirs = llamaModelsDir.split(',').map(d => d.trim()).filter(Boolean);
        const models = [];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (file.toLowerCase().endsWith('.gguf')) {
                    const fullPath = path.join(dir, file);
                    try {
                        const stat = fs.statSync(fullPath);
                        models.push({ name: file, path: fullPath, size: stat.size });
                    } catch (e) { /* skip inaccessible files */ }
                }
            }
        }
        res.json({ models, currentModel: llamaCurrentModel, status: llamaStatus });
    } catch (err) {
        console.error('[llama.cpp] Error scanning models:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/llamacpp/load', async (req, res) => {
    const { modelPath } = req.body || {};
    if (!modelPath) return res.status(400).json({ error: 'modelPath required' });
    if (!fs.existsSync(modelPath)) return res.status(404).json({ error: `Model not found: ${modelPath}` });

    // Kill existing process
    if (llamaProcess) {
        console.log('[llama.cpp] Killing existing process...');
        try { llamaProcess.kill('SIGTERM'); } catch (e) {}
        await new Promise(r => setTimeout(r, 800));
        if (llamaProcess && !llamaProcess.killed) {
            try { llamaProcess.kill('SIGKILL'); } catch (e) {}
        }
        llamaProcess = null;
    }

    llamaStatus = 'loading';
    llamaCurrentModel = modelPath;

    const args = [
        '--model', modelPath,
        '--port', String(llamaPort),
        '--ctx-size', String(llamaCtxSize),
        '-ngl', llamaGpuLayers,
        '--host', '127.0.0.1'
    ];

    console.log(`[llama.cpp] Spawning: ${llamaExecutable} ${args.join(' ')}`);
    try {
        llamaProcess = spawn(llamaExecutable, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        llamaProcess.stdout.on('data', d => console.log('[llama.cpp]', d.toString().trimEnd()));
        llamaProcess.stderr.on('data', d => console.log('[llama.cpp]', d.toString().trimEnd()));

        llamaProcess.on('error', err => {
            console.error('[llama.cpp] Process error:', err.message);
            llamaStatus = 'error';
            llamaCurrentModel = null;
            llamaProcess = null;
        });

        llamaProcess.on('exit', (code, signal) => {
            console.log(`[llama.cpp] Process exited (code=${code}, signal=${signal})`);
            llamaProcess = null;
            if (llamaStatus === 'ready') llamaStatus = 'idle';
        });

        const ready = await waitForLlamaServer(60000);
        if (ready) {
            llamaStatus = 'ready';
            console.log(`[llama.cpp] Server ready on port ${llamaPort}`);
            res.json({ ok: true, model: path.basename(modelPath) });
        } else {
            llamaStatus = 'error';
            llamaCurrentModel = null;
            console.error('[llama.cpp] Server did not become ready in time');
            res.status(504).json({ error: 'llama-server did not start within 60 seconds' });
        }
    } catch (err) {
        llamaStatus = 'error';
        llamaCurrentModel = null;
        console.error('[llama.cpp] Spawn error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/llamacpp/stop', async (req, res) => {
    if (llamaProcess) {
        const proc = llamaProcess;
        llamaProcess = null;
        try { proc.kill('SIGTERM'); } catch (e) {}
        await new Promise(r => setTimeout(r, 800));
        if (!proc.killed) {
            try { proc.kill('SIGKILL'); } catch (e) {}
            // On Windows, force-kill by PID as a last resort
            if (proc.pid) {
                try {
                    spawn('taskkill', ['/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true });
                } catch (e) {}
            }
        }
    }
    llamaStatus = 'idle';
    llamaCurrentModel = null;
    res.json({ ok: true });
});

app.delete('/api/llamacpp/delete', (req, res) => {
    const { modelPath } = req.body || {};
    if (!modelPath) return res.status(400).json({ error: 'modelPath required' });
    if (!modelPath.toLowerCase().endsWith('.gguf')) return res.status(400).json({ error: 'Only .gguf files can be deleted' });

    const dirs = llamaModelsDir.split(',').map(d => path.resolve(d.trim())).filter(Boolean);
    const resolvedPath = path.resolve(modelPath);
    const inAllowedDir = dirs.some(d => resolvedPath.startsWith(d + path.sep) || resolvedPath === d);
    if (!inAllowedDir) return res.status(403).json({ error: 'Path not in configured models directory' });

    if (llamaCurrentModel && path.resolve(llamaCurrentModel) === resolvedPath) {
        return res.status(409).json({ error: 'Cannot delete the currently running model. Stop the server first.' });
    }

    try {
        fs.unlinkSync(resolvedPath);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/llamacpp/chat', async (req, res) => {
    if (llamaStatus !== 'ready') {
        return res.status(503).json({ error: `llama.cpp not ready (status: ${llamaStatus})` });
    }

    const { messages, options } = req.body || {};
    const opts = options || {};

    // Strip <think>...</think> blocks from assistant messages in conversation history.
    // Qwen3 and other reasoning models treat these as special template tokens; sending them
    // back in history confuses the model and causes it to generate only thinking on subsequent turns.
    const cleanedMessages = (messages || []).map(msg => {
        if (msg.role === 'assistant' && typeof msg.content === 'string') {
            const stripped = msg.content.replace(/<think>[\s\S]*?<\/think>\n*/gi, '').trim();
            return stripped === msg.content ? msg : { ...msg, content: stripped };
        }
        return msg;
    });

    // Web search / URL context injection — same logic as the Ollama proxy path
    const webSearchRequested = req.body?._webSearch === true;
    const deepResearchRequested = req.body?._deepResearch === true;
    let finalMessages = cleanedMessages;
    let llamaCppSourcesBlock = null;
    const lastUserMsg = cleanedMessages.filter(m => m.role === 'user').pop();
    if (lastUserMsg) {
        const messageContent = lastUserMsg.content || '';
        const contextParts = [];
        const today = new Date().toISOString().split('T')[0];

        // Track 1: fetch any URLs via Jina Reader
        const urls = extractUrls(messageContent);
        for (const url of urls.slice(0, 2)) {
            try {
                const content = await fetchPageViaJina(url);
                contextParts.push(`Retrieved page (${url}):\n${content}`);
                console.log(`[llama.cpp/Search] Jina: got ${content.length} chars from ${url}`);
            } catch (e) {
                console.warn(`[llama.cpp/Search] Jina failed for ${url}:`, e.message);
            }
        }

        // Track 2a: Deep research (Exa.ai)
        if (deepResearchRequested) {
            try {
                const data = await fetchExaResearch(messageContent.slice(0, 500));
                const formatted = formatExaResults(data);
                if (formatted) {
                    contextParts.push(`Deep Research Sources:\n\n${formatted}`);
                    llamaCppSourcesBlock = '\n\n---\n\n**Sources**\n' + data.results.map((r, i) => `- [${i + 1}] [${r.title || r.url}](${r.url})`).join('\n');
                    console.log(`[llama.cpp/Research] Exa: injected ${data.results.length} sources`);
                }
            } catch (e) {
                console.warn('[llama.cpp/Research] Exa failed, falling back to Tavily search:', e.message);
                try {
                    const data = await fetchTavilyResults(messageContent.slice(0, 300));
                    if (data?.results?.length > 0) {
                        contextParts.push(`Web search results:\n${data.results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.content}`).join('\n\n')}`);
                    }
                } catch (e2) { /* skip */ }
            }
        }
        // Track 2b: Regular Tavily search
        else if (webSearchRequested || heuristicNeedsSearch(messageContent)) {
            try {
                const query = messageContent.slice(0, 300);
                console.log(`[llama.cpp/Search] Querying Tavily for: "${query.slice(0, 80)}"`);
                const data = await fetchTavilyResults(query);
                if (data?.results?.length > 0) {
                    const snippets = data.results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.content}`).join('\n\n');
                    contextParts.push(`Web search results:\n${snippets}`);
                    console.log(`[llama.cpp/Search] Tavily: injected ${data.results.length} results`);
                }
            } catch (e) {
                console.warn('[llama.cpp/Search] Tavily failed:', e.message);
            }
        }

        if (contextParts.length > 0) {
            const preamble = deepResearchRequested
                ? `You are in Deep Research mode. The following sources were retrieved live via Exa semantic search specifically for this query. Your answer MUST be grounded in these sources — do not rely on training data alone. Synthesize the information across all sources and cite them inline using [1], [2], [3], etc. after each relevant sentence or claim. Do NOT add a sources list at the end — it will be appended automatically.\n\nToday's date: ${today}.`
                : `The following information was retrieved by a tool before this conversation. Use it to answer the user directly — do not say you cannot access the internet, as this data is already provided to you.\n\nToday's date: ${today}.`;
            const contextBlock = `${preamble}\n\n${contextParts.join('\n\n')}`;
            finalMessages = [...cleanedMessages];
            const sysIdx = finalMessages.findIndex(m => m.role === 'system');
            if (sysIdx >= 0) {
                finalMessages[sysIdx] = { ...finalMessages[sysIdx], content: contextBlock + '\n\n' + finalMessages[sysIdx].content };
            } else {
                finalMessages.unshift({ role: 'system', content: contextBlock });
            }
        }
    }

    const openaiBody = {
        model: 'local',
        messages: finalMessages,
        stream: true,
        stream_options: { include_usage: true } // request token counts in final chunk
    };
    if (opts.temperature != null) openaiBody.temperature = opts.temperature;
    if (opts.top_p != null) openaiBody.top_p = opts.top_p;
    if (opts.top_k != null) openaiBody.top_k = opts.top_k;
    if (opts.seed != null) openaiBody.seed = opts.seed;
    if (opts.num_predict != null) openaiBody.max_tokens = opts.num_predict;
    if (opts.repeat_penalty != null) openaiBody.repeat_penalty = opts.repeat_penalty;

    const reqStartTime = Date.now();
    let firstResponseMs = null; // wall-clock ms when first response (non-thinking) token arrives

    try {
        const upstream = await fetch(`http://127.0.0.1:${llamaPort}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(openaiBody),
            signal: AbortSignal.timeout(120000)
        });

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => '');
            return res.status(upstream.status).json({ error: errText });
        }

        res.setHeader('Content-Type', 'application/x-ndjson');
        const modelBaseName = path.basename(llamaCurrentModel || 'unknown');
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let usageData = null;
        let dbgThinkTokens = 0;
        let dbgContentTokens = 0;
        let dbgFinishReason = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    // Emit final done chunk with stats
                    const doneChunk = { model: modelBaseName, done: true };
                    if (usageData) {
                        doneChunk.eval_count = usageData.completion_tokens;
                        doneChunk.prompt_eval_count = usageData.prompt_tokens;
                        // eval_duration in nanoseconds, measured from first response token
                        if (firstResponseMs !== null) {
                            doneChunk.eval_duration = (Date.now() - firstResponseMs) * 1e6;
                        }
                    }
                    res.write(JSON.stringify(doneChunk) + '\n');
                    continue;
                }
                try {
                    const chunk = JSON.parse(data);

                    // Capture usage from any chunk that has it (stream_options puts it in the last data chunk)
                    if (chunk.usage) usageData = chunk.usage;

                    const choice = chunk.choices?.[0];
                    if (!choice) continue;

                    const rawContent = choice.delta?.content || '';
                    const reasoning = choice.delta?.reasoning_content ?? null;
                    const finishReason = choice.finish_reason;
                    const isDone = finishReason === 'stop' || finishReason === 'length';
                    const hitContextLimit = finishReason === 'length';
                    const hasActiveThinking = reasoning !== null && reasoning !== '';

                    if (reasoning) dbgThinkTokens++;
                    if (rawContent) dbgContentTokens++;
                    if (finishReason) dbgFinishReason = finishReason;

                    // Track when the first real response token (not thinking) arrives for timing
                    if (rawContent && !hasActiveThinking && firstResponseMs === null) {
                        firstResponseMs = Date.now();
                    }

                    // Use Ollama's native `thinking` field so the extension streams
                    // thinking tokens into the thinking box in real time, matching Ollama behaviour.
                    const msg = { role: 'assistant', content: rawContent };
                    if (hasActiveThinking) msg.thinking = reasoning;
                    if (hitContextLimit) msg.content += '\n\n⚠️ *Response cut off: context window full. Increase Context Size in Settings → ⚡ llama.cpp.*';

                    const out = { model: modelBaseName, message: msg, done: isDone };
                    res.write(JSON.stringify(out) + '\n');
                } catch (e) { /* skip malformed chunk */ }
            }
        }
        console.log(`[llama.cpp] Stream done — think_chunks=${dbgThinkTokens}, content_chunks=${dbgContentTokens}, finish_reason=${dbgFinishReason}`);
        if (llamaCppSourcesBlock) {
            const sourcesChunk = { model: llamaCurrentModel || '', message: { role: 'assistant', content: llamaCppSourcesBlock }, done: false };
            res.write(JSON.stringify(sourcesChunk) + '\n');
        }
        res.end();
    } catch (err) {
        console.error('[llama.cpp] Chat error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.end();
    }
});

// --- Agent Mode ---

// Agent config (updated via POST /api/agent/config)
let agentMaxSteps = parseInt(process.env.AGENT_MAX_STEPS || '15', 10);

// When AGENT_ALLOWED_DIRS is unset, default to the user's home directory as a safe boundary.
// File tools will only operate inside these directories unless explicitly expanded via env/config.
const _envAllowedDirs = (process.env.AGENT_ALLOWED_DIRS || '').split(',').map(s => s.trim()).filter(Boolean);
let agentAllowedDirs = _envAllowedDirs.length > 0 ? _envAllowedDirs : [os.homedir()];

// Paths that are always blocked regardless of config; cannot be removed via the API.
const ALWAYS_BLOCKED_PATHS = [
    'C:\\Windows\\System32',
    'C:\\Windows\\SysWOW64',
    path.join(os.homedir(), '.ssh'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Credentials'),
];
let agentBlockedPaths = Array.from(new Set([
    ...ALWAYS_BLOCKED_PATHS,
    ...(process.env.AGENT_BLOCKED_PATHS || '').split(',').map(s => s.trim()).filter(Boolean),
]));

// Per-tool permission levels: 'auto' | 'confirm' | 'disabled'
let agentToolPermissions = {
    webSearch: 'auto',
    fetchPage: 'auto',
    getDateTime: 'auto',
    math: 'auto',
    saveMemory: 'auto',
    readFile: 'auto',
    writeFile: 'confirm',
    listDirectory: 'auto',
    findFiles: 'auto',
    deleteFile: 'confirm',
    runCode: 'confirm',
    runShell: 'confirm',
    clipboardRead: 'confirm',
    clipboardWrite: 'confirm',
    readUrl: 'auto',
    diffFiles: 'auto',
    appendFile: 'confirm',
};

// Pending permission requests: id → { resolve, reject }
const pendingPermissions = new Map();

function generatePermissionId() {
    return Math.random().toString(36).slice(2, 10);
}

function isPathAllowed(targetPath) {
    let resolved;
    try { resolved = path.resolve(targetPath); } catch { return false; }
    const blocked = agentBlockedPaths;
    if (blocked.some(b => resolved.toLowerCase().startsWith(b.toLowerCase()))) return false;
    if (agentAllowedDirs.length === 0) return true;
    return agentAllowedDirs.some(a => resolved.toLowerCase().startsWith(path.resolve(a).toLowerCase()));
}

// Tier 1 tool definitions (for the model's tools array)
const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webSearch',
            description: 'Search the web for current information, news, or facts.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetchPage',
            description: 'Fetch and read the content of a web page by URL.',
            parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to fetch' } }, required: ['url'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'getDateTime',
            description: 'Get the current date and time.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'math',
            description: 'Evaluate a mathematical expression and return the result.',
            parameters: { type: 'object', properties: { expression: { type: 'string', description: 'Math expression to evaluate, e.g. "2 + 2" or "Math.sqrt(144)"' } }, required: ['expression'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'readFile',
            description: 'Read the contents of a file from disk.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' } }, required: ['path'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'writeFile',
            description: 'Write or overwrite a file on disk.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' }, content: { type: 'string', description: 'Content to write' } }, required: ['path', 'content'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'listDirectory',
            description: 'List files and folders in a directory. Returns names, counts, and a breakdown by file extension. Use for browsing a single directory.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the directory' } }, required: ['path'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'findFiles',
            description: 'Search for files matching a pattern, optionally recursively. Returns the total count and full paths. Use this whenever the user asks to count, find, or filter files by type (e.g. "how many images", "find all PDFs").',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory to search in (absolute Windows path)' },
                    pattern: { type: 'string', description: 'Comma-separated file extensions to match, e.g. ".jpg,.png,.gif" or "*" for all files' },
                    recursive: { type: 'boolean', description: 'Search subdirectories recursively (default: false)' }
                },
                required: ['path', 'pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'deleteFile',
            description: 'Delete a file from disk. This is irreversible.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file to delete' } }, required: ['path'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'runCode',
            description: 'Execute a code snippet. Supports "js" (Node.js vm sandbox) and "python" (subprocess).',
            parameters: { type: 'object', properties: { lang: { type: 'string', description: '"js" or "python"' }, code: { type: 'string', description: 'Code to execute' } }, required: ['lang', 'code'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'runShell',
            description: 'Run a shell command on the local machine. Use with caution.',
            parameters: { type: 'object', properties: { cmd: { type: 'string', description: 'Shell command to execute' } }, required: ['cmd'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'saveMemory',
            description: 'Save an important fact, preference, or piece of information to persistent memory so it can be recalled in future conversations. Use this when the user asks you to remember something, or when you learn something worth preserving.',
            parameters: { type: 'object', properties: { text: { type: 'string', description: 'The information to remember. Write it clearly in third person, e.g. "User prefers dark mode" or "User\'s project uses Python 3.11".' } }, required: ['text'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'clipboardRead',
            description: 'Read the current text contents of the system clipboard.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'clipboardWrite',
            description: 'Write text to the system clipboard, replacing its current contents.',
            parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to place on the clipboard' } }, required: ['text'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'readUrl',
            description: 'Fetch and read a URL, with full PDF support. For .pdf URLs or local PDF file paths, extracts the text content using pdf-parse. For regular web pages, uses the Jina reader for clean markdown output.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Full http/https URL or absolute local file path to a PDF' },
                    type: { type: 'string', description: 'Force parsing mode: "pdf" to treat as PDF, omit for auto-detection' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'diffFiles',
            description: 'Compare two files and return a unified diff showing exactly what changed. Use this when you need to explain, review, or apply differences between two file versions.',
            parameters: {
                type: 'object',
                properties: {
                    pathA: { type: 'string', description: 'Absolute path to the original (before) file' },
                    pathB: { type: 'string', description: 'Absolute path to the new (after) file' }
                },
                required: ['pathA', 'pathB']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'appendFile',
            description: 'Append text to the end of a file without overwriting its existing content. Safer than writeFile for logs, notes, or journals. Creates the file if it does not exist.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    content: { type: 'string', description: 'Text to append' }
                },
                required: ['path', 'content']
            }
        }
    },
];

// Returns tools filtered to those not disabled
function getEnabledTools() {
    return AGENT_TOOLS.filter(t => agentToolPermissions[t.function.name] !== 'disabled');
}

// Ask user permission via streaming — returns true if approved
// sessionPermissions: Map scoped to the current agent run (not global)
async function requestPermission(res, tool, args, risk, sessionPermissions) {
    const perm = agentToolPermissions[tool];
    if (perm === 'auto') return true;
    if (perm === 'disabled') return false;

    // Check session-level grants before prompting the user
    if (sessionPermissions.has(tool)) return true;
    if (args && args.path) {
        const dir = path.dirname(args.path);
        if (sessionPermissions.has(`${tool}:${dir}`)) return true;
    }

    // perm === 'confirm' — stream a permission card and wait
    const id = generatePermissionId();
    res.write(JSON.stringify({ type: 'permission_request', id, tool, args, risk }) + '\n');

    return new Promise((resolve) => {
        let keepaliveInterval;

        const cleanup = (approved) => {
            clearTimeout(timeout);
            clearInterval(keepaliveInterval);
            res.removeListener('close', onClose);
            pendingPermissions.delete(id);
            resolve(approved);
        };

        // Keepalive pings prevent the HTTP connection from timing out during long waits
        keepaliveInterval = setInterval(() => {
            if (!res.writableEnded) res.write(JSON.stringify({ type: 'keepalive' }) + '\n');
        }, 25000);

        const timeout = setTimeout(() => cleanup(false), 300000); // auto-deny after 5 min

        const onClose = () => cleanup(false); // client disconnected
        res.once('close', onClose);

        pendingPermissions.set(id, {
            resolve: (approved, scope) => {
                if (approved) {
                    if (scope === 'session') {
                        sessionPermissions.set(tool, true);
                    } else if (scope === 'path' && args && args.path) {
                        const dir = path.dirname(args.path);
                        sessionPermissions.set(`${tool}:${dir}`, true);
                    }
                }
                cleanup(approved);
            },
            reject: () => cleanup(false)
        });
    });
}

// Execute a single tool call, streaming progress/result
async function executeTool(res, name, args, sessionPermissions, model, backend) {
    try {
        switch (name) {
            case 'webSearch': {
                const result = await fetchTavilyResults(args.query || '');
                const text = result ? JSON.stringify(result).slice(0, 3000) : 'No results';
                return { result: text };
            }
            case 'fetchPage': {
                const text = await fetchPageViaJina(args.url || '', 8000);
                return { result: text || 'No content' };
            }
            case 'getDateTime': {
                return { result: new Date().toLocaleString() };
            }
            case 'math': {
                // Validate expression against a strict whitelist of safe math characters.
                // This prevents arbitrary code execution via the Function() constructor.
                // For a fully sandboxed evaluator, consider replacing with mathjs or expr-eval.
                const expr = String(args.expression || '');
                const SAFE_MATH_RE = /^[\d\s\+\-\*\/\%\(\)\.\^eMathsqrtabclogfloorilPIroundmaxin,]*$/;
                if (!SAFE_MATH_RE.test(expr)) {
                    return { result: 'Error: expression contains disallowed characters', error: true };
                }
                try {
                    // eslint-disable-next-line no-new-func
                    const val = Function('"use strict"; return (' + expr + ')')();
                    return { result: String(val) };
                } catch (e) {
                    return { result: 'Error: ' + e.message, error: true };
                }
            }
            case 'readFile': {
                const approved = await requestPermission(res, 'readFile', args, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.path)) return { result: 'Path not allowed', error: true };
                try {
                    const content = fs.readFileSync(args.path, 'utf8');
                    return { result: content.slice(0, 8000) };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'writeFile': {
                const approved = await requestPermission(res, 'writeFile', args, 'high', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.path)) return { result: 'Path not allowed', error: true };
                try {
                    fs.mkdirSync(path.dirname(args.path), { recursive: true });
                    fs.writeFileSync(args.path, args.content || '', 'utf8');
                    return { result: 'File written successfully' };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'listDirectory': {
                const approved = await requestPermission(res, 'listDirectory', args, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.path)) return { result: 'Path not allowed', error: true };
                try {
                    const entries = fs.readdirSync(args.path, { withFileTypes: true });
                    const dirs = entries.filter(e => e.isDirectory());
                    const files = entries.filter(e => !e.isDirectory());
                    // Count by extension
                    const extCounts = {};
                    for (const f of files) {
                        const ext = path.extname(f.name).toLowerCase() || '(no ext)';
                        extCounts[ext] = (extCounts[ext] || 0) + 1;
                    }
                    const extSummary = Object.entries(extCounts)
                        .sort((a, b) => b[1] - a[1])
                        .map(([ext, n]) => `${ext}: ${n}`)
                        .join(', ');
                    const lines = [
                        `Directory: ${args.path}`,
                        `Total: ${entries.length} items (${files.length} files, ${dirs.length} dirs)`,
                        extSummary ? `File types: ${extSummary}` : '',
                        '',
                        ...dirs.map(e => '[DIR] ' + e.name),
                        ...files.map(e => e.name),
                    ].filter(l => l !== undefined);
                    return { result: lines.join('\n') };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'findFiles': {
                const approved = await requestPermission(res, 'findFiles', args, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.path)) return { result: 'Path not allowed', error: true };
                try {
                    const exts = args.pattern === '*'
                        ? []
                        : String(args.pattern).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                    const recursive = !!args.recursive;
                    const found = [];
                    function walk(dir, depth) {
                        if (depth > (recursive ? 20 : 0)) return;
                        let entries;
                        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                        for (const e of entries) {
                            const full = path.join(dir, e.name);
                            if (e.isDirectory() && recursive) { walk(full, depth + 1); }
                            else if (e.isFile()) {
                                const ext = path.extname(e.name).toLowerCase();
                                if (exts.length === 0 || exts.includes(ext)) found.push(full);
                            }
                        }
                    }
                    walk(args.path, 0);
                    const preview = found.slice(0, 50).join('\n');
                    const more = found.length > 50 ? `\n... and ${found.length - 50} more` : '';
                    return { result: `Found ${found.length} file(s) matching "${args.pattern}" in ${args.path}${recursive ? ' (recursive)' : ''}:\n${preview}${more}` };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'deleteFile': {
                const approved = await requestPermission(res, 'deleteFile', args, 'high', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.path)) return { result: 'Path not allowed', error: true };
                try {
                    fs.unlinkSync(args.path);
                    return { result: 'File deleted: ' + args.path };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'runCode': {
                const approved = await requestPermission(res, 'runCode', { lang: args.lang, code: args.code }, 'high', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                res.write(JSON.stringify({ type: 'tool_running', name: 'runCode', preview: `${args.lang}:\n${args.code}` }) + '\n');
                return await runCodeTool(args.lang, args.code);
            }
            case 'runShell': {
                // runShell respects agentToolPermissions (default: 'disabled').
                // When enabled, permission level 'confirm' is strongly recommended.
                const approved = await requestPermission(res, 'runShell', { cmd: args.cmd }, 'critical', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                res.write(JSON.stringify({ type: 'tool_running', name: 'runShell', preview: args.cmd }) + '\n');
                return await runShellTool(args.cmd);
            }
            case 'saveMemory': {
                const text = String(args.text || '').trim();
                if (!text) return { result: 'Nothing to save — text was empty.', error: true };
                try {
                    const id = await memory.addMemory(text, { source: 'agent' });
                    console.log(`[Memory] Agent saved: "${text.slice(0, 80)}" (id: ${id})`);
                    return { result: `Saved to memory: "${text}"` };
                } catch (err) {
                    return { result: `Memory save failed: ${err.message}`, error: true };
                }
            }
            case 'clipboardRead': {
                const approved = await requestPermission(res, 'clipboardRead', args, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                return new Promise((resolve) => {
                    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'], { timeout: 10000 });
                    let out = '', err = '';
                    proc.stdout.on('data', d => { out += d; });
                    proc.stderr.on('data', d => { err += d; });
                    proc.on('close', (code) => {
                        if (code !== 0) resolve({ result: 'Error reading clipboard: ' + err.trim(), error: true });
                        else resolve({ result: out.trim() || '(clipboard is empty)' });
                    });
                    proc.on('error', e => resolve({ result: 'Error: ' + e.message, error: true }));
                });
            }
            case 'clipboardWrite': {
                const text = String(args.text || '');
                const preview = text.slice(0, 80) + (text.length > 80 ? '…' : '');
                const approved = await requestPermission(res, 'clipboardWrite', { text: preview }, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                return new Promise((resolve) => {
                    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'], { timeout: 10000 });
                    let err = '';
                    proc.stderr.on('data', d => { err += d; });
                    proc.on('close', (code) => {
                        if (code !== 0) resolve({ result: 'Error writing clipboard: ' + err.trim(), error: true });
                        else resolve({ result: 'Clipboard updated.' });
                    });
                    proc.on('error', e => resolve({ result: 'Error: ' + e.message, error: true }));
                    proc.stdin.write(text);
                    proc.stdin.end();
                });
            }
            case 'readUrl': {
                const url = args.url || '';
                const isHttpUrl = /^https?:\/\//i.test(url);
                const isPdf = /\.pdf(\?.*)?$/i.test(url) || args.type === 'pdf';
                if (isPdf) {
                    let pdfParse;
                    try { pdfParse = require('pdf-parse'); } catch {
                        return { result: 'pdf-parse is not installed. Run: npm install pdf-parse in proxy_server/', error: true };
                    }
                    try {
                        let buffer;
                        if (isHttpUrl) {
                            buffer = await fetchBinaryUrl(url);
                        } else {
                            if (!isPathAllowed(url)) return { result: 'Path not allowed', error: true };
                            buffer = fs.readFileSync(url);
                        }
                        const data = await pdfParse(buffer, { max: 20 });
                        const meta = data.numpages ? `Pages: ${data.numpages}\n\n` : '';
                        return { result: (meta + data.text).slice(0, 8000) || '(no text extracted)' };
                    } catch (e) { return { result: 'Error reading PDF: ' + e.message, error: true }; }
                } else {
                    const text = await fetchPageViaJina(url, 8000);
                    return { result: text || 'No content' };
                }
            }
            case 'diffFiles': {
                const approved = await requestPermission(res, 'diffFiles', args, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.pathA) || !isPathAllowed(args.pathB)) return { result: 'Path not allowed', error: true };
                try {
                    const a = fs.readFileSync(args.pathA, 'utf8');
                    const b = fs.readFileSync(args.pathB, 'utf8');
                    const patch = diffLib.createTwoFilesPatch(args.pathA, args.pathB, a, b);
                    return { result: patch.slice(0, 8000) };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'appendFile': {
                const approved = await requestPermission(res, 'appendFile', args, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(args.path)) return { result: 'Path not allowed', error: true };
                try {
                    fs.mkdirSync(path.dirname(args.path), { recursive: true });
                    fs.appendFileSync(args.path, args.content || '', 'utf8');
                    return { result: 'Appended to: ' + args.path };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            default:
                return { result: `Unknown tool: ${name}`, error: true };
        }
    } catch (err) {
        return { result: 'Unexpected error: ' + err.message, error: true };
    }
}

// WARNING: runCodeTool uses Node's built-in `vm` module for JS sandboxing.
// Node's vm module is NOT a secure sandbox — determined attackers can escape it.
// Only enable the runCode tool (via agentToolPermissions) in trusted, controlled
// environments. For production use, replace vm-based execution with a hardened
// alternative such as a separate restricted child process, a containerised worker,
// or an external isolated service (e.g., a Docker-based code runner).
async function runCodeTool(lang, code) {
    if (lang === 'js') {
        try {
            const vm = require('vm');
            const logs = [];
            // Note: vm.createContext / vm.runInContext is not a secure sandbox.
            // See warning above before enabling this tool in production.
            const sandbox = { console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('[err] ' + a.join(' ')) }, Math, JSON, parseFloat, parseInt, isNaN, isFinite };
            vm.createContext(sandbox);
            vm.runInContext(code, sandbox, { timeout: 10000 });
            return { result: logs.join('\n') || '(no output)' };
        } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
    } else if (lang === 'python') {
        return new Promise((resolve) => {
            let out = '', err = '';
            const proc = spawn('python', ['-c', code], { timeout: 30000 });
            proc.stdout.on('data', d => { out += d; });
            proc.stderr.on('data', d => { err += d; });
            proc.on('close', () => resolve({ result: (out + err).slice(0, 4000) || '(no output)' }));
            proc.on('error', e => resolve({ result: 'Error: ' + e.message, error: true }));
        });
    }
    return { result: 'Unsupported language: ' + lang, error: true };
}

async function runShellTool(cmd) {
    return new Promise((resolve) => {
        let out = '', err = '';
        const proc = spawn(cmd, { shell: true, timeout: 30000 });
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { err += d; });
        proc.on('close', () => resolve({ result: (out + err).slice(0, 4000) || '(no output)' }));
        proc.on('error', e => resolve({ result: 'Error: ' + e.message, error: true }));
    });
}

// --- Context compression helpers ---

// Rough token estimate: ~3.5 chars per token (sufficient for threshold detection)
function estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) {
        if (typeof m.content === 'string') chars += m.content.length;
        else if (m.content) chars += JSON.stringify(m.content).length;
        if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / 3.5);
}

// Cache context limits so we don't re-fetch /api/show on every step
const modelContextLimitCache = new Map();
async function getModelContextLimit(model) {
    if (modelContextLimitCache.has(model)) return modelContextLimitCache.get(model);
    try {
        const body = JSON.stringify({ model });
        const info = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: 'localhost', port: 11434, path: '/api/show', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (r) => {
                let raw = '';
                r.on('data', d => raw += d);
                r.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Bad response')); } });
                r.on('error', reject);
            });
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        // Ollama 0.1.40+ exposes llama.context_length in model_info; fall back to num_ctx param
        const limit =
            info.model_info?.['llama.context_length'] ||
            parseInt((info.parameters || '').match(/num_ctx\s+(\d+)/)?.[1] || '0', 10) ||
            32768;
        modelContextLimitCache.set(model, limit);
        return limit;
    } catch {
        return 32768;
    }
}

// Non-streaming Ollama call — returns text or throws
async function callOllamaSync(model, userPrompt, timeoutMs = 30000) {
    const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: userPrompt }],
        stream: false,
        options: { temperature: 0 }
    });
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (r) => {
            let raw = '';
            r.on('data', d => raw += d);
            r.on('end', () => {
                try { resolve(JSON.parse(raw).message?.content || ''); }
                catch { reject(new Error('Bad Ollama response')); }
            });
            r.on('error', reject);
        });
        const timer = setTimeout(() => { req.destroy(); reject(new Error('Sync call timed out')); }, timeoutMs);
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.write(body);
        req.end();
    });
}

// Non-streaming llama.cpp call — returns text or throws
async function callLlamaCppSync(userPrompt, timeoutMs = 30000) {
    const body = JSON.stringify({
        messages: [{ role: 'user', content: userPrompt }],
        stream: false,
        temperature: 0
    });
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port: llamaPort, path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (r) => {
            let raw = '';
            r.on('data', d => raw += d);
            r.on('end', () => {
                try { resolve(JSON.parse(raw).choices?.[0]?.message?.content || ''); }
                catch { reject(new Error('Bad llama.cpp response')); }
            });
            r.on('error', reject);
        });
        const timer = setTimeout(() => { req.destroy(); reject(new Error('Sync call timed out')); }, timeoutMs);
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.write(body);
        req.end();
    });
}

// Unified sync call — dispatches to the active backend
async function callModelSync(model, backend, userPrompt, timeoutMs = 30000) {
    if (backend === 'llamacpp') return callLlamaCppSync(userPrompt, timeoutMs);
    return callOllamaSync(model || 'llama3.2', userPrompt, timeoutMs);
}

const AGENT_TOOL_CALL_TIMEOUT_MS = 120000; // 2 min timeout for backend tool calls (large contexts need more time)

// Call Ollama with tools, collect full response (streaming internally, return complete message)
async function callOllamaWithTools(messages, tools, model) {
    const body = JSON.stringify({ model, messages, tools, stream: false });
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res2) => {
            clearTimeout(timer);
            let raw = '';
            res2.on('data', d => { raw += d; });
            res2.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch { reject(new Error('Bad Ollama response')); }
            });
            res2.on('error', reject);
        });
        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('Ollama tool call timed out after 30s'));
        }, AGENT_TOOL_CALL_TIMEOUT_MS);
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.write(body);
        req.end();
    });
}

// Call llama.cpp with tools (OpenAI format), return response object
async function callLlamaCppWithTools(messages, tools, model) {
    // Convert messages to OpenAI format (tool results use role:'tool')
    const oaiMessages = messages.map(m => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id || 'call_0', content: m.content };
        return { role: m.role, content: m.content };
    });
    const body = JSON.stringify({ model, messages: oaiMessages, tools, stream: false });
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port: llamaPort, path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res2) => {
            clearTimeout(timer);
            let raw = '';
            res2.on('data', d => { raw += d; });
            res2.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch { reject(new Error('Bad llama.cpp response')); }
            });
            res2.on('error', reject);
        });
        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('llama.cpp tool call timed out after 30s'));
        }, AGENT_TOOL_CALL_TIMEOUT_MS);
        req.on('error', (err) => { clearTimeout(timer); reject(err); });
        req.write(body);
        req.end();
    });
}

// Extract tool_calls from Ollama or llama.cpp response, normalize to [{id, name, args}]
function extractToolCalls(response, backend) {
    if (backend === 'llamacpp') {
        const choice = response.choices && response.choices[0];
        if (!choice) return null;
        const tcs = choice.message && choice.message.tool_calls;
        if (!tcs || tcs.length === 0) return null;
        return tcs.map(tc => ({
            id: tc.id || 'call_0',
            name: tc.function.name,
            args: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })()
        }));
    } else {
        // Ollama
        const msg = response.message;
        if (!msg || !msg.tool_calls || msg.tool_calls.length === 0) return null;
        return msg.tool_calls.map((tc, i) => ({
            id: 'call_' + i,
            name: tc.function.name,
            args: tc.function.arguments || {}
        }));
    }
}

// Extract final text content from a model response
function extractContent(response, backend) {
    if (backend === 'llamacpp') {
        return (response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content) || '';
    }
    return (response.message && response.message.content) || '';
}

// POST /api/agent/permission — resolve a pending permission request
// scope: 'once' (default) | 'session' (blanket for this tool) | 'path' (same directory)
app.post('/api/agent/permission', (req, res) => {
    const { id, approved, scope = 'once' } = req.body || {};
    const pending = pendingPermissions.get(id);
    if (!pending) return res.status(404).json({ error: 'No pending permission with that id' });
    pending.resolve(!!approved, scope);
    res.json({ ok: true });
});

// GET /api/agent/config — return current agent config
app.get('/api/agent/config', (req, res) => {
    res.json({ maxSteps: agentMaxSteps, allowedDirs: agentAllowedDirs, blockedPaths: agentBlockedPaths, toolPermissions: agentToolPermissions });
});

// POST /api/agent/config — update agent config
app.post('/api/agent/config', (req, res) => {
    const { maxSteps, allowedDirs, blockedPaths, toolPermissions } = req.body || {};
    if (maxSteps !== undefined) agentMaxSteps = Math.max(1, Math.min(50, parseInt(maxSteps, 10) || 15));
    if (Array.isArray(allowedDirs)) {
        const validated = allowedDirs.map(s => String(s).trim()).filter(Boolean);
        agentAllowedDirs = validated.length > 0 ? validated : [os.homedir()];
    }
    if (Array.isArray(blockedPaths)) {
        // Always merge with ALWAYS_BLOCKED_PATHS — they cannot be removed via API
        const incoming = blockedPaths.map(s => String(s).trim()).filter(Boolean);
        agentBlockedPaths = Array.from(new Set([...ALWAYS_BLOCKED_PATHS, ...incoming]));
    }
    if (toolPermissions && typeof toolPermissions === 'object') {
        for (const [k, v] of Object.entries(toolPermissions)) {
            if (agentToolPermissions.hasOwnProperty(k) && ['auto', 'confirm', 'disabled'].includes(v)) {
                agentToolPermissions[k] = v;
            }
        }
    }
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

// POST /api/agent/chat — main agent loop endpoint
app.post('/api/agent/chat', async (req, res) => {
    const { messages: initialMessages, model, backend = 'ollama', maxSteps, continueFrom } = req.body || {};
    const steps = Math.max(1, Math.min(50, parseInt(maxSteps, 10) || agentMaxSteps));
    const tools = getEnabledTools();
    // Session-scoped permission grants — cleared when this request ends (not global)
    const sessionPermissions = new Map();

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    // Use continueFrom if resuming; directive is already embedded in those messages
    const messages = continueFrom ? [...continueFrom] : [...(initialMessages || [])];

    if (!continueFrom) {
        // Inject agent directive so the model knows to call tools instead of refusing
        const _platform = os.platform();
        const _isWin = _platform === 'win32';
        const _pathSep = path.sep;
        const _examplePath = _isWin
            ? `C:\\Users\\${path.basename(os.homedir())}\\Documents\\file.txt`
            : `${os.homedir()}/documents/file.txt`;
        const _pathGuidance = _isWin
            ? `Always use Windows-style absolute paths (e.g. ${_examplePath}), never Unix-style paths (e.g. /home/user/file).`
            : `Always use Unix-style absolute paths (e.g. ${_examplePath}), never Windows-style paths (e.g. C:\\Users\\...).`;
        const AGENT_DIRECTIVE = 'You are operating in AGENT MODE with real, functional tools available. ' +
            'When the user asks you to do something that requires a tool (read a file, search the web, run code, etc.), ' +
            'ALWAYS call the appropriate tool — never say you cannot access the internet or file system. ' +
            'The tools are real. Use them.\n' +
            `SYSTEM INFORMATION: OS=${_platform}, home directory="${os.homedir()}", path separator="${_pathSep}". ` +
            _pathGuidance + '\n' +
            'TOOL GUIDANCE: To count or find files by type use findFiles (e.g. pattern=".jpg,.png" for images). ' +
            'Do NOT count lines from listDirectory output manually — call findFiles instead. ' +
            'Use runCode only when you need to process data that no other tool can return directly.';
        const sysIdx = messages.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
            messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + '\n\n' + AGENT_DIRECTIVE };
        } else {
            messages.unshift({ role: 'system', content: AGENT_DIRECTIVE });
        }
    }

    try {
        // Abort the loop immediately if the client disconnects
        let clientGone = false;
        res.once('close', () => { clientGone = true; });

        for (let step = 1; step <= steps; step++) {
            if (clientGone || res.destroyed || res.writableEnded) break;

            // Call model — heartbeat keeps the SSE connection alive during long inference
            let response;
            const heartbeat = setInterval(() => {
                if (!res.writableEnded) res.write(JSON.stringify({ type: 'heartbeat' }) + '\n');
            }, 15000);
            try {
                if (backend === 'llamacpp') {
                    response = await callLlamaCppWithTools(messages, tools, model || 'default');
                } else {
                    response = await callOllamaWithTools(messages, tools, model || 'llama3.2');
                }
            } catch (err) {
                clearInterval(heartbeat);
                res.write(JSON.stringify({ type: 'error', text: 'Model call failed: ' + err.message }) + '\n');
                break;
            }
            clearInterval(heartbeat);

            const toolCalls = extractToolCalls(response, backend);
            const content = extractContent(response, backend);

            // Stream any text content from this step
            if (content && content.trim()) {
                res.write(JSON.stringify({ type: 'content', text: content }) + '\n');
            }

            // If no tool calls, we're done
            if (!toolCalls || toolCalls.length === 0) {
                res.write(JSON.stringify({ type: 'step_done', step, maxSteps: steps }) + '\n');
                break;
            }

            // Stream all tool_call events upfront, then dispatch all tools in parallel
            for (const tc of toolCalls) {
                res.write(JSON.stringify({ type: 'tool_call', name: tc.name, args: tc.args }) + '\n');
            }

            const execResults = await Promise.all(
                toolCalls.map(async tc => {
                    const { result, error } = await executeTool(res, tc.name, tc.args, sessionPermissions, model, backend);
                    res.write(JSON.stringify({ type: 'tool_result', name: tc.name, result, error: !!error }) + '\n');
                    return { tc, result, error };
                })
            );

            // Append one assistant turn with all tool_calls, then one tool result per call
            if (backend === 'llamacpp') {
                messages.push({
                    role: 'assistant',
                    content: '',
                    tool_calls: execResults.map(({ tc }) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }))
                });
                for (const { tc, result } of execResults) {
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
                }
            } else {
                // Ollama format
                messages.push({
                    role: 'assistant',
                    content: '',
                    tool_calls: execResults.map(({ tc }) => ({ function: { name: tc.name, arguments: tc.args } }))
                });
                for (const { result } of execResults) {
                    messages.push({ role: 'tool', content: String(result) });
                }
            }

            // --- Rolling context compression ---
            // Estimate tokens and compress middle steps when approaching context limit
            const tokenEstimate = estimateTokens(messages);
            const ctxLimit = backend === 'llamacpp'
                ? llamaCtxSize
                : await getModelContextLimit(model || 'llama3.2').catch(() => 32768);
            const compressionThreshold = Math.floor(ctxLimit * 0.65);

            if (tokenEstimate > compressionThreshold) {
                // Keep first 3 messages (system + user + earliest response) and last 6 (~3 steps)
                const KEEP_HEAD = 3;
                const KEEP_TAIL = 6;
                const middleStart = KEEP_HEAD;
                const middleEnd = Math.max(KEEP_HEAD, messages.length - KEEP_TAIL);
                const middle = messages.slice(middleStart, middleEnd);

                if (middle.length >= 2) {
                    try {
                        const workLog = middle.map(m => {
                            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
                            const calls = m.tool_calls
                                ? ' [called: ' + m.tool_calls.map(tc => tc.function?.name || tc.name || '?').join(', ') + ']'
                                : '';
                            return `[${m.role}${calls}]: ${content.slice(0, 600)}`;
                        }).join('\n---\n');

                        const summary = await callModelSync(
                            model || 'llama3.2', backend,
                            'Summarize the following agent work log. List: goals pursued, tools called, key findings, files read/written, current status, and any errors. Be concise but preserve all specific values (file paths, counts, errors):\n\n' + workLog,
                            30000
                        );

                        if (summary && summary.trim()) {
                            const summaryMsg = {
                                role: 'assistant',
                                content: `[Progress summary — ${middle.length} messages compressed]\n${summary.trim()}`
                            };
                            messages.splice(middleStart, middle.length, summaryMsg);
                            const tokensAfter = estimateTokens(messages);
                            console.log(`[Agent] Context compressed at step ${step}: ~${tokenEstimate} → ~${tokensAfter} tokens`);
                            res.write(JSON.stringify({ type: 'context_compressed', step, tokensBefore: tokenEstimate, tokensAfter }) + '\n');
                        }
                    } catch (err) {
                        console.warn('[Agent] Mid-run compression failed:', err.message);
                    }
                }
            }

            if (clientGone || res.destroyed || res.writableEnded) break;

            res.write(JSON.stringify({ type: 'step_done', step, maxSteps: steps }) + '\n');

            if (step === steps) {
                res.write(JSON.stringify({ type: 'content', text: '\n\n*Agent reached maximum steps.*' }) + '\n');
                res.write(JSON.stringify({ type: 'max_steps_reached', messages: [...messages] }) + '\n');
            }
        }
    } catch (err) {
        console.error('[Agent] Error:', err);
        if (!res.writableEnded) res.write(JSON.stringify({ type: 'error', text: err.message }) + '\n');
    }

    res.write(JSON.stringify({ type: 'done' }) + '\n');
    res.end();
});

// --- Ollama Proxy ---

app.all('/proxy/*', async (req, res) => {
    const originalPath = req.params[0];
    const ollamaPath = '/' + originalPath;
    const targetUrlString = OLLAMA_API_BASE_URL + ollamaPath;
    const ALLOWED_OLLAMA_PATHS = ['/api/tags', '/api/chat', '/api/generate', '/api/show', '/api/pull', '/api/delete'];

    console.log(`Proxying request: ${req.method} ${req.originalUrl} -> ${targetUrlString}`);

    if (!ALLOWED_OLLAMA_PATHS.some(allowedPath => ollamaPath.startsWith(allowedPath))) {
        console.warn(`Forbidden: Path '${ollamaPath}' not allowed.`);
        return res.status(403).send('Forbidden: Path not allowed.');
    }

    try {
        const targetUrl = new URL(targetUrlString);

        if (targetUrl.hostname !== 'localhost' && targetUrl.hostname !== '127.0.0.1') {
            console.warn(`Forbidden: Host '${targetUrl.hostname}' not allowed.`);
            return res.status(403).send('Forbidden: Host not allowed.');
        }

        // Construct headers for the outgoing request to Ollama
        const ollamaRequestHeaders = {
            'host': targetUrl.hostname, // Essential: Must match the target
            'accept': req.headers['accept'] || '*/*', // Pass through accept or default
            'user-agent': req.headers['user-agent'] || 'OllamaBroProxy/1.0', // Pass through user-agent or set a custom one
            // We will set Content-Type and Content-Length specifically when sending the body
        };

        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: ollamaRequestHeaders, // Use our more controlled set of headers
        };

        // Set by deep research path to append a sources block after the model response
        let exaSourcesBlock = null;

        const proxyReq = http.request(options, (proxyRes) => {
            console.log(`Proxy to Ollama: Received response status: ${proxyRes.statusCode}`);
            console.log('Proxy to Ollama: Received response headers:', JSON.stringify(proxyRes.headers, null, 2));
            res.writeHead(proxyRes.statusCode, proxyRes.headers);

            if (!exaSourcesBlock) {
                proxyRes.pipe(res, { end: true });
            } else {
                // Intercept stream to inject sources block before the final done chunk
                let lineBuffer = '';
                proxyRes.on('data', chunk => {
                    lineBuffer += chunk.toString();
                    const lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop();
                    for (const line of lines) {
                        if (!line.trim()) { res.write('\n'); continue; }
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.done === true) {
                                const sourcesChunk = { model: parsed.model || '', created_at: new Date().toISOString(), message: { role: 'assistant', content: exaSourcesBlock }, done: false };
                                res.write(JSON.stringify(sourcesChunk) + '\n');
                            }
                        } catch (e) { /* not JSON, forward as-is */ }
                        res.write(line + '\n');
                    }
                });
                proxyRes.on('end', () => {
                    if (lineBuffer.trim()) {
                        try {
                            const parsed = JSON.parse(lineBuffer);
                            if (parsed.done === true) {
                                const sourcesChunk = { model: parsed.model || '', created_at: new Date().toISOString(), message: { role: 'assistant', content: exaSourcesBlock }, done: false };
                                res.write(JSON.stringify(sourcesChunk) + '\n');
                            }
                        } catch (e) { /* not JSON */ }
                        res.write(lineBuffer + '\n');
                    }
                    console.log('Proxy to Ollama: Response stream from Ollama ended.');
                    res.end();
                });
            }
            proxyRes.on('error', (err) => console.error('Proxy to Ollama: Error on response stream from Ollama:', err));
        });

        // Pull requests can take many minutes; cloud models route through external APIs so also need more headroom
        const reqModelName = req.body?.model || '';
        const isCloudModelReq = reqModelName.includes(':cloud') || reqModelName.includes('.cloud');
        const OLLAMA_REQUEST_TIMEOUT = ollamaPath.startsWith('/api/pull') ? 1800000
            : isCloudModelReq ? 300000  // 5 min for cloud models (they call external APIs)
            : 60000;
        proxyReq.setTimeout(OLLAMA_REQUEST_TIMEOUT, () => {
            console.error(`Proxy to Ollama: Request timed out after ${OLLAMA_REQUEST_TIMEOUT / 1000}s. Aborting.`);
            proxyReq.abort();
            if (!res.headersSent) res.status(504).send('Gateway Timeout: Ollama did not respond.');
        });

        proxyReq.on('error', (err) => {
            console.error('Proxy to Ollama: Request error:', err);
            if (!res.headersSent) res.status(502).send('Bad Gateway: Proxy request to Ollama failed.');
        });

        proxyReq.on('socket', (socket) => {
            console.log('Proxy to Ollama: Socket assigned.');
            socket.on('connect', () => console.log('Proxy to Ollama: Socket connected.'));
            socket.on('timeout', () => console.error('Proxy to Ollama: Socket timeout event.'));
        });

        if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') && req.rawBody) {
            let bodyToSend = req.rawBody;
            let contentType = req.headers['content-type'] || 'application/json';

            // Check if the request is for the chat API and is JSON
            if (ollamaPath.startsWith('/api/chat') && contentType === 'application/json') {
                try {
                    const ollamaPayload = JSON.parse(req.rawBody);

                    // Ensure streaming: true for /api/chat
                    // Ollama defaults to streaming if 'stream' is not present or true.
                    if (ollamaPayload.hasOwnProperty('stream') && ollamaPayload.stream === false) {
                        ollamaPayload.stream = true;
                        console.log('Proxy to Ollama: Modified payload for /api/chat to ensure streaming (changed stream:false to stream:true).');
                    } else if (!ollamaPayload.hasOwnProperty('stream')) {
                        ollamaPayload.stream = true;
                        console.log('Proxy to Ollama: Modified payload for /api/chat to ensure streaming (added stream:true).');
                    }
                    // If ollamaPayload.stream is already true, no changes needed to the stream property.

                    // --- Web search context injection ---
                    const lastMsg = ollamaPayload.messages?.at(-1);

                    if (lastMsg?.role === 'user') {
                        const messageContent = lastMsg.content || '';
                        const webSearchRequested = ollamaPayload._webSearch === true;
                        const deepResearchRequested = ollamaPayload._deepResearch === true;
                        const contextParts = [];
                        const today = new Date().toISOString().split('T')[0];

                        // Track 1: fetch any URLs in the message via Jina Reader (live page content)
                        const urls = extractUrls(messageContent);
                        console.log(`[Search] URLs found in message: ${JSON.stringify(urls)}`);
                        for (const url of urls.slice(0, 2)) {
                            try {
                                console.log(`[Search] Fetching URL via Jina: ${url}`);
                                const content = await fetchPageViaJina(url);
                                contextParts.push(`Retrieved page (${url}):\n${content}`);
                                console.log(`[Search] Jina: got ${content.length} chars from ${url}`);
                            } catch (jinaErr) {
                                console.warn(`[Search] Jina failed for ${url}:`, jinaErr.message);
                            }
                        }

                        // Track 2a: Deep Research (Exa.ai) - takes priority
                        if (deepResearchRequested) {
                            try {
                                const query = messageContent.slice(0, 500);
                                console.log(`[Research] Starting deep research via Exa for: "${query.slice(0, 80)}"`);
                                const data = await fetchExaResearch(query);
                                const formatted = formatExaResults(data);
                                if (formatted) {
                                    contextParts.push(`Deep Research Sources:\n\n${formatted}`);
                                    exaSourcesBlock = '\n\n---\n\n**Sources**\n' + data.results.map((r, i) => `- [${i + 1}] [${r.title || r.url}](${r.url})`).join('\n');
                                    console.log(`[Research] Exa: injected ${data.results.length} sources`);
                                }
                            } catch (researchErr) {
                                console.warn('[Research] Exa failed, falling back to Tavily search:', researchErr.message);
                                try {
                                    const query = messageContent.slice(0, 300);
                                    const data = await fetchTavilyResults(query);
                                    if (data?.results?.length > 0) {
                                        const snippets = data.results
                                            .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.content}`)
                                            .join('\n\n');
                                        contextParts.push(`Web search results:\n${snippets}`);
                                        console.log(`[Search] Tavily fallback: injected ${data.results.length} results`);
                                    }
                                } catch (searchErr) {
                                    console.warn('[Search] Fallback search also failed:', searchErr.message);
                                }
                            }
                        }
                        // Track 2b: Regular Tavily search (if not deep research)
                        else if (webSearchRequested || heuristicNeedsSearch(messageContent)) {
                            try {
                                const query = messageContent.slice(0, 300);
                                console.log(`[Search] Querying Tavily for: "${query.slice(0, 80)}"`);
                                const data = await fetchTavilyResults(query);
                                if (data?.results?.length > 0) {
                                    const snippets = data.results
                                        .map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.content}`)
                                        .join('\n\n');
                                    contextParts.push(`Web search results:\n${snippets}`);
                                    console.log(`[Search] Tavily: injected ${data.results.length} results`);
                                }
                            } catch (searchErr) {
                                console.warn('[Search] Tavily failed, continuing without search context:', searchErr.message);
                            }
                        }

                        // Inject all gathered context into the system message
                        if (contextParts.length > 0) {
                            const preamble = deepResearchRequested
                                ? `You are in Deep Research mode. The following sources were retrieved live via Exa semantic search specifically for this query. Your answer MUST be grounded in these sources — do not rely on training data alone. Synthesize the information across all sources and cite them inline using [1], [2], [3], etc. after each relevant sentence or claim. Do NOT add a sources list at the end — it will be appended automatically.\n\nToday's date: ${today}.`
                                : `The following information was retrieved by a tool before this conversation. Use it to answer the user directly — do not say you cannot access the internet, as this data is already provided to you.\n\nToday's date: ${today}.`;
                            const contextBlock = `${preamble}\n\n${contextParts.join('\n\n')}`;
                            const sysIdx = ollamaPayload.messages.findIndex(m => m.role === 'system');
                            if (sysIdx >= 0) {
                                ollamaPayload.messages[sysIdx].content = contextBlock + '\n\n' + ollamaPayload.messages[sysIdx].content;
                            } else {
                                ollamaPayload.messages.unshift({ role: 'system', content: contextBlock });
                            }
                        }
                    }
                    // --- Memory context injection ---
                    if (ollamaPayload._memory === true && lastMsg?.role === 'user') {
                        try {
                            const query = (lastMsg.content || '').slice(0, 500);
                            const hits = await memory.searchMemories(query, 4);
                            const parts = [];
                            parts.push('You have a persistent memory system. When the user asks you to remember something, acknowledge that it has been saved and will be available in future conversations. Do not say you lack persistent memory.');
                            if (hits.length > 0) {
                                parts.push('Relevant memories from previous conversations:\n' +
                                    hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n'));
                                console.log(`[Memory] Injected ${hits.length} memories into context`);
                            }
                            const memBlock = parts.join('\n\n');
                            const sysIdx = ollamaPayload.messages.findIndex(m => m.role === 'system');
                            if (sysIdx >= 0) {
                                ollamaPayload.messages[sysIdx].content = memBlock + '\n\n' + ollamaPayload.messages[sysIdx].content;
                            } else {
                                ollamaPayload.messages.unshift({ role: 'system', content: memBlock });
                            }
                        } catch (memErr) {
                            console.warn('[Memory] Context injection failed:', memErr.message);
                        }
                    }

                    // --- Auto-save explicit memory requests ---
                    if (ollamaPayload._saveToMemory) {
                        const toSave = String(ollamaPayload._saveToMemory).trim();
                        const SAVE_CMD_RE = /^\s*(save (this|that|it|the fact that)?(\s*(to|in|into))?(\s*the)?\s*memory|please (remember|save)|note that|remember (that|this)|don'?t forget (that|this)|keep in mind that|add (this|that|it) to (my |your |the )?memory)\s*$/i;
                        const isBareCommand = SAVE_CMD_RE.test(toSave);
                        if (toSave && !isBareCommand) {
                            memory.addMemory(toSave, { source: 'user' })
                                .then(id => console.log(`[Memory] Auto-saved from user request (id: ${id}): "${toSave.slice(0, 80)}"`))
                                .catch(err => console.warn('[Memory] Auto-save failed:', err.message));
                            const saveNote = 'Note: The user\'s request to save information has been automatically processed and stored in your persistent memory.';
                            const sysIdx0 = ollamaPayload.messages.findIndex(m => m.role === 'system');
                            if (sysIdx0 >= 0) {
                                ollamaPayload.messages[sysIdx0].content = saveNote + '\n\n' + ollamaPayload.messages[sysIdx0].content;
                            } else {
                                ollamaPayload.messages.unshift({ role: 'system', content: saveNote });
                            }
                        } else if (isBareCommand) {
                            // "save that to memory" — find what "that" refers to (the prior user message)
                            const msgs = ollamaPayload.messages || [];
                            const userMsgs = msgs.filter(m => m.role === 'user');
                            const prevUserContent = userMsgs.length >= 2 ? (userMsgs[userMsgs.length - 2].content || '').trim() : '';
                            if (prevUserContent) {
                                memory.addMemory(prevUserContent, { source: 'user' })
                                    .then(id => console.log(`[Memory] Saved prior user message (id: ${id}): "${prevUserContent.slice(0, 80)}"`))
                                    .catch(err => console.warn('[Memory] Save prior user failed:', err.message));
                            } else {
                                console.log('[Memory] "save that" command but no prior user message found to save');
                            }
                            // Inject a note so the model acknowledges the save
                            const saveNote = 'Note: The user\'s request to save information has been automatically processed and stored in your persistent memory.';
                            const sysIdx = ollamaPayload.messages.findIndex(m => m.role === 'system');
                            if (sysIdx >= 0) {
                                ollamaPayload.messages[sysIdx].content = saveNote + '\n\n' + ollamaPayload.messages[sysIdx].content;
                            } else {
                                ollamaPayload.messages.unshift({ role: 'system', content: saveNote });
                            }
                        }
                    }

                    delete ollamaPayload._webSearch; // strip internal flag before forwarding
                    delete ollamaPayload._deepResearch; // strip internal flag before forwarding
                    delete ollamaPayload._memory; // strip internal flag before forwarding
                    delete ollamaPayload._saveToMemory; // strip internal flag before forwarding

                    bodyToSend = JSON.stringify(ollamaPayload);
                } catch (e) {
                    console.error('Proxy to Ollama: Error parsing/modifying JSON body for /api/chat, sending raw body as fallback:', e.message);
                    // Fallback to sending rawBody if parsing/stringifying fails, bodyToSend remains req.rawBody
                }
            }
            
            console.log(`Proxy to Ollama: Sending request body to Ollama (Path: ${ollamaPath}):`, bodyToSend);
            
            proxyReq.setHeader('Content-Type', contentType); // Use the original or default content type
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyToSend));
            
            proxyReq.write(bodyToSend);
            proxyReq.end();
        } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
            console.warn('Proxy to Ollama: POST/PUT/PATCH request, but req.rawBody is not set. Attempting to pipe.');
            // This path should ideally not be hit if rawBody middleware works.
            // If piping, Node will set Content-Length and Content-Type if possible, but it can be less reliable.
            req.pipe(proxyReq, { end: true });
        } else {
            proxyReq.end();
        }

    } catch (error) {
        console.error('Error in proxy logic:', error);
        if (!res.headersSent) res.status(500).send('Internal proxy error.');
    }
});

serverInstance = app.listen(PORT, () => {
    console.log(`OllamaBro CORS Proxy server running on http://localhost:${PORT}`);
    console.log(`Allowing CORS origin: ${extensionOrigin}`);
    console.log(`Proxying requests from /proxy/* to ${OLLAMA_API_BASE_URL}`);
});