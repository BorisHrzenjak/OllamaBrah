// proxy/server.js — entry point only: loads env, imports router, starts server, pre-warms Whisper, watches skills dir
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Also load from userData (production/packaged app) — main.js sets USER_DATA_PATH before requiring this file
if (process.env.USER_DATA_PATH) {
    require('dotenv').config({ path: require('path').join(process.env.USER_DATA_PATH, '.env') });
}

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { app, PORT } = require('./router');
const { setServerInstance } = require('./router');
const { markProxyStartup } = require('./build-info');
const { copyBuiltinSkills, reloadSkills } = require('./skills');
const {
    waitForWhisperServer,
    getWhisperStatus,
    setWhisperStatus,
    getWhisperProcess,
    setWhisperProcess,
    getWhisperPort,
    getWhisperModel,
} = require('./stt');
const { getConfiguredOllamaBaseUrl } = require('./ollama');

// Resolve paths that may live in app.asar.unpacked when packaged
function unpackedPath(...segments) {
    const base = __dirname.includes('app.asar')
        ? __dirname.replace('app.asar', 'app.asar.unpacked')
        : __dirname;
    return path.join(base, ...segments);
}

// Initialize skills on startup
markProxyStartup({ sourceHash: process.env.OLLAMA_BRAH_SOURCE_HASH });
copyBuiltinSkills();
reloadSkills();

// Watch SKILLS_DIR for changes so skills installed via CLI are auto-detected
(function watchSkillsDir() {
    const skillsDir = process.env.SKILLS_DIR;
    if (!skillsDir) return;
    try {
        let debounce;
        fs.watch(skillsDir, { recursive: false }, () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                console.log('[Skills] Directory change detected — reloading...');
                reloadSkills();
            }, 600);
        });
        console.log('[Skills] Watching', skillsDir, 'for changes');
    } catch (err) {
        console.warn('[Skills] Could not watch skills directory:', err.message);
    }
})();

const extensionOrigin = 'chrome-extension://gkpfpdekobmonacdgjgbfehilnloaacm';
const serverInstance = app.listen(PORT, '127.0.0.1', () => {
    console.log(`OllamaBro CORS Proxy server running on http://localhost:${PORT}`);
    console.log(`Allowing CORS origin: ${extensionOrigin}`);
    console.log(`Proxying requests from /proxy/* to ${getConfiguredOllamaBaseUrl()}`);


    // Pre-warm Whisper in the background so mic is ready instantly on first use
    const scriptPath = unpackedPath('..', 'whisper_server.py');
    const whisperPort = getWhisperPort();
    const whisperModel = getWhisperModel();
    if (fs.existsSync(scriptPath) && getWhisperStatus() === 'idle') {
        setWhisperStatus('loading');
        console.log(`[STT] Pre-warming Whisper server (model: ${whisperModel})...`);
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const whisperProcess = spawn(pythonCmd, [
            scriptPath, '--model', whisperModel, '--port', String(whisperPort)
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        setWhisperProcess(whisperProcess);
        whisperProcess.stdout.on('data', d => console.log('[STT]', d.toString().trimEnd()));
        whisperProcess.stderr.on('data', d => console.log('[STT]', d.toString().trimEnd()));
        whisperProcess.on('error', err => {
            console.warn('[STT] Pre-warm failed (faster-whisper not installed?):', err.message);
            setWhisperStatus('idle');
            setWhisperProcess(null);
        });
        whisperProcess.on('exit', code => {
            setWhisperProcess(null);
            if (getWhisperStatus() === 'ready') setWhisperStatus('idle');
        });
        waitForWhisperServer(60000).then(ready => {
            setWhisperStatus(ready ? 'ready' : 'idle');
            if (ready) console.log('[STT] Whisper pre-warm complete — mic ready');
            else console.warn('[STT] Whisper pre-warm timed out');
        });
    }
});

setServerInstance(serverInstance);

serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Proxy] Port ${PORT} already in use. Refusing to reuse an unidentified proxy instance.`);
    } else {
        console.error('[Proxy] Server error:', err);
    }
});
