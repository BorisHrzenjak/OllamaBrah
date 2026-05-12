const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-model-timeout-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const {
    AgentModelTimeoutError,
    buildAgentModelTimeoutEvent,
    getAgentModelTimeoutConfig,
    isAgentModelTimeoutError,
} = require('../proxy/llm');
const { buildModelCallErrorDiagnostics } = require('../proxy/agent-diagnostics');
const agentRuns = require('../proxy/agent-runs');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AGENT_MODEL_CONNECTION_TIMEOUT_MS;
    delete process.env.AGENT_MODEL_FIRST_TOKEN_TIMEOUT_MS;
    delete process.env.AGENT_MODEL_INACTIVITY_TIMEOUT_MS;
    delete process.env.AGENT_MODEL_MAX_STEP_MS;
}

try {
    process.env.AGENT_MODEL_CONNECTION_TIMEOUT_MS = '1111';
    process.env.AGENT_MODEL_FIRST_TOKEN_TIMEOUT_MS = '2222';
    process.env.AGENT_MODEL_INACTIVITY_TIMEOUT_MS = '3333';
    process.env.AGENT_MODEL_MAX_STEP_MS = '4444';
    assert.deepStrictEqual(getAgentModelTimeoutConfig(), {
        connectionMs: 1111,
        firstTokenMs: 2222,
        inactivityMs: 3333,
        maxStepMs: 4444,
    });
    assert.deepStrictEqual(getAgentModelTimeoutConfig({ firstTokenMs: 9999 }), {
        connectionMs: 1111,
        firstTokenMs: 9999,
        inactivityMs: 3333,
        maxStepMs: 4444,
    });

    const timeoutError = new AgentModelTimeoutError({
        backend: 'Ollama',
        phase: 'inactivity_timeout',
        timeoutMs: 3333,
        elapsedMs: 9876,
        timeouts: getAgentModelTimeoutConfig(),
        partial: {
            content: 'partial answer',
            thinking: 'private reasoning',
            toolCalls: [{ function: { name: 'readFile', arguments: { path: 'todo.md' } } }],
        },
    });
    assert.strictEqual(isAgentModelTimeoutError(timeoutError), true);
    assert.match(timeoutError.message, /stream activity/i);
    assert.strictEqual(timeoutError.timeoutDetails.phase, 'inactivity_timeout');
    assert.strictEqual(timeoutError.timeoutDetails.partial.hasContent, true);
    assert.strictEqual(timeoutError.timeoutDetails.partial.hasThinking, true);
    assert.strictEqual(timeoutError.timeoutDetails.partial.toolCallCount, 1);

    const diagnostics = buildModelCallErrorDiagnostics({
        error: timeoutError,
        backend: 'ollama',
        model: 'slow-model',
        step: 4,
        elapsedMs: 9876,
        requestBody: { model: 'slow-model', stream: true },
    });
    assert.strictEqual(diagnostics.response.timedOut, true);
    assert.strictEqual(diagnostics.response.timeoutPhase, 'inactivity_timeout');
    assert.strictEqual(diagnostics.response.timeoutMs, 3333);
    assert.strictEqual(diagnostics.response.timeoutDetails.partial.content, 'partial answer');

    const event = buildAgentModelTimeoutEvent({
        error: timeoutError,
        backend: 'ollama',
        model: 'slow-model',
        step: 4,
        elapsedMs: 9876,
        canResume: true,
    });
    assert.strictEqual(event.type, 'model_timeout');
    assert.strictEqual(event.timeoutPhase, 'inactivity_timeout');
    assert.strictEqual(event.canResume, true);
    assert.strictEqual(event.timeoutDetails.partial.contentChars, 'partial answer'.length);

    const run = agentRuns.createRun({ model: 'slow-model', backend: 'ollama' });
    agentRuns.updateRun(run.id, {
        status: 'paused',
        canResume: true,
        pauseReason: 'model_timeout',
        timeoutDetails: timeoutError.timeoutDetails,
        partialModelResponse: timeoutError.timeoutDetails.partial,
        lastError: timeoutError.message,
    });
    const updated = agentRuns.getRun(run.id);
    assert.strictEqual(updated.status, 'paused');
    assert.strictEqual(updated.canResume, true);
    assert.strictEqual(updated.pauseReason, 'model_timeout');
    assert.strictEqual(updated.timeoutDetails.phase, 'inactivity_timeout');
    assert.strictEqual(updated.partialModelResponse.content, 'partial answer');

    console.log('agent-model-timeout: ok');
} catch (err) {
    console.error('agent-model-timeout: failed');
    console.error(err);
    process.exitCode = 1;
} finally {
    cleanup();
}
