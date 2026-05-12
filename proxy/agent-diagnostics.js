function compactObject(obj) {
    return Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value !== undefined && value !== null));
}

function sanitizeOptions(options = {}) {
    const out = {};
    for (const [key, value] of Object.entries(options || {})) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = value;
    }
    return out;
}

function mapOptionsForLlamaCpp(options = {}) {
    const clean = sanitizeOptions(options);
    const mapped = {};
    if (clean.temperature !== undefined) mapped.temperature = clean.temperature;
    if (clean.top_p !== undefined) mapped.top_p = clean.top_p;
    if (clean.top_k !== undefined) mapped.top_k = clean.top_k;
    if (clean.repeat_penalty !== undefined) mapped.repeat_penalty = clean.repeat_penalty;
    if (clean.seed !== undefined) mapped.seed = clean.seed;
    if (clean.num_predict !== undefined) mapped.max_tokens = clean.num_predict;
    return mapped;
}

function toOpenAiMessages(messages = []) {
    return messages.map(m => {
        if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.tool_call_id || 'call_0', content: m.content };
        }
        return { role: m.role, content: m.content };
    });
}

function buildAgentModelRequestBody({ backend = 'ollama', model, messages = [], tools = [], options = {}, think } = {}) {
    if (backend === 'llamacpp') {
        return compactObject({
            model,
            messages: toOpenAiMessages(messages),
            tools,
            stream: true,
            ...mapOptionsForLlamaCpp(options),
        });
    }

    return compactObject({
        model,
        messages,
        tools,
        stream: true,
        think: think === true,
        options: Object.keys(sanitizeOptions(options)).length ? sanitizeOptions(options) : undefined,
    });
}

function summarizeRequestBody(body = {}) {
    return compactObject({
        model: body.model || null,
        stream: body.stream === true,
        think: body.think,
        options: body.options,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        top_p: body.top_p,
        top_k: body.top_k,
        repeat_penalty: body.repeat_penalty,
        seed: body.seed,
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
}

function parseThinkBlocks(content) {
    if (typeof content !== 'string') return { thinking: '', contentWithoutThinking: '' };
    let thinking = '';
    const contentWithoutThinking = content.replace(/<\s*think[^>]*>([\s\S]*?)<\/\s*think\s*>/gi, (_match, inner) => {
        thinking += (thinking ? '\n\n' : '') + String(inner || '').trim();
        return '';
    }).trim();
    return { thinking, contentWithoutThinking };
}

function extractResponseDetails(response, backend = 'ollama') {
    const details = {
        content: '',
        thinking: '',
        toolCalls: null,
        malformedToolCalls: [],
        finishReason: null,
        doneReason: null,
        rawParseError: false,
    };

    if (!response || typeof response !== 'object') {
        details.rawParseError = true;
        return details;
    }

    if (backend === 'llamacpp') {
        const choice = Array.isArray(response.choices) ? response.choices[0] : null;
        const message = choice?.message || {};
        details.finishReason = choice?.finish_reason || null;
        details.content = typeof message.content === 'string' ? message.content : '';
        details.thinking = [
            message.reasoning_content,
            message.reasoning,
            response.reasoning_content,
        ].filter(value => typeof value === 'string' && value.trim()).join('\n\n');

        const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (rawToolCalls.length) {
            details.toolCalls = rawToolCalls.map((tc, index) => {
                let args = {};
                const rawArgs = tc?.function?.arguments;
                if (typeof rawArgs === 'string' && rawArgs.trim()) {
                    try {
                        args = JSON.parse(rawArgs);
                    } catch (err) {
                        details.rawParseError = true;
                        details.malformedToolCalls.push({
                            index,
                            id: tc?.id || `call_${index}`,
                            name: tc?.function?.name || null,
                            error: err.message,
                        });
                    }
                } else if (rawArgs && typeof rawArgs === 'object') {
                    args = rawArgs;
                }
                return {
                    id: tc?.id || `call_${index}`,
                    name: tc?.function?.name,
                    args,
                };
            });
        }
    } else {
        const message = response.message || {};
        details.finishReason = response.finish_reason || response.finishReason || null;
        details.doneReason = response.done_reason || response.doneReason || null;
        details.content = typeof message.content === 'string' ? message.content : '';
        details.thinking = [
            message.thinking,
            message.reasoning_content,
            response.reasoning_content,
        ].filter(value => typeof value === 'string' && value.trim()).join('\n\n');

        const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (rawToolCalls.length) {
            details.toolCalls = rawToolCalls.map((tc, index) => {
                const rawArgs = tc?.function?.arguments;
                let args = {};
                if (typeof rawArgs === 'string' && rawArgs.trim()) {
                    try {
                        args = JSON.parse(rawArgs);
                    } catch (err) {
                        details.rawParseError = true;
                        details.malformedToolCalls.push({
                            index,
                            id: `call_${index}`,
                            name: tc?.function?.name || null,
                            error: err.message,
                        });
                    }
                } else if (rawArgs && typeof rawArgs === 'object') {
                    args = rawArgs;
                }
                return {
                    id: `call_${index}`,
                    name: tc?.function?.name,
                    args,
                };
            });
        }
    }

    const fromThinkTags = parseThinkBlocks(details.content);
    if (fromThinkTags.thinking) {
        details.thinking = [details.thinking, fromThinkTags.thinking].filter(Boolean).join('\n\n');
        details.content = fromThinkTags.contentWithoutThinking;
    }

    return details;
}

function buildModelStepDiagnostics({ response, backend, model, step, elapsedMs, requestBody } = {}) {
    const details = extractResponseDetails(response, backend);
    const content = details.content || '';
    const thinking = details.thinking || '';
    const toolCalls = Array.isArray(details.toolCalls) ? details.toolCalls : [];
    return {
        type: 'model_step_diagnostics',
        model: model || null,
        backend: backend || 'ollama',
        step: step || null,
        elapsedMs: Math.max(0, Math.round(elapsedMs || 0)),
        requestOptions: summarizeRequestBody(requestBody || {}),
        response: {
            hasContent: content.trim().length > 0,
            contentChars: content.length,
            hasThinking: thinking.trim().length > 0,
            thinkingChars: thinking.length,
            hasToolCalls: toolCalls.length > 0,
            toolCallCount: toolCalls.length,
            rawParseError: details.rawParseError === true,
            malformedToolCalls: details.malformedToolCalls,
            finishReason: details.finishReason,
            doneReason: details.doneReason,
        },
    };
}

function buildModelCallErrorDiagnostics({ error, backend, model, step, elapsedMs, requestBody } = {}) {
    const message = error?.message || String(error || 'Unknown model error');
    const timeoutDetails = error?.timeoutDetails || null;
    return {
        type: 'model_step_diagnostics',
        model: model || null,
        backend: backend || 'ollama',
        step: step || null,
        elapsedMs: Math.max(0, Math.round(elapsedMs || 0)),
        requestOptions: summarizeRequestBody(requestBody || {}),
        response: {
            hasContent: false,
            contentChars: 0,
            hasThinking: false,
            thinkingChars: 0,
            hasToolCalls: false,
            toolCallCount: 0,
            rawParseError: /bad .*response|parse|json/i.test(message),
            malformedToolCalls: [],
            finishReason: null,
            doneReason: null,
            error: message,
            timedOut: /timed out|timeout/i.test(message),
            timeoutPhase: timeoutDetails?.phase || error?.timeoutPhase || null,
            timeoutMs: timeoutDetails?.timeoutMs || error?.timeoutMs || null,
            timeoutDetails,
        },
    };
}

function summarizeDiagnostics(events = []) {
    const steps = events.filter(event => event?.type === 'model_step_diagnostics');
    return {
        modelSteps: steps.length,
        emptyResponses: steps.filter(event =>
            !event.response?.hasContent &&
            !event.response?.hasThinking &&
            !event.response?.hasToolCalls &&
            !event.response?.error
        ).length,
        reasoningOnlyResponses: steps.filter(event =>
            event.response?.hasThinking &&
            !event.response?.hasContent &&
            !event.response?.hasToolCalls
        ).length,
        malformedToolCallResponses: steps.filter(event => event.response?.rawParseError).length,
        timeouts: steps.filter(event => event.response?.timedOut).length,
        totalElapsedMs: steps.reduce((sum, event) => sum + (parseInt(event.elapsedMs, 10) || 0), 0),
    };
}

module.exports = {
    buildAgentModelRequestBody,
    buildModelCallErrorDiagnostics,
    buildModelStepDiagnostics,
    extractResponseDetails,
    mapOptionsForLlamaCpp,
    sanitizeOptions,
    summarizeDiagnostics,
    summarizeRequestBody,
};
