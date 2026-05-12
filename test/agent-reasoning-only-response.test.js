const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-reasoning-only-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const {
    decideNoToolResponseAction,
    buildReasoningOnlyResponseEvent,
    buildReasoningOnlyRetryMessages,
} = require('../proxy/llm');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

try {
    assert.strictEqual(
        decideNoToolResponseAction({ content: '', thinking: 'private reasoning', toolCalls: [], reasoningRetryAttempted: false }),
        'retry_reasoning_only',
        'first reasoning-only no-tool response should retry instead of completing'
    );
    assert.strictEqual(
        decideNoToolResponseAction({ content: '', thinking: 'private reasoning', toolCalls: [], reasoningRetryAttempted: true }),
        'pause_reasoning_only',
        'reasoning-only response after retry should pause instead of completing'
    );
    assert.notStrictEqual(
        decideNoToolResponseAction({ content: '', thinking: 'private reasoning', toolCalls: [], reasoningRetryAttempted: true }),
        'complete',
        'reasoning-only response after retry must not be treated as completed'
    );
    assert.strictEqual(
        decideNoToolResponseAction({ content: 'Done.', thinking: 'private reasoning', toolCalls: [], reasoningRetryAttempted: false }),
        'complete'
    );
    assert.strictEqual(
        decideNoToolResponseAction({ content: '', thinking: 'private reasoning', toolCalls: [{ name: 'readFile', args: {} }] }),
        'use_tools'
    );

    const retryMessages = buildReasoningOnlyRetryMessages([{ role: 'user', content: 'hello' }]);
    assert.strictEqual(retryMessages.length, 2);
    assert.match(retryMessages[1].content, /only contained reasoning\/thinking/i);
    assert.match(retryMessages[1].content, /Return only the final answer or a valid tool call/i);
    assert.match(retryMessages[1].content, /Do not continue thinking/i);
    assert(!retryMessages.some(message => /private reasoning/i.test(message.content || '')), 'thinking traces should not be copied into retry context');

    const event = buildReasoningOnlyResponseEvent({
        model: 'thinking-model',
        backend: 'llamacpp',
        step: 3,
        elapsedMs: 83.2,
        details: { finishReason: 'length', doneReason: null },
        retryAttempted: true,
        canResume: true,
    });
    assert.strictEqual(event.type, 'reasoning_only_response');
    assert.strictEqual(event.model, 'thinking-model');
    assert.strictEqual(event.backend, 'llamacpp');
    assert.strictEqual(event.step, 3);
    assert.strictEqual(event.elapsedMs, 83);
    assert.strictEqual(event.finishReason, 'length');
    assert.strictEqual(event.doneReason, null);
    assert.strictEqual(event.retryAttempted, true);
    assert.strictEqual(event.canResume, true);
    assert.strictEqual(event.text, 'Model returned reasoning but no final answer.');

    console.log('agent-reasoning-only-response: ok');
} catch (err) {
    console.error('agent-reasoning-only-response: failed');
    console.error(err);
    process.exitCode = 1;
} finally {
    cleanup();
}
