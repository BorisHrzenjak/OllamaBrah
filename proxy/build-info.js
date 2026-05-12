'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.join(__dirname, '..');
const packageJson = require('../package.json');
let proxyStartupEpochMs = Date.now();
let proxyStartupTimestamp = new Date(proxyStartupEpochMs).toISOString();

function walkFiles(dir, extensions, out = []) {
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            walkFiles(fullPath, extensions, out);
        } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
            out.push(fullPath);
        }
    }
    return out;
}

function computeSourceHash(root = projectRoot) {
    const hash = crypto.createHash('sha256');
    const files = [];
    const directFiles = ['package.json', 'main.js', 'preload.js', 'whisper_server.py'];
    const sourceDirs = ['proxy', 'renderer'];
    const extensions = new Set(['.js', '.json', '.html', '.css', '.py']);

    for (const rel of directFiles) {
        const fullPath = path.join(root, rel);
        if (fs.existsSync(fullPath)) files.push(fullPath);
    }

    for (const rel of sourceDirs) {
        walkFiles(path.join(root, rel), extensions, files);
    }

    files.sort((a, b) => a.localeCompare(b));

    for (const file of files) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }

    return hash.digest('hex').slice(0, 16);
}

let startupSourceHash = process.env.OLLAMA_BRAH_SOURCE_HASH || computeSourceHash();

function markProxyStartup({ sourceHash } = {}) {
    proxyStartupEpochMs = Date.now();
    proxyStartupTimestamp = new Date(proxyStartupEpochMs).toISOString();
    startupSourceHash = sourceHash || process.env.OLLAMA_BRAH_SOURCE_HASH || computeSourceHash();
}

function getBuildInfo() {
    const appVersion = process.env.OLLAMA_BRAH_APP_VERSION || packageJson.version;
    const packageVersion = process.env.OLLAMA_BRAH_PACKAGE_VERSION || packageJson.version;

    return {
        appName: packageJson.name,
        appVersion,
        packageVersion,
        proxyStartupTimestamp,
        proxyStartupEpochMs,
        sourceHash: startupSourceHash || null,
        pid: process.pid,
        port: Number(process.env.OLLAMA_BRAH_PROXY_PORT || 3456),
    };
}

module.exports = {
    computeSourceHash,
    getBuildInfo,
    markProxyStartup,
    get proxyStartupEpochMs() { return proxyStartupEpochMs; },
    get proxyStartupTimestamp() { return proxyStartupTimestamp; },
};
