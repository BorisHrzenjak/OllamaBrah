const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-streaming-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;
process.env.AGENT_MODEL_CONNECTION_TIMEOUT_MS = '5000';
process.env.AGENT_MODEL_FIRST_TOKEN_TIMEOUT_MS = '5000';
process.env.AGENT_MODEL_INACTIVITY_TIMEOUT_MS = '5000';
process.env.AGENT_MODEL_MAX_STEP_MS = '10000';

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

function readBody(req) {
    return new Promise(resolve => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => resolve(raw));
    });
}

(async () => {
    let ollamaRequest = null;
    let llamaRequest = null;

    const ollamaServer = http.createServer(async (req, res) => {
        if (req.url === '/api/tags') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
            return;
        }
        if (req.url === '/api/chat') {
            ollamaRequest = JSON.parse(await readBody(req));
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
            res.write(JSON.stringify({ message: { thinking: 'plan ' }, done: false }) + '\n');
            res.write(JSON.stringify({ message: { content: 'Hel' }, done: false }) + '\n');
            res.write(JSON.stringify({ message: { content: 'lo' }, done: false }) + '\n');
            res.end(JSON.stringify({ done: true, done_reason: 'stop' }) + '\n');
            return;
        }
        res.writeHead(404);
        res.end();
    });

    const llamaServer = http.createServer(async (req, res) => {
        if (req.url === '/v1/chat/completions') {
            llamaRequest = JSON.parse(await readBody(req));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"Result"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"readFile","arguments":"{\\"path\\":\\"todo.md\\"}"}}]}}]}\n\n');
            res.write('data: {"choices":[{"finish_reason":"tool_calls","delta":{}}]}\n\n');
            res.end('data: [DONE]\n\n');
            return;
        }
        res.writeHead(404);
        res.end();
    });

    try {
        const ollamaPort = await listen(ollamaServer);
        const llamaPort = await listen(llamaServer);
        process.env.OLLAMA_API_BASE_URL = `http://127.0.0.1:${ollamaPort}`;
        process.env.LLAMACPP_PORT = String(llamaPort);

        const {
            callOllamaWithTools,
            callLlamaCppWithTools,
        } = require('../proxy/llm');
        const { extractResponseDetails } = require('../proxy/agent-diagnostics');

        const ollamaDeltas = [];
        const ollamaResponse = await callOllamaWithTools(
            [{ role: 'user', content: 'hello' }],
            [],
            'stream-model',
            { onStream: delta => ollamaDeltas.push(delta) }
        );
        const ollamaDetails = extractResponseDetails(ollamaResponse, 'ollama');
        assert.strictEqual(ollamaRequest.stream, true);
        assert.strictEqual(ollamaDetails.content, 'Hello');
        assert.strictEqual(ollamaDetails.thinking, 'plan ');
        assert.deepStrictEqual(ollamaDeltas.filter(d => d.type === 'content_delta').map(d => d.text), ['Hel', 'lo']);
        assert.strictEqual(ollamaDeltas.some(d => d.type === 'thinking_delta'), true);

        const llamaDeltas = [];
        const llamaResponse = await callLlamaCppWithTools(
            [{ role: 'user', content: 'read todo' }],
            [{ type: 'function', function: { name: 'readFile' } }],
            'local.gguf',
            { onStream: delta => llamaDeltas.push(delta) }
        );
        const llamaDetails = extractResponseDetails(llamaResponse, 'llamacpp');
        assert.strictEqual(llamaRequest.stream, true);
        assert.strictEqual(llamaDetails.content, 'Result');
        assert.strictEqual(llamaDetails.thinking, 'think ');
        assert.strictEqual(llamaDetails.toolCalls.length, 1);
        assert.strictEqual(llamaDetails.toolCalls[0].name, 'readFile');
        assert.deepStrictEqual(llamaDetails.toolCalls[0].args, { path: 'todo.md' });
        assert.strictEqual(llamaDeltas.some(d => d.type === 'tool_call_delta'), true);

        console.log('agent-streaming-model-calls: ok');
    } catch (err) {
        console.error('agent-streaming-model-calls: failed');
        console.error(err);
        process.exitCode = 1;
    } finally {
        await close(ollamaServer).catch(() => {});
        await close(llamaServer).catch(() => {});
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        delete process.env.OLLAMA_API_BASE_URL;
        delete process.env.LLAMACPP_PORT;
        delete process.env.AGENT_MODEL_CONNECTION_TIMEOUT_MS;
        delete process.env.AGENT_MODEL_FIRST_TOKEN_TIMEOUT_MS;
        delete process.env.AGENT_MODEL_INACTIVITY_TIMEOUT_MS;
        delete process.env.AGENT_MODEL_MAX_STEP_MS;
    }
})();
