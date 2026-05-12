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

    const waitingPlan = agentRuns.createRun({ model: 'test-model' });
    agentRuns.updateRun(waitingPlan.id, {
        status: 'waiting_permission',
        pendingPlan: {
            id: 'plan-1',
            summary: 'Run tests and inspect failures',
            actions: [{ tool: 'runShell', commands: ['npm test'], files: [] }],
        }
    });

    const paused = agentRuns.createRun({ model: 'test-model' });
    agentRuns.updateRun(paused.id, { status: 'paused', canResume: true, pauseReason: 'max_steps' });

    const completed = agentRuns.createRun({ model: 'test-model' });
    agentRuns.updateRun(completed.id, { status: 'completed' });

    const parameterized = agentRuns.createRun({
        model: 'parameter-model',
        backend: 'ollama',
        messages: [{ role: 'user', content: 'use these params' }],
        options: { temperature: 0.2, top_p: 0.75, num_predict: 321, num_ctx: 4096 },
        think: true,
    });
    const parameterizedAfter = agentRuns.getRun(parameterized.id);
    assert.deepStrictEqual(parameterizedAfter.requestBody.options, {
        temperature: 0.2,
        top_p: 0.75,
        num_predict: 321,
        num_ctx: 4096,
    });
    assert.strictEqual(parameterizedAfter.requestBody.think, true);

    const recovered = agentRuns.recoverInterruptedRuns('Recovered in test');
    const recoveredIds = new Set(recovered.map(run => run.id));

    assert(recoveredIds.has(running.id), 'running run should be marked interrupted');
    assert(recoveredIds.has(waiting.id), 'waiting_permission run should be marked interrupted');
    assert(recoveredIds.has(waitingPlan.id), 'waiting plan run should be marked interrupted');
    assert(!recoveredIds.has(paused.id), 'paused run should not be modified');
    assert(!recoveredIds.has(completed.id), 'completed run should not be modified');

    const runningAfter = agentRuns.getRun(running.id);
    assert.strictEqual(runningAfter.status, 'interrupted');
    assert.strictEqual(runningAfter.canResume, true);
    assert.strictEqual(runningAfter.pauseReason, 'interrupted');
    assert.strictEqual(runningAfter.interruptedFromStatus, 'running');

    const waitingAfter = agentRuns.getRun(waiting.id);
    assert.strictEqual(waitingAfter.status, 'interrupted');
    assert.strictEqual(waitingAfter.interruptedFromStatus, 'waiting_permission');
    assert.deepStrictEqual(waitingAfter.pendingPermission, { id: 'perm-1', tool: 'writeFile' });

    const waitingPlanAfter = agentRuns.getRun(waitingPlan.id);
    assert.strictEqual(waitingPlanAfter.status, 'interrupted');
    assert.strictEqual(waitingPlanAfter.interruptedFromStatus, 'waiting_permission');
    assert.strictEqual(waitingPlanAfter.pendingPlan?.id, 'plan-1');
    assert.strictEqual(waitingPlanAfter.pendingPlan?.summary, 'Run tests and inspect failures');

    const pausedAfter = agentRuns.getRun(paused.id);
    assert.strictEqual(pausedAfter.status, 'paused');
    assert.strictEqual(pausedAfter.healthStatus, 'paused_max_steps');

    const completedAfter = agentRuns.getRun(completed.id);
    assert.strictEqual(completedAfter.status, 'completed');
    assert.strictEqual(completedAfter.healthStatus, 'completed');

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
