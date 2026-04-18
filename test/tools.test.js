const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tools = require('../proxy/tools');

let passed = 0;
let failed = 0;
const pendingAsyncTests = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
    }
}

function queueAsyncTest(name, fn) {
    pendingAsyncTests.push(testAsync(name, fn));
}

const tmpDir = path.join(os.tmpdir(), `ollamabrah-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

console.log('Agent Tool Tests\n');

test('AGENT_TOOLS is a non-empty array', () => {
    assert(Array.isArray(tools.AGENT_TOOLS));
    assert(tools.AGENT_TOOLS.length > 0);
});

test('Every AGENT_TOOLS entry has a function name', () => {
    for (const t of tools.AGENT_TOOLS) {
        assert(t.type === 'function', `Tool ${JSON.stringify(t)} missing type "function"`);
        assert(t.function && t.function.name, `Tool missing function.name`);
    }
});

test('Every tool has a permission level in agentToolPermissions', () => {
    for (const t of tools.AGENT_TOOLS) {
        const name = t.function.name;
        assert(tools.agentToolPermissions.hasOwnProperty(name), `Tool "${name}" missing from agentToolPermissions`);
        assert(['auto', 'confirm', 'disabled'].includes(tools.agentToolPermissions[name]), `Tool "${name}" has invalid permission level`);
    }
});

test('Permission levels are correct for dangerous tools', () => {
    assert(tools.agentToolPermissions.writeFile === 'confirm');
    assert(tools.agentToolPermissions.applyPatch === 'confirm');
    assert(tools.agentToolPermissions.deleteFile === 'confirm');
    assert(tools.agentToolPermissions.runShell === 'confirm');
    assert(tools.agentToolPermissions.runCode === 'confirm');
});

test('PLAN_GATED tools are exported and include risky file actions', () => {
    assert(tools.PLAN_GATED_TOOLS instanceof Set);
    assert(tools.PLAN_GATED_TOOLS.has('runShell'));
    assert(tools.PLAN_GATED_TOOLS.has('writeFile'));
    assert(tools.PLAN_GATED_TOOLS.has('applyPatch'));
    assert(tools.PLAN_GATED_TOOLS.has('moveFile'));
});

test('buildToolPlan summarizes shell and file actions', () => {
    const shellPlan = tools.buildToolPlan('runShell', { cmd: 'npm test' }, 'critical');
    assert(shellPlan.summary.includes('Run shell command'));
    assert(shellPlan.commands[0] === 'npm test');

    const filePlan = tools.buildToolPlan('writeFile', { path: 'C:\\tmp\\a.txt' }, 'high');
    assert(filePlan.summary.includes('Write file'));
    assert(filePlan.files[0].includes('a.txt'));
});

test('buildExecutionPlan groups multiple risky actions into one plan', () => {
    const plan = tools.buildExecutionPlan([
        { name: 'writeFile', args: { path: 'C:\\tmp\\a.txt' }, risk: 'high' },
        { name: 'runShell', args: { cmd: 'npm test' }, risk: 'critical' },
        { name: 'readFile', args: { path: 'C:\\tmp\\b.txt' }, risk: 'low' },
    ]);

    assert(plan);
    assert.strictEqual(plan.actions.length, 2);
    assert.strictEqual(plan.risk, 'critical');
    assert(plan.files.some(file => file.includes('a.txt')));
    assert(plan.commands.includes('npm test'));
});

test('buildExecutionPlan returns null when no risky tools exist', () => {
    const plan = tools.buildExecutionPlan([
        { name: 'readFile', args: { path: 'C:\\tmp\\a.txt' }, risk: 'low' },
        { name: 'globFiles', args: { path: 'C:\\tmp', pattern: '**/*.js' }, risk: 'low' },
    ]);
    assert.strictEqual(plan, null);
});

test('Permission levels are auto for safe tools', () => {
    assert(tools.agentToolPermissions.readFile === 'auto');
    assert(tools.agentToolPermissions.readFileRange === 'auto');
    assert(tools.agentToolPermissions.searchInFiles === 'auto');
    assert(tools.agentToolPermissions.globFiles === 'auto');
    assert(tools.agentToolPermissions.listDirectory === 'auto');
    assert(tools.agentToolPermissions.diffFiles === 'auto');
});

test('readFile description nudges toward readFileRange', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'readFile');
    assert(t.function.description.toLowerCase().includes('readFileRange'.toLowerCase()));
});

test('writeFile description nudges toward replaceInFile/applyPatch', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'writeFile');
    const desc = t.function.description.toLowerCase();
    assert(desc.includes('replaceinfile') || desc.includes('applypatch'));
});

test('appendFile description nudges toward replaceInFile/applyPatch', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'appendFile');
    const desc = t.function.description.toLowerCase();
    assert(desc.includes('replaceinfile') || desc.includes('applypatch'));
});

test('isPathAllowed blocks System32', () => {
    assert(!tools.isPathAllowed('C:\\Windows\\System32\\cmd.exe'));
});

test('isPathAllowed blocks .ssh directory', () => {
    assert(!tools.isPathAllowed(path.join(os.homedir(), '.ssh', 'id_rsa')));
});

test('isPathAllowed allows home directory by default', () => {
    assert(tools.isPathAllowed(path.join(os.homedir(), 'Documents', 'test.txt')));
});

test('ALWAYS_BLOCKED_PATHS includes System32 and .ssh', () => {
    const blocked = tools.ALWAYS_BLOCKED_PATHS;
    assert(blocked.some(p => p.toLowerCase().includes('system32')));
    assert(blocked.some(p => p.toLowerCase().includes('.ssh')));
});

test('getEnabledTools excludes disabled tools', () => {
    const origPerms = { ...tools.agentToolPermissions };
    tools.agentToolPermissions.writeFile = 'disabled';
    const enabled = tools.getEnabledTools();
    assert(!enabled.some(t => t.function.name === 'writeFile'));
    Object.assign(tools.agentToolPermissions, origPerms);
});

test('getEnabledTools includes auto and confirm tools', () => {
    const enabled = tools.getEnabledTools();
    assert(enabled.some(t => t.function.name === 'readFile'));
    assert(enabled.some(t => t.function.name === 'writeFile'));
});

test('createToolCache returns a cache object with get/set/invalidatePath/clear', () => {
    const cache = tools.createToolCache();
    assert(typeof cache.get === 'function');
    assert(typeof cache.set === 'function');
    assert(typeof cache.invalidatePath === 'function');
    assert(typeof cache.clear === 'function');
});

test('ToolCache get returns undefined for missing keys', () => {
    const cache = tools.createToolCache();
    assert.strictEqual(cache.get('nonexistent'), undefined);
});

test('ToolCache set/get roundtrip works', () => {
    const cache = tools.createToolCache();
    cache.set('key1', 'value1');
    assert.strictEqual(cache.get('key1'), 'value1');
});

test('ToolCache invalidatePath clears matching entries', () => {
    const cache = tools.createToolCache();
    const testPath = path.join(tmpDir, 'sub', 'file.txt');
    cache.set('dir:' + path.join(tmpDir, 'sub').toLowerCase(), 'listing');
    cache.set('search:' + tmpDir.toLowerCase() + ':abc', 'results');
    cache.set('glob:' + tmpDir.toLowerCase() + ':**/*.js', 'matches');
    cache.invalidatePath(testPath);
    assert.strictEqual(cache.get('dir:' + path.join(tmpDir, 'sub').toLowerCase()), undefined);
    assert.strictEqual(cache.get('search:' + tmpDir.toLowerCase() + ':abc'), undefined);
    assert.strictEqual(cache.get('glob:' + tmpDir.toLowerCase() + ':**/*.js'), undefined);
});

test('ToolCache clear empties everything', () => {
    const cache = tools.createToolCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('b'), undefined);
});

test('executeTool returns unknown tool error for invalid name', async () => {
    const fakeRes = { write: () => {} };
    const result = await tools.executeTool(fakeRes, 'nonexistentTool', {}, new Map(), 'test', 'ollama');
    assert(result.error === true);
    assert(result.result.includes('Unknown tool'));
});

test('readFileRange tool definition has correct parameters', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'readFileRange');
    assert(t);
    const params = t.function.parameters.properties;
    assert(params.path);
    assert(params.start);
    assert(params.end);
    assert(t.function.parameters.required.includes('path'));
    assert(t.function.parameters.required.includes('start'));
    assert(t.function.parameters.required.includes('end'));
});

test('applyPatch tool definition has correct parameters', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'applyPatch');
    assert(t);
    const params = t.function.parameters.properties;
    assert(params.path);
    assert(params.diff);
    assert(t.function.parameters.required.includes('path'));
    assert(t.function.parameters.required.includes('diff'));
});

test('replaceInFile tool definition has replaceAll option', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'replaceInFile');
    assert(t);
    assert(t.function.parameters.properties.replaceAll);
});

test('searchInFiles tool definition has filePattern and regex options', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'searchInFiles');
    assert(t);
    assert(t.function.parameters.properties.filePattern);
    assert(t.function.parameters.properties.regex);
});

test('globFiles tool definition has correct parameters', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'globFiles');
    assert(t);
    const params = t.function.parameters.properties;
    assert(params.path);
    assert(params.pattern);
});

test('diffFiles tool definition has pathA and pathB', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'diffFiles');
    assert(t);
    const params = t.function.parameters.properties;
    assert(params.pathA);
    assert(params.pathB);
});

test('mkdir tool definition has correct parameters', () => {
    const t = tools.AGENT_TOOLS.find(t => t.function.name === 'mkdir');
    assert(t);
    assert(t.function.parameters.properties.path);
});

test('copyFile and moveFile have source and destination', () => {
    const cp = tools.AGENT_TOOLS.find(t => t.function.name === 'copyFile');
    const mv = tools.AGENT_TOOLS.find(t => t.function.name === 'moveFile');
    assert(cp.function.parameters.properties.source);
    assert(cp.function.parameters.properties.destination);
    assert(mv.function.parameters.properties.source);
    assert(mv.function.parameters.properties.destination);
});

test('getAgentMaxSteps returns a positive integer', () => {
    const steps = tools.getAgentMaxSteps();
    assert(Number.isInteger(steps));
    assert(steps > 0);
});

test('getAgentAllowedDirs returns a non-empty array', () => {
    const dirs = tools.getAgentAllowedDirs();
    assert(Array.isArray(dirs));
    assert(dirs.length > 0);
});

test('getAgentBlockedPaths includes ALWAYS_BLOCKED_PATHS', () => {
    const blocked = tools.getAgentBlockedPaths();
    for (const p of tools.ALWAYS_BLOCKED_PATHS) {
        assert(blocked.includes(p), `Missing always-blocked path: ${p}`);
    }
});

test('resolveWorkspacePath keeps relative paths inside workspace', () => {
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const resolved = tools.ensureAllowedPath(path.join(workspace, 'a.txt'));
    assert(tools.isPathInsideWorkspace(resolved, workspace));
});

test('isPathInsideWorkspace rejects paths outside workspace', () => {
    const workspace = path.join(tmpDir, 'workspace');
    const outside = path.join(tmpDir, 'outside.txt');
    assert.strictEqual(tools.isPathInsideWorkspace(outside, workspace), false);
});

test('extractCommandPaths finds absolute Windows paths in shell commands', () => {
    const paths = tools.extractCommandPaths('type C:\\Users\\Boris\\file.txt && more "C:\\Users\\Boris\\Other File.txt"');
    assert(paths.some(p => p === 'C:\\Users\\Boris\\file.txt'));
    assert(paths.some(p => p === 'C:\\Users\\Boris\\Other File.txt'));
});

test('validateShellCommandForWorkspace rejects absolute paths outside workspace', () => {
    const workspace = path.join(tmpDir, 'workspace');
    assert.throws(() => {
        tools.validateShellCommandForWorkspace('type C:\\Users\\Boris\\phase4-plan-test.txt', workspace);
    }, /outside the selected workspace/i);
});

queueAsyncTest('requestPermission auto-approves in yolo mode', async () => {
    const events = [];
    const fakeRes = { yoloMode: true, writableEnded: false, write: (line) => events.push(JSON.parse(String(line).trim())) };
    const approved = await tools.requestPermission(fakeRes, 'runShell', { cmd: 'npm test' }, 'critical', new Map());
    assert.strictEqual(approved, true);
    assert(events.some(event => event.type === 'permission_auto_approved' && event.tool === 'runShell'));
});

queueAsyncTest('requestPlanApproval auto-approves in yolo mode', async () => {
    const events = [];
    const fakeRes = { yoloMode: true, writableEnded: false, write: (line) => events.push(JSON.parse(String(line).trim())) };
    const approved = await tools.requestPlanApproval(fakeRes, {
        summary: 'Run risky command',
        actions: [{ tool: 'runShell', commands: ['npm test'] }],
    }, new Map());
    assert.strictEqual(approved, true);
    assert(events.some(event => event.type === 'plan_auto_approved'));
});

queueAsyncTest('requestPermission persists session grants and emits a decision event', async () => {
    const events = [];
    const sessionPermissions = new Map();
    let persistCalls = 0;
    sessionPermissions._persist = () => { persistCalls += 1; };
    const fakeRes = {
        writableEnded: false,
        write: (line) => events.push(JSON.parse(String(line).trim())),
        once: () => {},
        removeListener: () => {},
    };

    const pending = tools.requestPermission(fakeRes, 'runShell', { cmd: 'npm test' }, 'critical', sessionPermissions);
    const requestEvent = events.find(event => event.type === 'permission_request');
    assert(requestEvent, 'permission_request should be emitted');

    tools.handleAgentPermission({
        body: { id: requestEvent.id, approved: true, scope: 'session' }
    }, {
        json: () => {}
    });

    const approved = await pending;
    assert.strictEqual(approved, true);
    assert.strictEqual(sessionPermissions.get('runShell'), true);
    assert.strictEqual(persistCalls, 1);
    assert(events.some(event => event.type === 'permission_decision' && event.scope === 'session' && event.tool === 'runShell'));
});

queueAsyncTest('requestPlanApproval persists session plan grants', async () => {
    const events = [];
    const sessionPermissions = new Map();
    let persistCalls = 0;
    sessionPermissions._persist = () => { persistCalls += 1; };
    const fakeRes = {
        writableEnded: false,
        write: (line) => events.push(JSON.parse(String(line).trim())),
        once: () => {},
        removeListener: () => {},
    };
    const plan = {
        summary: 'Run risky command',
        actions: [{ tool: 'runShell', commands: ['npm test'], files: [] }],
    };

    const pending = tools.requestPlanApproval(fakeRes, plan, sessionPermissions);
    const requestEvent = events.find(event => event.type === 'plan_request');
    assert(requestEvent, 'plan_request should be emitted');

    tools.handleAgentPlan({
        body: { id: requestEvent.id, approved: true, scope: 'session' }
    }, {
        json: () => {}
    });

    const approved = await pending;
    assert.strictEqual(approved, true);
    assert.strictEqual(persistCalls, 1);
    const persistedKeys = [...sessionPermissions.keys()];
    assert(persistedKeys.some(key => key.startsWith('plan:')));
    assert(events.some(event => event.type === 'plan_decision' && event.scope === 'session'));
});

queueAsyncTest('abortPendingInteractionsForRun cancels a pending permission request', async () => {
    const sessionPermissions = new Map();
    const fakeRes = {
        runId: 'run-cancel-permission',
        writableEnded: false,
        write: () => {},
        once: () => {},
        removeListener: () => {},
    };

    const pending = tools.requestPermission(fakeRes, 'runShell', { cmd: 'npm test' }, 'critical', sessionPermissions);
    const aborted = tools.abortPendingInteractionsForRun('run-cancel-permission', 'Run cancelled in test');
    assert.strictEqual(aborted, 1);
    await assert.rejects(pending, err => err?.code === tools.RUN_CANCELLED_ERROR_CODE);
});

queueAsyncTest('abortPendingInteractionsForRun cancels a pending plan approval', async () => {
    const sessionPermissions = new Map();
    const fakeRes = {
        runId: 'run-cancel-plan',
        writableEnded: false,
        write: () => {},
        once: () => {},
        removeListener: () => {},
    };
    const plan = {
        summary: 'Run risky command',
        actions: [{ tool: 'runShell', commands: ['npm test'], files: [] }],
    };

    const pending = tools.requestPlanApproval(fakeRes, plan, sessionPermissions);
    const aborted = tools.abortPendingInteractionsForRun('run-cancel-plan', 'Run cancelled in test');
    assert.strictEqual(aborted, 1);
    await assert.rejects(pending, err => err?.code === tools.RUN_CANCELLED_ERROR_CODE);
});

test('writeFile returns a diff preview for completed edits', async () => {
    const workspace = path.join(tmpDir, 'workspace-diff');
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'note.txt');
    const fakeRes = { write: () => {}, runId: 'test-run' };
    const result = await tools.executeTool(fakeRes, 'writeFile', { path: target, content: 'hello\nworld\n' }, new Map([['writeFile', true]]), 'test', 'ollama', null, workspace);
    assert.strictEqual(result.error, undefined);
    assert(result.diffPreview.includes('hello'));
    assert(result.diffPath.endsWith('note.txt'));
});

test('replaceInFile returns a diff preview for completed edits', async () => {
    const workspace = path.join(tmpDir, 'workspace-replace');
    fs.mkdirSync(workspace, { recursive: true });
    const target = path.join(workspace, 'note.txt');
    fs.writeFileSync(target, 'alpha\nbeta\n', 'utf8');
    const fakeRes = { write: () => {}, runId: 'test-run' };
    const result = await tools.executeTool(fakeRes, 'replaceInFile', { path: target, search: 'beta', replace: 'gamma' }, new Map([['replaceInFile', true]]), 'test', 'ollama', null, workspace);
    assert.strictEqual(result.error, undefined);
    assert(result.diffPreview.includes('-beta'));
    assert(result.diffPreview.includes('+gamma'));
});

Promise.allSettled(pendingAsyncTests).finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
});
