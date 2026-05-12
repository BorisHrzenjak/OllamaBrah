const assert = require('assert');

process.env.AGENT_AUTO_RESUME_INTERRUPTED_RUNS = '0';

const {
    detectAgentModelCapabilities,
    buildAgentModelCapabilitiesEvent,
    buildPostToolFinalAnswerGuardMessage,
} = require('../proxy/llm');

try {
    const embedding = detectAgentModelCapabilities({ model: 'nomic-embed-text', backend: 'ollama' });
    assert.strictEqual(embedding.supportsToolCalls, false);
    assert.strictEqual(embedding.agentModeAllowed, false);

    const qwen = detectAgentModelCapabilities({ model: 'qwen3:14b', backend: 'ollama' });
    assert.strictEqual(qwen.reasoningModelLikely, true);
    assert.strictEqual(qwen.agentModeAllowed, true);
    assert(qwen.warnings.some(w => /reasoning model/i.test(w)));

    const event = buildAgentModelCapabilitiesEvent(qwen);
    assert.strictEqual(event.type, 'agent_model_capabilities');
    assert.strictEqual(event.supportsToolCalls, true);
    assert(Array.isArray(event.warnings));

    const guard = buildPostToolFinalAnswerGuardMessage();
    assert.strictEqual(guard.role, 'user');
    assert(/final answer/i.test(guard.content));
    assert(/tool results/i.test(guard.content));

    console.log('agent-capabilities: ok');
} catch (err) {
    console.error('agent-capabilities: failed');
    console.error(err);
    process.exitCode = 1;
}
