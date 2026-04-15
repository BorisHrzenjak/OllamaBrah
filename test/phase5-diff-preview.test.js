const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tools = require('../proxy/tools');

async function main() {
    const tmpDir = path.join(os.tmpdir(), `ollamabrah-phase5-diff-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        const workspace = path.join(tmpDir, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        const target = path.join(workspace, 'note.txt');
        const fakeRes = { write: () => {}, runId: 'phase5-diff-test' };

        const writeResult = await tools.executeTool(
            fakeRes,
            'writeFile',
            { path: target, content: 'alpha\nbeta\n' },
            new Map([['writeFile', true]]),
            'test',
            'ollama',
            null,
            workspace
        );

        assert.strictEqual(writeResult.error, undefined);
        assert(writeResult.diffPreview.includes('+alpha'));
        assert(writeResult.diffPreview.includes('+beta'));

        const replaceResult = await tools.executeTool(
            fakeRes,
            'replaceInFile',
            { path: target, search: 'beta', replace: 'gamma' },
            new Map([['replaceInFile', true]]),
            'test',
            'ollama',
            null,
            workspace
        );

        assert.strictEqual(replaceResult.error, undefined);
        assert(replaceResult.diffPreview.includes('-beta'));
        assert(replaceResult.diffPreview.includes('+gamma'));

        console.log('phase5-diff-preview: ok');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('phase5-diff-preview: failed');
    console.error(err);
    process.exit(1);
});
