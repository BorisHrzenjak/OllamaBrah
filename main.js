'use strict';

const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const Store = require('electron-store');

let win;
let db;
let store;
let isCleaningUp = false;

function configureAppPaths() {
    if (app.isPackaged) return;

    const explicitDir = process.env.OLLAMABRAH_USER_DATA_DIR;
    const suffix = process.env.OLLAMABRAH_USER_DATA_SUFFIX
        || path.basename(__dirname).replace(/[^a-zA-Z0-9_.-]/g, '-');

    if (!explicitDir && suffix === 'ollama_brah') {
        console.log('[main] Using default dev userData path:', app.getPath('userData'));
        return;
    }

    const baseUserData = explicitDir || path.join(app.getPath('appData'), 'ollama-brah-dev', suffix);

    app.setPath('userData', baseUserData);
    app.setPath('sessionData', path.join(baseUserData, 'session'));
    console.log('[main] Dev userData path:', app.getPath('userData'));
}

configureAppPaths();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
    app.quit();
}

// ─── Database ────────────────────────────────────────────────────────────────

function initDatabase() {
    const dbPath = path.join(app.getPath('userData'), 'ollamabrah.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS tabs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT 'New Chat',
            model TEXT NOT NULL DEFAULT '',
            backend TEXT NOT NULL DEFAULT 'ollama',
            llama_path TEXT,
            active_conversation_id TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            tab_id TEXT NOT NULL,
            model TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'New Conversation',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_tab ON conversations(tab_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            images_json TEXT,
            thinking TEXT,
            tokens_prompt INTEGER,
            tokens_eval INTEGER,
            eval_duration INTEGER,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp ASC);

        CREATE TABLE IF NOT EXISTS model_state (
            tab_id TEXT NOT NULL,
            model TEXT NOT NULL,
            system_prompt TEXT NOT NULL DEFAULT '',
            context_limit INTEGER,
            params_json TEXT,
            PRIMARY KEY (tab_id, model),
            FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS model_metadata (
            model TEXT PRIMARY KEY,
            context_limit_detected INTEGER,
            last_updated INTEGER
        );
    `);

    // Seed one default tab if empty
    const tabCount = db.prepare('SELECT COUNT(*) as c FROM tabs').get();
    if (tabCount.c === 0) {
        const now = Date.now();
        db.prepare(`INSERT INTO tabs (id, title, model, backend, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(generateId(), 'New Chat', '', 'ollama', 0, now);
    }
}

// ─── Settings Store ───────────────────────────────────────────────────────────

function initStore() {
    store = new Store({
        defaults: {
            theme: 'dark',
            fontSize: 14,
            streamingEnabled: true,
            systemPrompt: '',
            contextLimit: 4096,
            ttsEnabled: false,
            ttsVoice: 'af_heart',
            webSearchEnabled: false,
            deepResearchEnabled: false,
            agentModeEnabled: false,
            memoryEnabled: false,
            memoryAutoInject: false,
            memoryAutoExtract: false,
            slashCommands: [],
            slashCommands_init: false,
            llamaCppConfig: {},
            modelCapabilities: {},
            personaPresets: [],
            installedSkills: ['deep-researcher', 'file-organizer', 'terminal-helper', 'web-extractor'],
        }
    });
}

// ─── Proxy ───────────────────────────────────────────────────────────────────

async function stopExistingProxy() {
    try {
        const response = await fetch('http://127.0.0.1:3456/api/shutdown', {
            method: 'POST',
            signal: AbortSignal.timeout(1500)
        });
        if (response.ok) {
            console.log('[main] Existing proxy detected, requesting shutdown...');
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    } catch (err) {
        // No running proxy, or it is not ours — safe to ignore here.
    }
}

async function startProxy() {
    process.env.ALLOWED_ORIGIN = 'electron-app';
    process.env.USER_DATA_PATH = app.getPath('userData');
    process.env.MEMORY_DIR = path.join(app.getPath('userData'), 'memory');
    process.env.SKILLS_DIR = path.join(app.getPath('userData'), 'skills');

    // Load API keys saved via the settings UI into process.env so the proxy can use them
    const tavilyKey = store.get('tavilyApiKey', '');
    const exaKey    = store.get('exaApiKey', '');
    if (tavilyKey) process.env.TAVILY_API_KEY = tavilyKey;
    if (exaKey)    process.env.EXA_API_KEY    = exaKey;
    try {
        await stopExistingProxy();
        require('./proxy/server.js');
        console.log('[main] Proxy server started');
    } catch (err) {
        console.error('[main] Proxy server failed to start:', err);
    }
}

async function cleanupAppResources() {
    if (isCleaningUp) return;
    isCleaningUp = true;

    try {
        const { getServerInstance } = require('./proxy/router');
        const { getWhisperProcess } = require('./proxy/stt');
        const { getLlamaProcess } = require('./proxy/llm');

        const server = typeof getServerInstance === 'function' ? getServerInstance() : null;
        const whisperProcess = typeof getWhisperProcess === 'function' ? getWhisperProcess() : null;
        const llamaProcess = typeof getLlamaProcess === 'function' ? getLlamaProcess() : null;

        if (llamaProcess) {
            try { llamaProcess.kill(); } catch (err) {}
        }
        if (whisperProcess) {
            try { whisperProcess.kill(); } catch (err) {}
        }
        if (server) {
            await new Promise(resolve => server.close(() => resolve()));
        }
    } catch (err) {
        console.warn('[main] Cleanup warning:', err.message);
    }

    if (db) {
        try { db.close(); } catch (err) {}
        db = null;
    }
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
    const preload = path.join(__dirname, 'preload.js');
    win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
        titleBarStyle: 'hidden',
        backgroundColor: '#0a0a0a',
        webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    win.loadFile(path.join(__dirname, 'renderer', 'chat.html'));

    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function registerIpcHandlers() {

    // App
    ipcMain.handle('app:getVersion', () => app.getVersion());

    // Store
    ipcMain.handle('store:get', (_e, key, def) => {
        const val = store.get(key);
        return val !== undefined ? val : def;
    });
    ipcMain.handle('store:set', (_e, key, val) => { store.set(key, val); });
    ipcMain.handle('store:delete', (_e, key) => { store.delete(key); });
    ipcMain.handle('store:getAll', () => store.store);

    // Tabs
    ipcMain.handle('tabs:getAll', () => {
        return db.prepare('SELECT * FROM tabs ORDER BY position ASC, created_at ASC').all();
    });

    ipcMain.handle('tabs:create', (_e, data) => {
        const id = generateId();
        const now = Date.now();
        const pos = (db.prepare('SELECT MAX(position) as m FROM tabs').get().m || 0) + 1;
        db.prepare(`INSERT INTO tabs (id, title, model, backend, llama_path, active_conversation_id, position, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, data.title || 'New Chat', data.model || '', data.backend || 'ollama',
               data.llama_path || null, null, pos, now);
        return db.prepare('SELECT * FROM tabs WHERE id = ?').get(id);
    });

    ipcMain.handle('tabs:update', (_e, id, changes) => {
        const allowed = ['title','model','backend','llama_path','active_conversation_id','position'];
        const keys = Object.keys(changes).filter(k => allowed.includes(k));
        if (!keys.length) return;
        const sets = keys.map(k => `${k} = ?`).join(', ');
        const vals = keys.map(k => changes[k]);
        db.prepare(`UPDATE tabs SET ${sets} WHERE id = ?`).run(...vals, id);
    });

    ipcMain.handle('tabs:remove', (_e, id) => {
        // Keep at least one tab
        const count = db.prepare('SELECT COUNT(*) as c FROM tabs').get().c;
        if (count <= 1) return { error: 'Cannot remove last tab' };
        db.prepare('DELETE FROM tabs WHERE id = ?').run(id);
    });

    ipcMain.handle('tabs:reorder', (_e, ids) => {
        const update = db.prepare('UPDATE tabs SET position = ? WHERE id = ?');
        const run = db.transaction((ids) => {
            ids.forEach((id, i) => update.run(i, id));
        });
        run(ids);
    });

    ipcMain.handle('tabs:setActiveConversation', (_e, tabId, convId) => {
        db.prepare('UPDATE tabs SET active_conversation_id = ? WHERE id = ?').run(convId, tabId);
    });

    // Conversations
    ipcMain.handle('db:loadConversations', (_e, tabId) => {
        return db.prepare('SELECT * FROM conversations WHERE tab_id = ? ORDER BY updated_at DESC').all(tabId);
    });

    ipcMain.handle('db:createConversation', (_e, tabId, model, title) => {
        const id = generateId();
        const now = Date.now();
        db.prepare(`INSERT INTO conversations (id, tab_id, model, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, tabId, model || '', title || 'New Conversation', now, now);
        return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    });

    ipcMain.handle('db:updateConversation', (_e, id, changes) => {
        const allowed = ['title','model','updated_at'];
        const keys = Object.keys(changes).filter(k => allowed.includes(k));
        if (!keys.length) return;
        const sets = keys.map(k => `${k} = ?`).join(', ');
        const vals = keys.map(k => changes[k]);
        db.prepare(`UPDATE conversations SET ${sets} WHERE id = ?`).run(...vals, id);
    });

    ipcMain.handle('db:deleteConversation', (_e, id) => {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });

    // Messages
    ipcMain.handle('db:loadMessages', (_e, convId) => {
        return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC').all(convId);
    });

    ipcMain.handle('db:appendMessage', (_e, convId, msg) => {
        const id = msg.id || generateId();
        const now = msg.timestamp || Date.now();
        db.prepare(`INSERT OR REPLACE INTO messages
            (id, conversation_id, role, content, images_json, thinking, tokens_prompt, tokens_eval, eval_duration, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, convId, msg.role, msg.content || '', msg.images_json || null,
               msg.thinking || null, msg.tokens_prompt || null, msg.tokens_eval || null,
               msg.eval_duration || null, now);
        // Update conversation updated_at
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
        return id;
    });

    ipcMain.handle('db:deleteMessage', (_e, id) => {
        db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    });

    ipcMain.handle('db:clearMessages', (_e, convId) => {
        db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
    });

    // Model state
    ipcMain.handle('db:loadModelState', (_e, tabId, model) => {
        return db.prepare('SELECT * FROM model_state WHERE tab_id = ? AND model = ?').get(tabId, model) || null;
    });

    ipcMain.handle('db:saveModelState', (_e, tabId, model, s) => {
        db.prepare(`INSERT OR REPLACE INTO model_state (tab_id, model, system_prompt, context_limit, params_json)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(tabId, model, s.system_prompt || '', s.context_limit || null, s.params_json || null);
    });

    // Model metadata (detected context limits)
    ipcMain.handle('db:getDetectedContextLimit', (_e, model) => {
        const row = db.prepare('SELECT context_limit_detected FROM model_metadata WHERE model = ?').get(model);
        return row ? row.context_limit_detected : null;
    });

    ipcMain.handle('db:saveDetectedContextLimit', (_e, model, limit) => {
        db.prepare(`INSERT OR REPLACE INTO model_metadata (model, context_limit_detected, last_updated)
                    VALUES (?, ?, ?)`)
          .run(model, limit, Date.now());
    });

    ipcMain.handle('db:getAllDetectedContextLimits', () => {
        const rows = db.prepare('SELECT model, context_limit_detected FROM model_metadata').all();
        const result = {};
        for (const row of rows) {
            result[row.model] = row.context_limit_detected;
        }
        return result;
    });

    // Dashboard stats
    ipcMain.handle('db:getDashboardStats', () => {
        const totalConversations = db.prepare('SELECT COUNT(*) as c FROM conversations').get().c;
        const totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
        const totalTabs = db.prepare('SELECT COUNT(*) as c FROM tabs').get().c;
        const modelsUsed = db.prepare('SELECT DISTINCT model FROM conversations WHERE model != ""').all().map(r => r.model);
        const tokenStats = db.prepare('SELECT SUM(tokens_prompt) as tp, SUM(tokens_eval) as te FROM messages').get();
        return {
            totalConversations,
            totalMessages,
            totalTabs,
            modelsUsed,
            tokensPrompt: tokenStats.tp || 0,
            tokensEval: tokenStats.te || 0,
        };
    });

    // Window controls
    ipcMain.handle('window:minimize', () => win.minimize());
    ipcMain.handle('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
    ipcMain.handle('window:close', () => win.close());

    // Skills
    ipcMain.handle('skills:pickFolder', async () => {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

if (gotSingleInstanceLock) {
    app.on('second-instance', () => {
        if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            if (!win.isVisible()) win.show();
            win.focus();
            return;
        }

        if (app.isReady()) createWindow();
    });

    app.whenReady().then(async () => {
        initDatabase();
        initStore();
        await startProxy();
        registerIpcHandlers();

        // Grant microphone permission for voice input
        session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
            callback(permission === 'microphone' || permission === 'media');
        });
        session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
            if (permission === 'microphone') return true;
            return null;
        });

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('before-quit', (event) => {
        if (isCleaningUp) return;
        event.preventDefault();
        cleanupAppResources().finally(() => app.exit(0));
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
