// proxy/stt.js — Whisper STT state + endpoints

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Resolve paths that may live in app.asar.unpacked when packaged
function unpackedPath(...segments) {
    const base = __dirname.includes('app.asar')
        ? __dirname.replace('app.asar', 'app.asar.unpacked')
        : __dirname;
    return path.join(base, ...segments);
}

// --- Whisper STT state ---
let whisperProcess = null;
let whisperStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let whisperPort = parseInt(process.env.WHISPER_PORT || '5051', 10);
let whisperModel = process.env.WHISPER_MODEL || 'small.en';
let cachedPythonCheck = { checkedAt: 0, available: false, command: null, error: null };

function getPythonCommand() {
    return process.platform === 'win32' ? 'python' : 'python3';
}

function checkPythonAvailability() {
    const now = Date.now();
    if (now - cachedPythonCheck.checkedAt < 30000) return cachedPythonCheck;

    const command = getPythonCommand();
    try {
        const result = spawnSync(command, ['--version'], {
            encoding: 'utf8',
            timeout: 4000,
            windowsHide: true
        });
        const available = result.status === 0;
        cachedPythonCheck = {
            checkedAt: now,
            available,
            command,
            error: available ? null : (result.stderr || result.stdout || `exit status ${result.status}` || 'Unknown error').trim()
        };
    } catch (err) {
        cachedPythonCheck = {
            checkedAt: now,
            available: false,
            command,
            error: err.message
        };
    }

    return cachedPythonCheck;
}

function getWhisperDiagnostics() {
    const scriptPath = unpackedPath('..', 'whisper_server.py');
    const python = checkPythonAvailability();
    const scriptPresent = fs.existsSync(scriptPath);
    const ready = whisperStatus === 'ready';

    let message = 'Whisper ready';
    if (!scriptPresent) {
        message = 'Whisper server script is missing.';
    } else if (!python.available) {
        message = `Python is not available via ${python.command}.`;
    } else if (ready) {
        message = 'Whisper is ready for voice input.';
    } else if (whisperStatus === 'loading') {
        message = 'Whisper is warming up in the background.';
    } else if (whisperStatus === 'error') {
        message = 'Whisper failed to start. Install faster-whisper and flask.';
    } else {
        message = 'Voice input is available, but Whisper is not loaded yet.';
    }

    return {
        status: ready ? 'ready' : ((!scriptPresent || !python.available || whisperStatus === 'error') ? 'needs_attention' : 'idle'),
        whisperStatus,
        model: whisperModel,
        port: whisperPort,
        scriptPresent,
        scriptPath,
        pythonAvailable: python.available,
        pythonCommand: python.command,
        pythonError: python.error,
        message
    };
}

async function waitForWhisperServer(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${whisperPort}/health`, res => {
                    let body = '';
                    res.on('data', d => body += d);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); } catch { resolve({}); }
                    });
                });
                req.on('error', reject);
                req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            return true;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return false;
}

// --- Route handlers ---

function handleSttStatus(req, res) {
    res.json({ status: whisperStatus, model: whisperModel, port: whisperPort });
}

async function handleSttLoad(req, res) {
    if (whisperStatus === 'ready') return res.json({ ok: true, status: 'ready' });
    if (whisperStatus === 'loading') return res.json({ ok: true, status: 'loading' });

    const scriptPath = unpackedPath('..', 'whisper_server.py');
    if (!fs.existsSync(scriptPath)) {
        return res.status(404).json({ error: 'whisper_server.py not found' });
    }

    whisperStatus = 'loading';
    console.log(`[STT] Starting Whisper server (model: ${whisperModel})...`);

    const pythonCmd = getPythonCommand();
    try {
        whisperProcess = spawn(pythonCmd, [
            scriptPath,
            '--model', whisperModel,
            '--port', String(whisperPort)
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

        whisperProcess.stdout.on('data', d => console.log('[STT]', d.toString().trimEnd()));
        whisperProcess.stderr.on('data', d => console.log('[STT]', d.toString().trimEnd()));

        whisperProcess.on('error', err => {
            console.error('[STT] Process error:', err.message);
            whisperStatus = 'error';
            whisperProcess = null;
        });

        whisperProcess.on('exit', (code) => {
            console.log(`[STT] Process exited (code=${code})`);
            whisperProcess = null;
            if (whisperStatus === 'ready') whisperStatus = 'idle';
        });

        const ready = await waitForWhisperServer(60000);
        if (ready) {
            whisperStatus = 'ready';
            console.log('[STT] Whisper server ready');
            res.json({ ok: true, status: 'ready' });
        } else {
            whisperStatus = 'error';
            console.error('[STT] Whisper server did not become ready in time');
            res.status(504).json({ error: 'Whisper server did not start within 60 seconds' });
        }
    } catch (err) {
        whisperStatus = 'error';
        console.error('[STT] Spawn error:', err);
        res.status(500).json({ error: err.message });
    }
}

async function handleSttTranscribe(req, res) {
    if (whisperStatus !== 'ready') {
        return res.status(503).json({ error: 'Whisper not ready', status: whisperStatus });
    }

    const { audio, format } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'No audio provided' });

    try {
        const result = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ audio, format: format || 'webm' });
            const reqOpts = {
                hostname: '127.0.0.1',
                port: whisperPort,
                path: '/transcribe',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const proxyReq = http.request(reqOpts, proxyRes => {
                let data = '';
                proxyRes.on('data', d => data += d);
                proxyRes.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response from Whisper')); }
                });
            });
            proxyReq.on('error', reject);
            proxyReq.setTimeout(30000, () => { proxyReq.destroy(); reject(new Error('Whisper timeout')); });
            proxyReq.write(body);
            proxyReq.end();
        });
        res.json(result);
    } catch (err) {
        console.error('[STT] Transcription error:', err.message);
        res.status(500).json({ error: err.message });
    }
}

// Expose state via getters/setters so other modules (router shutdown, server entry) can read/write
function getWhisperProcess() { return whisperProcess; }
function setWhisperProcess(p) { whisperProcess = p; }
function getWhisperStatus() { return whisperStatus; }
function setWhisperStatus(s) { whisperStatus = s; }
function getWhisperPort() { return whisperPort; }
function getWhisperModel() { return whisperModel; }

module.exports = {
    waitForWhisperServer,
    handleSttStatus,
    handleSttLoad,
    handleSttTranscribe,
    getWhisperProcess,
    setWhisperProcess,
    getWhisperStatus,
    getWhisperDiagnostics,
    setWhisperStatus,
    getWhisperPort,
    getWhisperModel,
};
