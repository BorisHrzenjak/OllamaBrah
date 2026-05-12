const fs = require('fs');
const path = require('path');

const RUN_DIR = path.join(process.env.USER_DATA_PATH || process.cwd(), 'agent-runs');
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting_permission']);

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
        healthStatus: 'queued',
        createdAt: now,
        updatedAt: now,
        conversationId: body.conversationId || null,
        model: body.model || null,
        backend: body.backend || 'ollama',
        maxSteps: body.maxSteps || null,
        maxComputeSteps: body.maxComputeSteps || body.maxSteps || null,
        executionPolicy: body.executionPolicy || 'run_until_blocked',
        autoResumeOnRestart: body.autoResumeOnRestart !== false,
        stepBudget: body.stepBudget || body.maxSteps || null,
        stepsCompleted: body.stepsCompleted || 0,
        lastStep: body.lastStep || 0,
        workspaceRoot: body.workspaceRoot || null,
        yoloMode: body.yoloMode === true,
        canResume: body.canResume === true,
        pauseReason: body.pauseReason || null,
        interruptionReason: body.interruptionReason || null,
        pendingPermission: null,
        pendingPlan: null,
        sessionPermissionGrants: Array.isArray(body.sessionPermissionGrants) ? body.sessionPermissionGrants : [],
        permissionDecisions: Array.isArray(body.permissionDecisions) ? body.permissionDecisions : [],
        approvedPlans: Array.isArray(body.approvedPlans) ? body.approvedPlans : [],
        filesTouched: Array.isArray(body.filesTouched) ? body.filesTouched : [],
        lastError: null,
        startedAt: body.startedAt || null,
        completedAt: body.completedAt || null,
        resumedFromRunId: body.resumedFromRunId || body.parentRunId || null,
        interruptedFromStatus: body.interruptedFromStatus || null,
        resumeCount: parseInt(body.resumeCount, 10) || 0,
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

function deriveRunHealthStatus(record = {}) {
    if (record.status === 'paused') {
        if (record.pauseReason === 'empty_model_response') return 'paused_empty_response';
        if (record.pauseReason === 'reasoning_only_response') return 'paused_reasoning_only';
        if (record.pauseReason === 'model_timeout') return 'paused_timeout';
        return `paused_${record.pauseReason || 'unknown'}`;
    }
    if (record.status === 'failed') {
        return record.backendFailure === true ? 'failed_backend' : 'failed';
    }
    return record.status || 'queued';
}

function updateRun(runId, updates = {}) {
    const current = getRun(runId);
    if (!current) return null;
    const next = {
        ...current,
        ...updates,
        updatedAt: Date.now(),
    };
    if (!Object.prototype.hasOwnProperty.call(updates, 'healthStatus')) {
        next.healthStatus = deriveRunHealthStatus(next);
    }
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

function trimTrailingDoneEvents(runId) {
    try {
        const events = readRunEvents(runId);
        while (events.length && events[events.length - 1]?.type === 'done') {
            events.pop();
        }
        const serialized = events.map(event => JSON.stringify(event)).join('\n');
        fs.writeFileSync(getRunEventsPath(runId), serialized ? `${serialized}\n` : '', 'utf8');
        return events;
    } catch {
        return null;
    }
}

function recoverInterruptedRuns(reason = 'Run interrupted because the app stopped before it finished.') {
    ensureRunDir();
    const recovered = [];
    const entries = fs.readdirSync(RUN_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory());

    for (const entry of entries) {
        const run = getRun(entry.name);
        if (!run || !ACTIVE_RUN_STATUSES.has(run.status)) continue;

        const updated = updateRun(run.id, {
            status: 'interrupted',
            canResume: true,
            pauseReason: 'interrupted',
            interruptionReason: reason,
            interruptedFromStatus: run.status,
            pendingPermission: run.pendingPermission || null,
            pendingPlan: run.pendingPlan || null,
        });
        appendRunEvent(run.id, {
            type: 'interrupted',
            text: reason,
            resumable: true,
        });
        appendRunEvent(run.id, { type: 'done' });
        if (updated) recovered.push(updated);
    }

    return recovered;
}

module.exports = {
    ACTIVE_RUN_STATUSES,
    createRun,
    getRun,
    updateRun,
    appendRunEvent,
    listRuns,
    readRunEvents,
    trimTrailingDoneEvents,
    recoverInterruptedRuns,
};
