const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    buildAgentModelRequestBody,
    buildModelCallErrorDiagnostics,
    buildModelStepDiagnostics,
    extractResponseDetails,
    summarizeDiagnostics,
} = require('../proxy/agent-diagnostics');

try {
    const empty = buildModelStepDiagnostics({
        backend: 'ollama',
        model: 'empty-model',
        step: 1,
        elapsedMs: 42,
        requestBody: { model: 'empty-model', stream: false, options: { temperature: 0.2 }, tools: [] },
        response: { message: { content: '' }, done_reason: 'stop' },
    });
    assert.strictEqual(empty.response.hasContent, false);
    assert.strictEqual(empty.response.hasThinking, false);
    assert.strictEqual(empty.response.hasToolCalls, false);
    assert.strictEqual(empty.response.doneReason, 'stop');

    const reasoningOnly = buildModelStepDiagnostics({
        backend: 'ollama',
        model: 'thinking-model',
        step: 1,
        elapsedMs: 83,
        requestBody: { model: 'thinking-model', stream: false, think: true },
        response: { message: { content: '', thinking: 'I should reason but never answer.' }, done_reason: 'length' },
    });
    assert.strictEqual(reasoningOnly.response.hasContent, false);
    assert.strictEqual(reasoningOnly.response.hasThinking, true);
    assert.strictEqual(reasoningOnly.response.doneReason, 'length');

    const rawThinkOnly = extractResponseDetails({
        message: { content: '<think>I should not be final output.</think>' },
        done_reason: 'stop',
    }, 'ollama');
    assert.strictEqual(rawThinkOnly.content, '');
    assert.match(rawThinkOnly.thinking, /I should not be final output/);

    const llamaReasoningOnly = buildModelStepDiagnostics({
        backend: 'llamacpp',
        model: 'qwen3.gguf',
        step: 1,
        elapsedMs: 51,
        requestBody: { model: 'qwen3.gguf', stream: false },
        response: {
            choices: [{
                finish_reason: 'length',
                message: { content: '', reasoning_content: 'I should reason but never answer.' },
            }],
        },
    });
    assert.strictEqual(llamaReasoningOnly.response.hasContent, false);
    assert.strictEqual(llamaReasoningOnly.response.hasThinking, true);
    assert.strictEqual(llamaReasoningOnly.response.finishReason, 'length');

    const timeout = buildModelCallErrorDiagnostics({
        backend: 'ollama',
        model: 'slow-model',
        step: 1,
        elapsedMs: 120001,
        requestBody: { model: 'slow-model', stream: false },
        error: new Error('Ollama tool call timed out after 120s'),
    });
    assert.strictEqual(timeout.response.timedOut, true);
    assert.strictEqual(timeout.response.hasContent, false);

    const malformed = buildModelStepDiagnostics({
        backend: 'llamacpp',
        model: 'tool-model',
        step: 2,
        elapsedMs: 19,
        requestBody: { model: 'tool-model', stream: false, tools: [{ function: { name: 'readFile' } }] },
        response: {
            choices: [{
                finish_reason: 'tool_calls',
                message: {
                    tool_calls: [{
                        id: 'call_bad',
                        type: 'function',
                        function: { name: 'readFile', arguments: '{"path":' },
                    }],
                },
            }],
        },
    });
    assert.strictEqual(malformed.response.hasToolCalls, true);
    assert.strictEqual(malformed.response.rawParseError, true);
    assert.strictEqual(malformed.response.malformedToolCalls.length, 1);

    const ollamaBody = buildAgentModelRequestBody({
        backend: 'ollama',
        model: 'qwen3',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'readFile' } }],
        options: { temperature: 0.15, top_p: 0.8, num_predict: 256, num_ctx: 8192 },
        think: true,
    });
    assert.strictEqual(ollamaBody.think, true);
    assert.deepStrictEqual(ollamaBody.options, { temperature: 0.15, top_p: 0.8, num_predict: 256, num_ctx: 8192 });

    const llamaBody = buildAgentModelRequestBody({
        backend: 'llamacpp',
        model: 'local.gguf',
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }],
        tools: [],
        options: { temperature: 0.25, top_p: 0.7, num_predict: 128, repeat_penalty: 1.05 },
    });
    assert.strictEqual(llamaBody.max_tokens, 128);
    assert.strictEqual(llamaBody.temperature, 0.25);
    assert.strictEqual(llamaBody.repeat_penalty, 1.05);
    assert.strictEqual(llamaBody.messages[0].tool_call_id, 'call_1');

    const fixtureRoot = path.join(__dirname, 'fixtures', 'agent-runs');
    const fixtureCases = fs.readdirSync(fixtureRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
    assert(fixtureCases.length >= 4, 'expected persisted sample agent run fixtures');
    for (const entry of fixtureCases) {
        const runPath = path.join(fixtureRoot, entry.name, 'run.json');
        const eventsPath = path.join(fixtureRoot, entry.name, 'events.ndjson');
        assert(fs.existsSync(runPath), `${entry.name} should include run.json`);
        assert(fs.existsSync(eventsPath), `${entry.name} should include events.ndjson`);
        const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
        if (entry.name === 'empty-response') {
            assert.notStrictEqual(run.status, 'completed', 'empty response fixture should not be completed');
            assert.strictEqual(run.status, 'paused');
            assert.strictEqual(run.canResume, true);
            assert.strictEqual(run.pauseReason, 'empty_model_response');
        }
        if (entry.name === 'reasoning-only') {
            assert.notStrictEqual(run.status, 'completed', 'reasoning-only fixture should not be completed');
            assert.strictEqual(run.status, 'paused');
            assert.strictEqual(run.canResume, true);
            assert.strictEqual(run.pauseReason, 'reasoning_only_response');
        }
        const events = fs.readFileSync(eventsPath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line));
        assert(summarizeDiagnostics(events).modelSteps >= 1, `${entry.name} should include diagnostics`);
    }

    const summary = summarizeDiagnostics([empty, reasoningOnly, llamaReasoningOnly, timeout, malformed]);
    assert.strictEqual(summary.emptyResponses, 1);
    assert.strictEqual(summary.reasoningOnlyResponses, 2);
    assert.strictEqual(summary.timeouts, 1);
    assert.strictEqual(summary.malformedToolCallResponses, 1);

    console.log('agent-diagnostics: ok');
} catch (err) {
    console.error('agent-diagnostics: failed');
    console.error(err);
    process.exitCode = 1;
}
