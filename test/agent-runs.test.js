const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-runs-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const agentRuns = require('../proxy/agent-runs');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

try {
    const running = agentRuns.createRun({ model: 'test-model', maxSteps: 9 });
    agentRuns.updateRun(running.id, { status: 'running' });

    const waiting = agentRuns.createRun({ model: 'test-model' });
    agentRuns.updateRun(waiting.id, {
        status: 'waiting_permission',
        pendingPermission: { id: 'perm-1', tool: 'writeFile' }
    });

    const paused = agentRuns.createRun({ model: 'test-model' });
    agentRuns.updateRun(paused.id, { status: 'paused', canResume: true, pauseReason: 'max_steps' });

    const completed = agentRuns.createRun({ model: 'test-model' });
    agentRuns.updateRun(completed.id, { status: 'completed' });

    const recovered = agentRuns.recoverInterruptedRuns('Recovered in test');
    const recoveredIds = new Set(recovered.map(run => run.id));

    assert(recoveredIds.has(running.id), 'running run should be marked interrupted');
    assert(recoveredIds.has(waiting.id), 'waiting_permission run should be marked interrupted');
    assert(!recoveredIds.has(paused.id), 'paused run should not be modified');
    assert(!recoveredIds.has(completed.id), 'completed run should not be modified');

    const runningAfter = agentRuns.getRun(running.id);
    assert.strictEqual(runningAfter.status, 'interrupted');
    assert.strictEqual(runningAfter.canResume, true);
    assert.strictEqual(runningAfter.pauseReason, 'interrupted');
    assert.strictEqual(runningAfter.interruptedFromStatus, 'running');

    const waitingAfter = agentRuns.getRun(waiting.id);
    assert.strictEqual(waitingAfter.status, 'interrupted');
    assert.strictEqual(waitingAfter.pendingPermission, null);
    assert.strictEqual(waitingAfter.interruptedFromStatus, 'waiting_permission');

    const pausedAfter = agentRuns.getRun(paused.id);
    assert.strictEqual(pausedAfter.status, 'paused');

    const completedAfter = agentRuns.getRun(completed.id);
    assert.strictEqual(completedAfter.status, 'completed');

    const recoveredEvents = agentRuns.readRunEvents(running.id);
    assert(recoveredEvents.some(event => event.type === 'interrupted'), 'recovered run should append interrupted event');
    assert(recoveredEvents.some(event => event.type === 'done'), 'recovered run should append done event');

    const resumable = agentRuns.createRun({ model: 'test-model', maxSteps: 5 });
    agentRuns.appendRunEvent(resumable.id, { type: 'status', text: 'Working...' });
    agentRuns.appendRunEvent(resumable.id, { type: 'done' });
    agentRuns.trimTrailingDoneEvents(resumable.id);
    const resumableEvents = agentRuns.readRunEvents(resumable.id);
    assert.strictEqual(resumableEvents.at(-1)?.type, 'status');
    assert(!resumableEvents.some((event, index) => index === resumableEvents.length - 1 && event.type === 'done'), 'trimTrailingDoneEvents should remove terminal done markers');

    console.log('agent-runs: ok');
} catch (err) {
    console.error('agent-runs: failed');
    console.error(err);
    process.exitCode = 1;
} finally {
    cleanup();
}
