const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-empty-response-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const {
    decideNoToolResponseAction,
    buildEmptyModelResponseEvent,
    buildEmptyResponseRetryMessages,
} = require('../proxy/llm');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

try {
    assert.strictEqual(
        decideNoToolResponseAction({ content: '', thinking: '', toolCalls: null, emptyRetryAttempted: false }),
        'retry_empty_response',
        'first empty no-tool response should retry instead of completing'
    );
    assert.strictEqual(
        decideNoToolResponseAction({ content: '   ', thinking: '', toolCalls: [], emptyRetryAttempted: true }),
        'pause_empty_response',
        'empty response after retry should pause instead of completing'
    );
    assert.notStrictEqual(
        decideNoToolResponseAction({ content: '', thinking: '', toolCalls: [], emptyRetryAttempted: true }),
        'complete',
        'empty response after retry must not be treated as completed'
    );
    assert.strictEqual(
        decideNoToolResponseAction({ content: 'Done.', thinking: '', toolCalls: [], emptyRetryAttempted: false }),
        'complete'
    );
    assert.strictEqual(
        decideNoToolResponseAction({ content: '', thinking: '', toolCalls: [{ name: 'readFile', args: {} }], emptyRetryAttempted: false }),
        'use_tools'
    );

    const retryMessages = buildEmptyResponseRetryMessages([{ role: 'user', content: 'hello' }]);
    assert.strictEqual(retryMessages.length, 2);
    assert.match(retryMessages[1].content, /previous model response was empty/i);
    assert.match(retryMessages[1].content, /concise final answer/i);

    const event = buildEmptyModelResponseEvent({
        model: 'empty-model',
        backend: 'ollama',
        step: 2,
        elapsedMs: 41.6,
        details: { finishReason: 'stop', doneReason: 'stop' },
        retryAttempted: true,
        canResume: true,
    });
    assert.strictEqual(event.type, 'empty_model_response');
    assert.strictEqual(event.model, 'empty-model');
    assert.strictEqual(event.backend, 'ollama');
    assert.strictEqual(event.step, 2);
    assert.strictEqual(event.elapsedMs, 42);
    assert.strictEqual(event.finishReason, 'stop');
    assert.strictEqual(event.doneReason, 'stop');
    assert.strictEqual(event.retryAttempted, true);
    assert.strictEqual(event.canResume, true);
    assert.strictEqual(event.text, 'Model returned an empty response.');

    console.log('agent-empty-response: ok');
} catch (err) {
    console.error('agent-empty-response: failed');
    console.error(err);
    process.exitCode = 1;
} finally {
    cleanup();
}
