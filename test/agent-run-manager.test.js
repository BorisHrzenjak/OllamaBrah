const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = path.join(os.tmpdir(), `ollamabrah-agent-run-manager-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });
process.env.USER_DATA_PATH = tmpRoot;

const agentRuns = require('../proxy/agent-runs');
const manager = require('../proxy/agent-run-manager');

function cleanup() {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
    try {
        const executed = [];
        manager.configureAgentRunManager({
            executeRun: async (runId, body) => {
                executed.push({ runId, body });
                await new Promise(() => {});
            },
            onFatalError: () => {
                throw new Error('fatal handler should not be called in this test');
            },
        });

        const run = manager.startAgentRun({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] });
        await delay(20);

        assert.strictEqual(executed.length, 1);
        assert.strictEqual(executed[0].runId, run.id);
        assert.strictEqual(executed[0].body.model, 'test-model');
        assert.strictEqual(manager.isRunActive(run.id), true);
        assert.strictEqual(manager.isRunCancelled(run.id), false);

        agentRuns.appendRunEvent(run.id, { type: 'status', text: 'Booting agent...' });

        const streamed = [];
        const res = {
            req: { query: {} },
            writableEnded: false,
            destroyed: false,
            headers: {},
            setHeader(name, value) {
                this.headers[name] = value;
            },
            write(chunk) {
                streamed.push(String(chunk).trim());
                return true;
            },
            once(event, handler) {
                if (event === 'close') this._onClose = handler;
            },
            end() {
                this.ended = true;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.jsonPayload = payload;
                return this;
            },
        };

        manager.attachRunStream(run.id, res);
        assert(streamed.some(line => line.includes('"type":"status"') && line.includes('Booting agent')));

        manager.publishRunEvent(run.id, { type: 'heartbeat' });
        assert(streamed.some(line => line.includes('"type":"heartbeat"')));

        manager.publishRunEvent(run.id, { type: 'done' });
        assert.strictEqual(res.ended, true);

        const replayAfterDone = {
            req: { query: {} },
            writableEnded: false,
            destroyed: false,
            headers: {},
            setHeader(name, value) {
                this.headers[name] = value;
            },
            write() {
                return true;
            },
            once() {},
            end() {
                this.ended = true;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.jsonPayload = payload;
                return this;
            },
        };
        manager.attachRunStream(run.id, replayAfterDone);
        assert.strictEqual(replayAfterDone.ended, true);

        const cancelResult = manager.cancelActiveRun(run.id, 'Cancelled in test');
        assert.strictEqual(cancelResult.active, true);
        assert.strictEqual(manager.isRunCancelled(run.id), true);

        res._onClose?.();
        manager.clearActiveRun(run.id);
        assert.strictEqual(manager.isRunActive(run.id), false);

        console.log('agent-run-manager: ok');
    } catch (err) {
        console.error('agent-run-manager: failed');
        console.error(err);
        process.exitCode = 1;
    } finally {
        cleanup();
    }
})();
