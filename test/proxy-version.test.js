const assert = require('assert');

process.env.OLLAMA_BRAH_APP_VERSION = '9.8.7-test';
process.env.OLLAMA_BRAH_PACKAGE_VERSION = '9.8.7-package';
process.env.OLLAMA_BRAH_SOURCE_HASH = 'testhash123';

const { app } = require('../proxy/router');

(async () => {
    const server = app;
    let instance = null;
    try {
        instance = server.listen(0, '127.0.0.1');
        const port = await new Promise(resolve => instance.once('listening', () => resolve(instance.address().port)));
        const response = await fetch(`http://127.0.0.1:${port}/api/version`);
        assert.strictEqual(response.status, 200);
        const body = await response.json();

        assert.strictEqual(body.appName, 'ollama-brah');
        assert.strictEqual(body.appVersion, '9.8.7-test');
        assert.strictEqual(body.packageVersion, '9.8.7-package');
        assert.strictEqual(body.sourceHash, 'testhash123');
        assert.match(body.proxyStartupTimestamp, /^\d{4}-\d{2}-\d{2}T/);
        assert.strictEqual(typeof body.proxyStartupEpochMs, 'number');
        assert.strictEqual(typeof body.pid, 'number');
        assert.strictEqual(typeof body.port, 'number');

        console.log('proxy-version: ok');
    } catch (err) {
        console.error('proxy-version: failed');
        console.error(err);
        process.exitCode = 1;
    } finally {
        if (instance) await new Promise(resolve => instance.close(resolve));
    }
})();
