const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-llamacpp-chat-timeout-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const {
    AgentModelTimeoutError,
    buildLlamaCppChatTerminalChunk,
    getLlamaCppChatTimeoutConfig,
} = require('../proxy/llm');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.USER_DATA_PATH;
    delete process.env.LLAMACPP_CHAT_CONNECTION_TIMEOUT_MS;
    delete process.env.LLAMACPP_CHAT_FIRST_TOKEN_TIMEOUT_MS;
    delete process.env.LLAMACPP_CHAT_INACTIVITY_TIMEOUT_MS;
    delete process.env.LLAMACPP_CHAT_MAX_STREAM_MS;
}

try {
    process.env.LLAMACPP_CHAT_CONNECTION_TIMEOUT_MS = '1111';
    process.env.LLAMACPP_CHAT_FIRST_TOKEN_TIMEOUT_MS = '2222';
    process.env.LLAMACPP_CHAT_INACTIVITY_TIMEOUT_MS = '3333';
    process.env.LLAMACPP_CHAT_MAX_STREAM_MS = '4444';

    const config = getLlamaCppChatTimeoutConfig();
    assert.deepStrictEqual(config, {
        connectionMs: 1111,
        firstTokenMs: 2222,
        inactivityMs: 3333,
        maxStepMs: 4444,
    });

    const timeoutError = new AgentModelTimeoutError({
        backend: 'llama.cpp',
        phase: 'inactivity_timeout',
        timeoutMs: config.inactivityMs,
        elapsedMs: 9876,
        timeouts: config,
        partial: {
            content: 'partial answer',
            thinking: 'reasoning',
        },
    });

    const timeoutChunk = buildLlamaCppChatTerminalChunk({
        model: 'Qwen3.6-27B-Q3_K_M.gguf',
        error: timeoutError,
    });
    assert.strictEqual(timeoutChunk.done, true);
    assert.strictEqual(timeoutChunk.done_reason, 'inactivity_timeout');
    assert.strictEqual(timeoutChunk.doneReason, 'inactivity_timeout');
    assert.match(timeoutChunk.message.content, /stopped sending tokens/i);
    assert.match(timeoutChunk.message.content, /partial response was saved/i);
    assert.strictEqual(timeoutChunk.timeoutDetails.partial.hasContent, true);
    assert.strictEqual(timeoutChunk.timeoutDetails.partial.hasThinking, true);

    const genericChunk = buildLlamaCppChatTerminalChunk({
        model: 'local.gguf',
        error: new Error('socket closed'),
    });
    assert.strictEqual(genericChunk.done, true);
    assert.strictEqual(genericChunk.done_reason, 'error');
    assert.match(genericChunk.message.content, /stream ended with an error/i);
    assert.strictEqual(genericChunk.timeoutDetails, undefined);

    console.log('llamacpp-chat-timeout: ok');
} catch (err) {
    console.error('llamacpp-chat-timeout: failed');
    console.error(err);
    process.exitCode = 1;
} finally {
    cleanup();
}
