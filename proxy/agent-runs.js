const fs = require('fs');
const path = require('path');

const RUN_DIR = path.join(process.env.USER_DATA_PATH || process.cwd(), 'agent-runs');

function ensureRunDir() {
    fs.mkdirSync(RUN_DIR, { recursive: true });
}

function generateRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getRunDir(runId) {
    ensureRunDir();
    return path.join(RUN_DIR, runId);
}

function getRunMetaPath(runId) {
    return path.join(getRunDir(runId), 'run.json');
}

function getRunEventsPath(runId) {
    return path.join(getRunDir(runId), 'events.ndjson');
}

function createRun(body = {}) {
    const runId = generateRunId();
    const now = Date.now();
    const record = {
        id: runId,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        conversationId: body.conversationId || null,
        model: body.model || null,
        backend: body.backend || 'ollama',
        maxSteps: body.maxSteps || null,
        workspaceRoot: body.workspaceRoot || null,
        yoloMode: body.yoloMode === true,
        pendingPermission: null,
        pendingPlan: null,
        approvedPlans: [],
        filesTouched: [],
        lastError: null,
        latestMessages: Array.isArray(body.messages) ? body.messages : [],
        requestBody: body,
    };
    const dir = getRunDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getRunMetaPath(runId), JSON.stringify(record, null, 2), 'utf8');
    fs.writeFileSync(getRunEventsPath(runId), '', 'utf8');
    return record;
}

function getRun(runId) {
    try {
        return JSON.parse(fs.readFileSync(getRunMetaPath(runId), 'utf8'));
    } catch {
        return null;
    }
}

function updateRun(runId, updates = {}) {
    const current = getRun(runId);
    if (!current) return null;
    const next = {
        ...current,
        ...updates,
        updatedAt: Date.now(),
    };
    fs.writeFileSync(getRunMetaPath(runId), JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function appendRunEvent(runId, event) {
    const payload = {
        timestamp: Date.now(),
        ...event,
    };
    fs.appendFileSync(getRunEventsPath(runId), JSON.stringify(payload) + '\n', 'utf8');
    return payload;
}

function listRuns(limit = 30) {
    ensureRunDir();
    const entries = fs.readdirSync(RUN_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => getRun(entry.name))
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return entries.slice(0, limit);
}

function readRunEvents(runId) {
    try {
        const raw = fs.readFileSync(getRunEventsPath(runId), 'utf8');
        return raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

module.exports = {
    createRun,
    getRun,
    updateRun,
    appendRunEvent,
    listRuns,
    readRunEvents,
};
