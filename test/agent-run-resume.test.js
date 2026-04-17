const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-run-resume-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const { buildResumeRunBody } = require('../proxy/llm');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

try {
    const existing = {
        id: 'run_existing',
        createdAt: 1000,
        startedAt: 2000,
        maxComputeSteps: 20,
        stepsCompleted: 12,
        executionPolicy: 'pause_on_limit',
        autoResumeOnRestart: true,
        latestMessages: [
            { role: 'user', content: 'fix the tests' },
            { role: 'assistant', content: 'Working on it.' },
        ],
        requestBody: {
            messages: [{ role: 'user', content: 'original request' }],
            model: 'test-model',
            backend: 'ollama',
        },
        sessionPermissionGrants: ['runShell'],
        approvedPlans: [{ id: 'plan-1', approved: true }],
        filesTouched: ['src/app.js'],
        resumedFromRunId: 'run_parent',
        resumeCount: 2,
        lastStep: 12,
    };

    const body = buildResumeRunBody(existing, { extendBudgetBy: 5 });

    assert(body, 'buildResumeRunBody should return a body');
    assert.strictEqual(body.model, 'test-model');
    assert.strictEqual(body.backend, 'ollama');
    assert.strictEqual(body.maxComputeSteps, 20, 'extendBudgetBy should never shrink the total compute budget');
    assert.strictEqual(body.executionPolicy, 'pause_on_limit');
    assert.strictEqual(body.autoResumeOnRestart, true);
    assert.deepStrictEqual(body.continueFrom, existing.latestMessages);
    assert.strictEqual(body.resumedFromRunId, 'run_parent');
    assert.deepStrictEqual(body.sessionPermissionGrants, ['runShell']);
    assert.deepStrictEqual(body.approvedPlans, [{ id: 'plan-1', approved: true }]);
    assert.deepStrictEqual(body.filesTouched, ['src/app.js']);
    assert.strictEqual(body.stepsCompleted, 12);
    assert.strictEqual(body.lastStep, 12);
    assert.strictEqual(body.startedAt, 2000);
    assert.strictEqual(body.resumeCount, 2);

    console.log('agent-run-resume: ok');
} catch (err) {
    console.error('agent-run-resume: failed');
    console.error(err);
    process.exitCode = 1;
} finally {
    cleanup();
}
