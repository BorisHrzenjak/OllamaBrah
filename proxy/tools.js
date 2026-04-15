// proxy/tools.js — agent tool definitions, executeTool, requestPermission, isPathAllowed, agent config state

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const memory = require('./memory');
const diffLib = require('diff');
const { fetchPageViaJina, fetchBinaryUrl, fetchTavilyResults, heuristicTimeRange } = require('./search');
const skillsModule = require('./skills');
const { parsePdfBuffer } = require('./document-parser');

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;

function createToolCache() {
    const store = new Map();
    return {
        get(key) {
            const entry = store.get(key);
            if (!entry) return undefined;
            if (Date.now() - entry.ts > CACHE_TTL_MS) { store.delete(key); return undefined; }
            return entry.value;
        },
        set(key, value) {
            if (store.size >= CACHE_MAX_ENTRIES) {
                const oldest = store.keys().next().value;
                store.delete(oldest);
            }
            store.set(key, { value, ts: Date.now() });
        },
        invalidatePrefix(prefix) {
            for (const key of store.keys()) {
                if (key.startsWith(prefix)) store.delete(key);
            }
        },
        invalidatePath(filePath) {
            const dir = path.dirname(filePath).toLowerCase();
            for (const key of [...store.keys()]) {
                if (key.includes(dir) || dir.includes(key.split(':')[1] || '')) {
                    store.delete(key);
                }
            }
        },
        clear() { store.clear(); },
    };
}

function stableHash(...parts) {
    const joined = parts.filter(Boolean).join('\0');
    return crypto.createHash('md5').update(joined).digest('hex').slice(0, 12);
}

// --- Agent config (updated via POST /api/agent/config) ---
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
    readFileRange: 'auto',
    writeFile: 'confirm',
    replaceInFile: 'confirm',
    applyPatch: 'confirm',
    listDirectory: 'auto',
    findFiles: 'auto',
    searchInFiles: 'auto',
    globFiles: 'auto',
    mkdir: 'confirm',
    copyFile: 'confirm',
    moveFile: 'confirm',
    deleteFile: 'confirm',
    runCode: 'confirm',
    runShell: 'confirm',
    clipboardRead: 'confirm',
    clipboardWrite: 'confirm',
    readUrl: 'auto',
    diffFiles: 'auto',
    appendFile: 'confirm',
    loadSkill: 'auto',
};

// Pending permission requests: id → { resolve, reject }
const pendingPermissions = new Map();
const pendingPlanApprovals = new Map();

const PLAN_GATED_TOOLS = new Set([
    'runShell',
    'writeFile',
    'applyPatch',
    'replaceInFile',
    'deleteFile',
    'mkdir',
    'copyFile',
    'moveFile',
    'appendFile',
]);

function getPlanToolEntry(tool, args, risk) {
    const files = [];
    const commands = [];
    if (args?.path) files.push(String(args.path));
    if (args?.source) files.push(String(args.source));
    if (args?.destination) files.push(String(args.destination));
    if (tool === 'runShell' && args?.cmd) commands.push(String(args.cmd));

    const actionMap = {
        runShell: `Run shell command: ${args?.cmd || ''}`,
        writeFile: `Write file ${args?.path || ''}`,
        applyPatch: `Patch file ${args?.path || ''}`,
        replaceInFile: `Replace text in ${args?.path || ''}`,
        deleteFile: `Delete file ${args?.path || ''}`,
        mkdir: `Create directory ${args?.path || ''}`,
        copyFile: `Copy ${args?.source || ''} to ${args?.destination || ''}`,
        moveFile: `Move ${args?.source || ''} to ${args?.destination || ''}`,
        appendFile: `Append to file ${args?.path || ''}`,
    };

    return {
        tool,
        summary: actionMap[tool] || `Run ${tool}`,
        risk: risk || 'medium',
        files,
        commands,
        argsPreview: Object.fromEntries(Object.entries(args || {}).map(([k, v]) => [k, String(v).slice(0, 200)])),
    };
}

function buildExecutionPlan(toolCalls = []) {
    const entries = toolCalls
        .filter(tc => PLAN_GATED_TOOLS.has(tc.name))
        .map(tc => getPlanToolEntry(tc.name, tc.args, tc.risk));
    if (!entries.length) return null;

    const files = [...new Set(entries.flatMap(entry => entry.files))];
    const commands = [...new Set(entries.flatMap(entry => entry.commands))];
    const risks = ['low', 'medium', 'high', 'critical'];
    const risk = entries.reduce((current, entry) => risks[Math.max(risks.indexOf(current), risks.indexOf(entry.risk || 'medium'))], 'low');

    return {
        summary: entries.length === 1 ? entries[0].summary : `Execute ${entries.length} risky actions in this step`,
        risk,
        files,
        commands,
        actions: entries,
    };
}

function generatePermissionId() {
    return Math.random().toString(36).slice(2, 10);
}

function isPathAllowed(targetPath) {
    let resolved;
    try { resolved = fs.realpathSync(targetPath); } catch {
        try { resolved = path.resolve(targetPath); } catch { return false; }
    }
    const lower = resolved.toLowerCase();
    function matchesBoundary(base) {
        const b = path.resolve(base).toLowerCase();
        return lower === b || lower.startsWith(b + path.sep) || lower.startsWith(b + '/');
    }
    if (agentBlockedPaths.some(b => matchesBoundary(b))) return false;
    if (agentAllowedDirs.length === 0) return true;
    return agentAllowedDirs.some(a => matchesBoundary(a));
}

function normalizeToolPath(targetPath) {
    return path.resolve(String(targetPath || ''));
}

function ensureAllowedPath(targetPath) {
    const resolved = normalizeToolPath(targetPath);
    if (!isPathAllowed(resolved)) {
        throw new Error('Path not allowed');
    }
    return resolved;
}

function isPathInsideWorkspace(targetPath, workspaceRoot) {
    if (!workspaceRoot) return true;
    const resolvedTarget = path.resolve(String(targetPath || '')).toLowerCase();
    const resolvedWorkspace = path.resolve(String(workspaceRoot || '')).toLowerCase();
    return resolvedTarget === resolvedWorkspace
        || resolvedTarget.startsWith(resolvedWorkspace + path.sep)
        || resolvedTarget.startsWith(resolvedWorkspace + '/');
}

function resolveWorkspacePath(targetPath, workspaceRoot) {
    const raw = String(targetPath || '').trim();
    if (!raw) throw new Error('Path is required');
    const hasDrive = /^[a-zA-Z]:[\\/]/.test(raw);
    const isAbsoluteUnix = raw.startsWith('/');
    const resolved = (hasDrive || isAbsoluteUnix || !workspaceRoot)
        ? raw
        : path.join(workspaceRoot, raw);
    const allowed = ensureAllowedPath(resolved);
    if (workspaceRoot && !isPathInsideWorkspace(allowed, workspaceRoot)) {
        throw new Error(`Path must stay inside the selected workspace: ${workspaceRoot}`);
    }
    return allowed;
}

function extractCommandPaths(cmd) {
    const text = String(cmd || '');
    const matches = [];
    const patterns = [
        /"([a-zA-Z]:\\[^"\r\n]+)"/g,
        /'([a-zA-Z]:\\[^'\r\n]+)'/g,
        /([a-zA-Z]:\\[^\s|&;<>"']+)/g,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            matches.push(match[1]);
        }
    }

    return [...new Set(matches)];
}

function validateShellCommandForWorkspace(cmd, workspaceRoot) {
    if (!workspaceRoot) return;
    const outsidePath = extractCommandPaths(cmd).find(filePath => !isPathInsideWorkspace(filePath, workspaceRoot));
    if (outsidePath) {
        throw new Error(`Shell command references a path outside the selected workspace: ${outsidePath}`);
    }
}

function createFileDiffPreview(filePath, beforeText, afterText) {
    const before = typeof beforeText === 'string' ? beforeText : '';
    const after = typeof afterText === 'string' ? afterText : '';
    if (before === after) return null;

    const patch = diffLib.createTwoFilesPatch(filePath, filePath, before, after, 'before', 'after');
    const MAX_DIFF = 8000;
    if (patch.length <= MAX_DIFF) return patch;

    const truncated = patch.slice(0, MAX_DIFF);
    const lastNewline = truncated.lastIndexOf('\n');
    return truncated.slice(0, lastNewline > 0 ? lastNewline : MAX_DIFF) + `\n... (diff truncated, ${patch.length - MAX_DIFF} more bytes)`;
}

function collectTouchedPaths(name, args = {}) {
    switch (name) {
        case 'writeFile':
        case 'applyPatch':
        case 'replaceInFile':
        case 'deleteFile':
        case 'appendFile':
        case 'mkdir':
            return args.path ? [String(args.path)] : [];
        case 'copyFile':
        case 'moveFile':
            return [args.source, args.destination].filter(Boolean).map(String);
        default:
            return [];
    }
}

function walkDirectory(dir, { recursive = true, maxDepth = 20, onEntry }, depth = 0) {
    if (depth > maxDepth) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        onEntry(entry, fullPath, depth);
        if (recursive && entry.isDirectory()) {
            walkDirectory(fullPath, { recursive, maxDepth, onEntry }, depth + 1);
        }
    }
}

function globToRegExp(pattern) {
    const normalized = String(pattern || '**/*').replace(/\\/g, '/');
    let regex = '^';
    for (let i = 0; i < normalized.length; i += 1) {
        const char = normalized[i];
        const next = normalized[i + 1];
        if (char === '*') {
            if (next === '*') {
                regex += '.*';
                i += 1;
            } else {
                regex += '[^/]*';
            }
        } else if (char === '?') {
            regex += '.';
        } else if ('[](){}.+^$|'.includes(char)) {
            regex += `\\${char}`;
        } else {
            regex += char;
        }
    }
    regex += '$';
    return new RegExp(regex, 'i');
}

function formatLineRange(lines, startLine) {
    return lines
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n');
}

// Tier 1 tool definitions (for the model's tools array)
const AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webSearch',
            description: 'Search the web for current information. MUST be called for any question involving: recent news, current events, today\'s date, live prices, sports scores, weather, product releases, anything that may have changed since your training data. Never answer time-sensitive questions from memory alone — always call webSearch first.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetchPage',
            description: 'Fetch and read the full content of a web page by URL. Use after webSearch to read full article text, or when the user provides a specific URL to read.',
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
            description: 'Read the contents of a file from disk. For large files, prefer readFileRange to avoid wasting context on irrelevant sections.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' } }, required: ['path'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'readFileRange',
            description: 'Read a specific line range from a text file. Use this for large code files when you only need a focused section.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    start: { type: 'integer', description: '1-based starting line number' },
                    end: { type: 'integer', description: '1-based ending line number (inclusive)' }
                },
                required: ['path', 'start', 'end']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'writeFile',
            description: 'Write or overwrite a file on disk. For editing existing code, prefer replaceInFile or applyPatch instead — they are safer and more precise.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' }, content: { type: 'string', description: 'Content to write' } }, required: ['path', 'content'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'replaceInFile',
            description: 'Replace matching text inside a file without rewriting unrelated content. Best for targeted code edits.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file' },
                    search: { type: 'string', description: 'Exact text to search for' },
                    replace: { type: 'string', description: 'Replacement text' },
                    replaceAll: { type: 'boolean', description: 'Replace every match instead of only the first one' }
                },
                required: ['path', 'search', 'replace']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'applyPatch',
            description: 'Apply a unified diff patch to a single file for a surgical code edit.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the file being patched' },
                    diff: { type: 'string', description: 'Unified diff patch text for the target file' }
                },
                required: ['path', 'diff']
            }
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
            name: 'searchInFiles',
            description: 'Search for text across files in a directory tree. Use this to locate symbols, strings, TODOs, or code patterns.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory to search in (absolute Windows path)' },
                    query: { type: 'string', description: 'Text or regex pattern to search for' },
                    filePattern: { type: 'string', description: 'Optional glob pattern like "**/*.js" or "src/**/*.ts"' },
                    regex: { type: 'boolean', description: 'Treat query as a regular expression' }
                },
                required: ['path', 'query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'globFiles',
            description: 'Find files by glob pattern such as "**/*.js" or "src/**/*.tsx".',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory to search in (absolute Windows path)' },
                    pattern: { type: 'string', description: 'Glob pattern to match files' }
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
            name: 'mkdir',
            description: 'Create a directory, including parent folders if needed.',
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the directory' } }, required: ['path'] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'copyFile',
            description: 'Copy a file from one path to another.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Absolute path to the source file' },
                    destination: { type: 'string', description: 'Absolute path to the destination file' }
                },
                required: ['source', 'destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'moveFile',
            description: 'Move or rename a file from one path to another.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Absolute path to the source file' },
                    destination: { type: 'string', description: 'Absolute path to the destination file' }
                },
                required: ['source', 'destination']
            }
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
            description: 'Append text to the end of a file without overwriting its existing content. Good for logs, notes, or journals. For editing existing code, prefer replaceInFile or applyPatch. Creates the file if it does not exist.',
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
    {
        type: 'function',
        function: {
            name: 'loadSkill',
            description: 'Load full instructions for a named skill before using it. Call this at the start of a skill-assisted task.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Name of the skill to load (e.g. "deep-researcher")' }
                },
                required: ['name']
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

    if (res?.yoloMode === true) {
        if (typeof res.write === 'function' && !res.writableEnded) {
            res.write(JSON.stringify({ type: 'permission_auto_approved', tool, args, risk, mode: 'yolo' }) + '\n');
        }
        return true;
    }

    // Check session-level grants before prompting the user
    if (sessionPermissions.has(tool)) return true;
    if (args && args.path) {
        const dir = path.dirname(args.path);
        if (sessionPermissions.has(`${tool}:${dir}`)) return true;
    }

    // perm === 'confirm' — stream a permission card and wait
    const id = generatePermissionId();
    res.write(JSON.stringify({ type: 'permission_request', id, tool, args, risk, runId: res.runId || null }) + '\n');

    return new Promise((resolve) => {
        let keepaliveInterval;

        const cleanup = (approved) => {
            clearTimeout(timeout);
            clearInterval(keepaliveInterval);
            if (typeof res.removeListener === 'function') res.removeListener('close', onClose);
            pendingPermissions.delete(id);
            resolve(approved);
        };

        // Keepalive pings prevent the HTTP connection from timing out during long waits
        keepaliveInterval = setInterval(() => {
            if (!res.writableEnded) res.write(JSON.stringify({ type: 'keepalive' }) + '\n');
        }, 25000);

        const timeout = setTimeout(() => cleanup(false), 300000); // auto-deny after 5 min

        const onClose = () => cleanup(false); // client disconnected
        if (typeof res.once === 'function') res.once('close', onClose);

        pendingPermissions.set(id, {
            runId: res.runId || null,
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

async function requestPlanApproval(res, plan, sessionPermissions) {
    if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) return true;
    const sessionPlanKey = `plan:${stableHash(JSON.stringify(plan.actions.map(action => ({ tool: action.tool, files: action.files, commands: action.commands }))))}`;
    if (sessionPermissions.has(sessionPlanKey)) return true;

    if (res?.yoloMode === true) {
        if (typeof res.write === 'function' && !res.writableEnded) {
            res.write(JSON.stringify({ type: 'plan_auto_approved', approved: true, scope: 'yolo', plan, mode: 'yolo' }) + '\n');
        }
        return true;
    }

    const id = generatePermissionId();
    res.write(JSON.stringify({ type: 'plan_request', id, plan, runId: res.runId || null }) + '\n');

    return new Promise((resolve) => {
        const timeout = setTimeout(() => cleanup(false), 300000);
        const onClose = () => cleanup(false);

        const cleanup = (approved) => {
            clearTimeout(timeout);
            if (typeof res.removeListener === 'function') res.removeListener('close', onClose);
            pendingPlanApprovals.delete(id);
            resolve(approved);
        };

        if (typeof res.once === 'function') res.once('close', onClose);

        pendingPlanApprovals.set(id, {
            runId: res.runId || null,
            plan,
            resolve: (approved, scope) => {
                if (typeof res.write === 'function' && !res.writableEnded) {
                    res.write(JSON.stringify({ type: 'plan_decision', id, approved: !!approved, scope, plan }) + '\n');
                }
                if (approved && scope === 'session') sessionPermissions.set(sessionPlanKey, true);
                cleanup(approved);
            },
            reject: () => cleanup(false),
        });
    });
}

// Execute a single tool call, streaming progress/result
async function executeTool(res, name, args, sessionPermissions, model, backend, toolCache, workspaceRoot) {
    try {
        const scopedArgs = args && typeof args === 'object' ? { ...args } : {};
        if (['readFile', 'readFileRange', 'writeFile', 'replaceInFile', 'applyPatch', 'listDirectory', 'findFiles', 'searchInFiles', 'globFiles', 'deleteFile', 'mkdir', 'appendFile'].includes(name) && scopedArgs.path) {
            scopedArgs.path = resolveWorkspacePath(scopedArgs.path, workspaceRoot);
        }
        if (['copyFile', 'moveFile'].includes(name)) {
            if (scopedArgs.source) scopedArgs.source = resolveWorkspacePath(scopedArgs.source, workspaceRoot);
            if (scopedArgs.destination) scopedArgs.destination = resolveWorkspacePath(scopedArgs.destination, workspaceRoot);
        }
        switch (name) {
            case 'webSearch': {
                const tavilyKey = process.env.TAVILY_API_KEY;
                if (!tavilyKey || tavilyKey === 'your_tavily_api_key_here') {
                    return {
                        result: 'Web search is unavailable: no Tavily API key is configured. ' +
                            'To enable web search, add TAVILY_API_KEY=<your_key> to the .env file in the app folder. ' +
                            'You can get a free key at https://tavily.com. ' +
                            'In the meantime, you can still fetch specific pages directly using the fetchPage tool if you have a URL.',
                        error: true
                    };
                }
                console.log(`[Agent/webSearch] Query: "${(args.query || '').slice(0, 100)}"`);
                const query = args.query || '';
                const result = await fetchTavilyResults(query, { time_range: heuristicTimeRange(query) });
                if (!result) return { result: 'No results', error: true };
                if (result._configError) return { result: result._configError, error: true };
                console.log(`[Agent/webSearch] Got ${result.results?.length || 0} result(s)`);
                return { result: JSON.stringify(result).slice(0, 3000) };
            }
            case 'fetchPage': {
                console.log(`[Agent/fetchPage] Fetching: ${(args.url || '').slice(0, 100)}`);
                const text = await fetchPageViaJina(args.url || '', 8000);
                if (text && text._fetchError) { console.warn(`[Agent/fetchPage] ${text._fetchError}`); return { result: text._fetchError, error: true }; }
                console.log(`[Agent/fetchPage] Got ${typeof text === 'string' ? text.length : 0} chars`);
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
                const approved = await requestPermission(res, 'readFile', scopedArgs, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(scopedArgs.path)) return { result: 'Path not allowed', error: true };
                try {
                    const content = fs.readFileSync(scopedArgs.path, 'utf8');
                    return { result: content.slice(0, 8000) };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'readFileRange': {
                const approved = await requestPermission(res, 'readFileRange', scopedArgs, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const filePath = ensureAllowedPath(scopedArgs.path);
                    const start = Math.max(1, parseInt(scopedArgs.start, 10) || 1);
                    const end = Math.max(start, parseInt(scopedArgs.end, 10) || start);
                    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
                    const slice = lines.slice(start - 1, end);
                    return { result: formatLineRange(slice, start) || `(no content in lines ${start}-${end})` };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'writeFile': {
                const approved = await requestPermission(res, 'writeFile', scopedArgs, 'high', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(scopedArgs.path)) return { result: 'Path not allowed', error: true };
                try {
                    const previous = fs.existsSync(scopedArgs.path) ? fs.readFileSync(scopedArgs.path, 'utf8') : '';
                    fs.mkdirSync(path.dirname(scopedArgs.path), { recursive: true });
                    fs.writeFileSync(scopedArgs.path, scopedArgs.content || '', 'utf8');
                    if (toolCache) toolCache.invalidatePath(scopedArgs.path);
                    return {
                        result: 'File written successfully',
                        diffPreview: createFileDiffPreview(scopedArgs.path, previous, String(scopedArgs.content || '')),
                        diffPath: scopedArgs.path,
                    };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'replaceInFile': {
                const approved = await requestPermission(res, 'replaceInFile', scopedArgs, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const filePath = ensureAllowedPath(scopedArgs.path);
                    const search = String(scopedArgs.search || '');
                    if (!search) return { result: 'Search text was empty', error: true };
                    const original = fs.readFileSync(filePath, 'utf8');
                    const replaceAll = scopedArgs.replaceAll === true;
                    const matchCount = original.split(search).length - 1;
                    if (matchCount === 0) return { result: 'No matches found', error: true };
                    const updated = replaceAll
                        ? original.split(search).join(String(scopedArgs.replace || ''))
                        : original.replace(search, String(scopedArgs.replace || ''));
                    fs.writeFileSync(filePath, updated, 'utf8');
                    if (toolCache) toolCache.invalidatePath(filePath);
                    return {
                        result: `Replaced ${replaceAll ? matchCount : 1} occurrence(s) in ${filePath}`,
                        diffPreview: createFileDiffPreview(filePath, original, updated),
                        diffPath: filePath,
                    };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'applyPatch': {
                const approved = await requestPermission(res, 'applyPatch', scopedArgs, 'high', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const filePath = ensureAllowedPath(scopedArgs.path);
                    const original = fs.readFileSync(filePath, 'utf8');
                    const patched = diffLib.applyPatch(original, String(scopedArgs.diff || ''));
                    if (patched === false) return { result: 'Patch could not be applied cleanly', error: true };
                    fs.writeFileSync(filePath, patched, 'utf8');
                    if (toolCache) toolCache.invalidatePath(filePath);
                    return {
                        result: `Patch applied successfully to ${filePath}`,
                        diffPreview: createFileDiffPreview(filePath, original, patched),
                        diffPath: filePath,
                    };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'listDirectory': {
                const approved = await requestPermission(res, 'listDirectory', scopedArgs, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(scopedArgs.path)) return { result: 'Path not allowed', error: true };
                try {
                    const cacheKey = `dir:${path.resolve(scopedArgs.path).toLowerCase()}`;
                    const cached = toolCache && toolCache.get(cacheKey);
                    if (cached) return { result: cached };
                    const entries = fs.readdirSync(scopedArgs.path, { withFileTypes: true });
                    const dirs = entries.filter(e => e.isDirectory());
                    const files = entries.filter(e => !e.isDirectory());
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
                        `Directory: ${scopedArgs.path}`,
                        `Total: ${entries.length} items (${files.length} files, ${dirs.length} dirs)`,
                        extSummary ? `File types: ${extSummary}` : '',
                        '',
                        ...dirs.map(e => '[DIR] ' + e.name),
                        ...files.map(e => e.name),
                    ].filter(l => l !== undefined);
                    const result = lines.join('\n');
                    if (toolCache) toolCache.set(cacheKey, result);
                    return { result };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'findFiles': {
                const approved = await requestPermission(res, 'findFiles', scopedArgs, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(scopedArgs.path)) return { result: 'Path not allowed', error: true };
                try {
                    const cacheKey = `find:${path.resolve(scopedArgs.path).toLowerCase()}:${scopedArgs.pattern}:${!!scopedArgs.recursive}`;
                    const cached = toolCache && toolCache.get(cacheKey);
                    if (cached) return { result: cached };
                    const exts = scopedArgs.pattern === '*'
                        ? []
                        : String(scopedArgs.pattern).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                    const recursive = !!scopedArgs.recursive;
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
                    walk(scopedArgs.path, 0);
                    const preview = found.slice(0, 50).join('\n');
                    const more = found.length > 50 ? `\n... and ${found.length - 50} more` : '';
                    const result = `Found ${found.length} file(s) matching "${scopedArgs.pattern}" in ${scopedArgs.path}${recursive ? ' (recursive)' : ''}:\n${preview}${more}`;
                    if (toolCache) toolCache.set(cacheKey, result);
                    return { result };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'searchInFiles': {
                const approved = await requestPermission(res, 'searchInFiles', scopedArgs, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const root = ensureAllowedPath(scopedArgs.path);
                    const cacheKey = `search:${root.toLowerCase()}:${stableHash(scopedArgs.query, scopedArgs.filePattern, String(!!scopedArgs.regex))}`;
                    const cached = toolCache && toolCache.get(cacheKey);
                    if (cached) return { result: cached };
                    const matcher = scopedArgs.filePattern ? globToRegExp(scopedArgs.filePattern) : null;
                    const regex = scopedArgs.regex ? new RegExp(String(scopedArgs.query || ''), 'i') : null;
                    const query = String(scopedArgs.query || '');
                    const hits = [];
                    walkDirectory(root, {
                        recursive: true,
                        maxDepth: 20,
                        onEntry: (entry, fullPath) => {
                            if (!entry.isFile()) return;
                            const relative = path.relative(root, fullPath).replace(/\\/g, '/');
                            if (matcher && !matcher.test(relative)) return;
                            let content;
                            try { content = fs.readFileSync(fullPath, 'utf8'); } catch { return; }
                            const lines = content.split(/\r?\n/);
                            lines.forEach((line, index) => {
                                const matched = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase());
                                if (matched) {
                                    hits.push(`${relative}:${index + 1}: ${line.trim()}`);
                                }
                            });
                        }
                    });
                    const preview = hits.slice(0, 100).join('\n');
                    const more = hits.length > 100 ? `\n... and ${hits.length - 100} more match(es)` : '';
                    const result = hits.length ? `Found ${hits.length} match(es):\n${preview}${more}` : 'No matches found';
                    if (toolCache) toolCache.set(cacheKey, result);
                    return { result };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'globFiles': {
                const approved = await requestPermission(res, 'globFiles', scopedArgs, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const root = ensureAllowedPath(scopedArgs.path);
                    const cacheKey = `glob:${root.toLowerCase()}:${scopedArgs.pattern || '**/*'}`;
                    const cached = toolCache && toolCache.get(cacheKey);
                    if (cached) return { result: cached };
                    const matcher = globToRegExp(scopedArgs.pattern || '**/*');
                    const found = [];
                    walkDirectory(root, {
                        recursive: true,
                        maxDepth: 20,
                        onEntry: (entry, fullPath) => {
                            if (!entry.isFile()) return;
                            const relative = path.relative(root, fullPath).replace(/\\/g, '/');
                            if (matcher.test(relative)) found.push(relative);
                        }
                    });
                    const preview = found.slice(0, 100).join('\n');
                    const more = found.length > 100 ? `\n... and ${found.length - 100} more` : '';
                    const result = found.length ? `Matched ${found.length} file(s):\n${preview}${more}` : 'No files matched';
                    if (toolCache) toolCache.set(cacheKey, result);
                    return { result };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'deleteFile': {
                const approved = await requestPermission(res, 'deleteFile', scopedArgs, 'high', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(scopedArgs.path)) return { result: 'Path not allowed', error: true };
                try {
                    const previous = fs.existsSync(scopedArgs.path) ? fs.readFileSync(scopedArgs.path, 'utf8') : '';
                    fs.unlinkSync(scopedArgs.path);
                    if (toolCache) toolCache.invalidatePath(scopedArgs.path);
                    return {
                        result: 'File deleted: ' + scopedArgs.path,
                        diffPreview: createFileDiffPreview(scopedArgs.path, previous, ''),
                        diffPath: scopedArgs.path,
                    };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'mkdir': {
                const approved = await requestPermission(res, 'mkdir', scopedArgs, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const dirPath = ensureAllowedPath(scopedArgs.path);
                    fs.mkdirSync(dirPath, { recursive: true });
                    if (toolCache) toolCache.invalidatePath(dirPath);
                    return { result: `Directory created: ${dirPath}` };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'copyFile': {
                const approved = await requestPermission(res, 'copyFile', scopedArgs, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const source = ensureAllowedPath(scopedArgs.source);
                    const destination = ensureAllowedPath(scopedArgs.destination);
                    fs.mkdirSync(path.dirname(destination), { recursive: true });
                    fs.copyFileSync(source, destination);
                    if (toolCache) { toolCache.invalidatePath(source); toolCache.invalidatePath(destination); }
                    return { result: `Copied ${source} to ${destination}` };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'moveFile': {
                const approved = await requestPermission(res, 'moveFile', scopedArgs, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                try {
                    const source = ensureAllowedPath(scopedArgs.source);
                    const destination = ensureAllowedPath(scopedArgs.destination);
                    fs.mkdirSync(path.dirname(destination), { recursive: true });
                    fs.renameSync(source, destination);
                    if (toolCache) { toolCache.invalidatePath(source); toolCache.invalidatePath(destination); }
                    return { result: `Moved ${source} to ${destination}` };
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
                const shellCwd = workspaceRoot ? ensureAllowedPath(workspaceRoot) : undefined;
                validateShellCommandForWorkspace(args.cmd, shellCwd);
                const approved = await requestPermission(res, 'runShell', { cmd: args.cmd, cwd: shellCwd }, 'critical', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                res.write(JSON.stringify({ type: 'tool_running', name: 'runShell', preview: args.cmd, cwd: shellCwd || process.cwd() }) + '\n');
                return await runShellTool(args.cmd, shellCwd);
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
                    try {
                        let buffer;
                        if (isHttpUrl) {
                            buffer = await fetchBinaryUrl(url);
                        } else {
                            if (!isPathAllowed(url)) return { result: 'Path not allowed', error: true };
                            buffer = fs.readFileSync(url);
                        }
                        const data = await parsePdfBuffer(buffer, {
                            fileName: url,
                            source: 'readUrl',
                        });
                        const meta = data.pageCount ? `Pages: ${data.pageCount}\n\n` : '';
                        return { result: (meta + data.text).slice(0, 8000) || '(no text extracted)' };
                    } catch (e) { return { result: 'Error reading PDF: ' + e.message, error: true }; }
                } else {
                    const text = await fetchPageViaJina(url, 8000);
                    if (text && text._fetchError) return { result: text._fetchError, error: true };
                    return { result: text || 'No content' };
                }
            }
            case 'diffFiles': {
                const approved = await requestPermission(res, 'diffFiles', { pathA: resolveWorkspacePath(args.pathA, workspaceRoot), pathB: resolveWorkspacePath(args.pathB, workspaceRoot) }, 'low', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                const pathA = resolveWorkspacePath(args.pathA, workspaceRoot);
                const pathB = resolveWorkspacePath(args.pathB, workspaceRoot);
                if (!isPathAllowed(pathA) || !isPathAllowed(pathB)) return { result: 'Path not allowed', error: true };
                try {
                    const a = fs.readFileSync(pathA, 'utf8');
                    const b = fs.readFileSync(pathB, 'utf8');
                    const changes = diffLib.structuredPatch(pathA, pathB, a, b);
                    const hunks = changes.hunks || [];
                    let added = 0, removed = 0;
                    for (const h of hunks) {
                        for (const line of h.lines) {
                            if (line.startsWith('+')) added++;
                            else if (line.startsWith('-')) removed++;
                        }
                    }
                    const summary = `Diff: ${pathA} → ${pathB}\n${hunks.length} hunk(s), +${added} line(s) added, -${removed} line(s) removed\n`;
                    const patch = diffLib.createTwoFilesPatch(pathA, pathB, a, b);
                    const MAX_DIFF = 8000;
                    const budget = MAX_DIFF - summary.length;
                    if (patch.length <= budget) {
                        return { result: summary + patch };
                    }
                    const truncated = patch.slice(0, budget);
                    const lastNewline = truncated.lastIndexOf('\n');
                    return { result: summary + truncated.slice(0, lastNewline) + `\n... (diff truncated, ${patch.length - budget} more bytes)` };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'appendFile': {
                const approved = await requestPermission(res, 'appendFile', scopedArgs, 'medium', sessionPermissions);
                if (!approved) return { result: 'User denied', error: true };
                if (!isPathAllowed(scopedArgs.path)) return { result: 'Path not allowed', error: true };
                try {
                    const previous = fs.existsSync(scopedArgs.path) ? fs.readFileSync(scopedArgs.path, 'utf8') : '';
                    fs.mkdirSync(path.dirname(scopedArgs.path), { recursive: true });
                    fs.appendFileSync(scopedArgs.path, scopedArgs.content || '', 'utf8');
                    if (toolCache) toolCache.invalidatePath(scopedArgs.path);
                    const updated = fs.readFileSync(scopedArgs.path, 'utf8');
                    return {
                        result: 'Appended to: ' + scopedArgs.path,
                        diffPreview: createFileDiffPreview(scopedArgs.path, previous, updated),
                        diffPath: scopedArgs.path,
                    };
                } catch (e) { return { result: 'Error: ' + e.message, error: true }; }
            }
            case 'loadSkill': {
                const loadedSkills = skillsModule.loadedSkills;
                const skill = loadedSkills.find(s => s.name === args.name);
                if (!skill) return { result: `Skill "${args.name}" not found. Available: ${loadedSkills.map(s => s.name).join(', ') || 'none'}`, error: true };
                try {
                    const md = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
                    return { result: md.replace(/^---[\s\S]*?---\n/, '') };
                } catch (e) { return { result: 'Error reading skill: ' + e.message, error: true }; }
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

async function runShellTool(cmd, cwd) {
    return new Promise((resolve) => {
        let out = '', err = '';
        const proc = spawn(cmd, { shell: true, timeout: 30000, cwd: cwd || process.cwd() });
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { err += d; });
        proc.on('close', () => resolve({ result: (out + err).slice(0, 4000) || '(no output)' }));
        proc.on('error', e => resolve({ result: 'Error: ' + e.message, error: true }));
    });
}

// POST /api/agent/permission — resolve a pending permission request
// scope: 'once' (default) | 'session' (blanket for this tool) | 'path' (same directory)
function handleAgentPermission(req, res) {
    const { id, approved, scope = 'once' } = req.body || {};
    const pending = pendingPermissions.get(id);
    if (!pending) return res.status(404).json({ error: 'No pending permission with that id' });
    pending.resolve(!!approved, scope);
    res.json({ ok: true });
}

function handleAgentPlan(req, res) {
    const { id, approved, scope = 'once' } = req.body || {};
    const pending = pendingPlanApprovals.get(id);
    if (!pending) return res.status(404).json({ error: 'No pending plan with that id' });
    pending.resolve(!!approved, scope);
    res.json({ ok: true, plan: pending.plan });
}

// GET /api/agent/config — return current agent config
function handleAgentConfigGet(req, res) {
    res.json({ maxSteps: agentMaxSteps, allowedDirs: agentAllowedDirs, blockedPaths: agentBlockedPaths, toolPermissions: agentToolPermissions });
}

// POST /api/agent/config — update agent config
function handleAgentConfigPost(req, res) {
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
}

// Getter for agentMaxSteps (primitive — not live-exported)
function getAgentMaxSteps() { return agentMaxSteps; }
// Getter for agentAllowedDirs (array — live reference, but getter provided for consistency)
function getAgentAllowedDirs() { return agentAllowedDirs; }
// Getter for agentBlockedPaths
function getAgentBlockedPaths() { return agentBlockedPaths; }

module.exports = {
    agentAllowedDirs,
    ALWAYS_BLOCKED_PATHS,
    agentBlockedPaths,
    agentToolPermissions,
    pendingPermissions,
    pendingPlanApprovals,
    PLAN_GATED_TOOLS,
    buildToolPlan: getPlanToolEntry,
    buildExecutionPlan,
    generatePermissionId,
    isPathAllowed,
    ensureAllowedPath,
    isPathInsideWorkspace,
    AGENT_TOOLS,
    getEnabledTools,
    requestPermission,
    requestPlanApproval,
    executeTool,
    runCodeTool,
    runShellTool,
    extractCommandPaths,
    validateShellCommandForWorkspace,
    handleAgentPermission,
    handleAgentPlan,
    handleAgentConfigGet,
    handleAgentConfigPost,
    getAgentMaxSteps,
    getAgentAllowedDirs,
    getAgentBlockedPaths,
    createToolCache,
};
