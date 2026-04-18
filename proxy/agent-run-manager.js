const {
    createRun,
    getRun,
    listRuns,
    readRunEvents,
    trimTrailingDoneEvents,
    recoverInterruptedRuns,
} = require('./agent-runs');
const { abortPendingInteractionsForRun } = require('./tools');

const activeAgentRuns = new Map();

let executeRunHandler = null;
let fatalRunErrorHandler = null;

function configureAgentRunManager({ executeRun, onFatalError } = {}) {
    executeRunHandler = executeRun;
    fatalRunErrorHandler = onFatalError;
}

function ensureConfigured() {
    if (typeof executeRunHandler !== 'function') {
        throw new Error('Agent run manager is not configured with an executeRun handler.');
    }
}

function writeNdjson(res, payload) {
    if (!res || res.writableEnded || res.destroyed) return;
    res.write(JSON.stringify(payload) + '\n');
}

function publishRunEvent(runId, payload) {
    const active = activeAgentRuns.get(runId);
    if (!active) return;
    const subscribers = [...active.subscribers];
    for (const subscriber of subscribers) {
        writeNdjson(subscriber, payload);
    }
    if (payload?.type === 'done') {
        active.terminal = true;
        for (const subscriber of subscribers) {
            if (!subscriber.writableEnded && !subscriber.destroyed) {
                subscriber.end();
            }
        }
        active.subscribers.clear();
    }
}

function isRunCancelled(runId) {
    return activeAgentRuns.get(runId)?.cancelled === true;
}

function isRunActive(runId) {
    return activeAgentRuns.has(runId);
}

function clearActiveRun(runId) {
    activeAgentRuns.delete(runId);
}

function scheduleRun(runId, body = {}) {
    ensureConfigured();
    setImmediate(() => {
        executeRunHandler(runId, body).catch(err => {
            try {
                if (typeof fatalRunErrorHandler === 'function') {
                    fatalRunErrorHandler(runId, err, body);
                }
            } finally {
                clearActiveRun(runId);
            }
        });
    });
}

function startAgentRun(body = {}) {
    const run = createRun(body);
    activeAgentRuns.set(run.id, { subscribers: new Set(), cancelled: false, terminal: false });
    scheduleRun(run.id, body);
    return getRun(run.id);
}

function resumeAgentRun(runId, body = {}, options = {}) {
    if (options.trimDoneEvents !== false) {
        trimTrailingDoneEvents(runId);
    }
    activeAgentRuns.set(runId, { subscribers: new Set(), cancelled: false, terminal: false });
    scheduleRun(runId, body);
    return getRun(runId);
}

function attachRunStream(runId, res) {
    const run = getRun(runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const after = Math.max(0, parseInt(res.req?.query?.after, 10) || 0);

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const events = readRunEvents(runId);
    for (const event of events.slice(after)) {
        const { timestamp, ...payload } = event;
        writeNdjson(res, payload);
    }

    const active = activeAgentRuns.get(runId);
    if (active?.terminal) return res.end();
    if (!active) return res.end();

    active.subscribers.add(res);
    res.once('close', () => {
        activeAgentRuns.get(runId)?.subscribers.delete(res);
    });
}

function cancelActiveRun(runId, reason = 'Run cancelled by user.') {
    const active = activeAgentRuns.get(runId);
    if (!active) return { active: false, abortedInteractions: 0 };
    active.cancelled = true;
    return {
        active: true,
        abortedInteractions: abortPendingInteractionsForRun(runId, reason),
    };
}

function recoverAgentRunsOnStartup({ shouldAutoResume, createResumeBody } = {}) {
    const recovered = recoverInterruptedRuns();
    for (const run of recovered) {
        if (typeof shouldAutoResume === 'function' && !shouldAutoResume(run)) continue;
        try {
            const body = typeof createResumeBody === 'function'
                ? createResumeBody(run)
                : (run.requestBody || {});
            resumeAgentRun(run.id, body);
            console.log(`[AgentRun] Auto-resumed run ${run.id} after restart.`);
        } catch (err) {
            console.warn(`[AgentRun] Failed to auto-resume run ${run.id}: ${err.message}`);
        }
    }
    return recovered;
}

module.exports = {
    configureAgentRunManager,
    publishRunEvent,
    isRunCancelled,
    isRunActive,
    clearActiveRun,
    startAgentRun,
    resumeAgentRun,
    attachRunStream,
    cancelActiveRun,
    recoverAgentRunsOnStartup,
    listRuns,
    getRun,
};
