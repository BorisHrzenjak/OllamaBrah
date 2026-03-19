/**
 * OllamaBrah — Skills Test Suite
 *
 * Tests the skill system end-to-end against the running proxy server.
 * Make sure the app is running (npm start) before running this.
 *
 * Usage:  node tests/skills.test.js
 */

'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PROXY      = 'http://localhost:3456';
const SKILLS_DIR = path.join(process.env.APPDATA || '', 'ollama-brah', 'skills');
const BUILTIN_DIR = path.join(__dirname, '..', 'resources', 'skills');

// ─── Tiny test runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function pass(name) {
    console.log(`  ✅ ${name}`);
    passed++;
}

function fail(name, reason) {
    console.log(`  ❌ ${name}`);
    console.log(`     → ${reason}`);
    failed++;
    failures.push({ name, reason });
}

function assert(condition, testName, reason) {
    condition ? pass(testName) : fail(testName, reason);
}

function section(title) {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

async function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, body }); }
            });
        }).on('error', reject);
    });
}

async function post(url, data) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data);
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const req = http.request(url, opts, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, body }); }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ─── Frontmatter parser (mirrors proxy/server.js logic) ───────────────────────

function parseSkillFrontmatter(md) {
    const parts = md.split('---');
    if (parts.length < 3) return {};
    const meta = {};
    parts[1].split('\n').forEach(line => {
        const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
        if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
    return meta;
}

// ─── Unit tests (no server needed) ────────────────────────────────────────────

function testSkillFilesOnDisk() {
    section('Skill Files on Disk (no server required)');

    // Skills directory exists
    assert(fs.existsSync(SKILLS_DIR),
        `User skills dir exists: ${SKILLS_DIR}`, 'Directory not found');

    const EXPECTED = [
        { name: 'deep-researcher', builtin: 'true', requiredContent: ['## Process', 'webSearch', 'fetchPage', 'Sources'] },
        { name: 'brainstorming',   builtin: null,    requiredContent: ['HARD-GATE', '## Checklist', 'one at a time', 'writing-plans'] },
        { name: 'copywriting',     builtin: null,    requiredContent: ['## Before Writing', 'version'] },
        { name: 'web-extractor',   builtin: 'true',  requiredContent: ['fetchPage'] },
        { name: 'file-organizer',  builtin: 'true',  requiredContent: [] },
    ];

    for (const expected of EXPECTED) {
        const mdPath = path.join(SKILLS_DIR, expected.name, 'SKILL.md');
        const exists = fs.existsSync(mdPath);
        assert(exists, `${expected.name}/SKILL.md exists on disk`, `Missing: ${mdPath}`);
        if (!exists) continue;

        const content = fs.readFileSync(mdPath, 'utf8');
        const meta    = parseSkillFrontmatter(content);

        assert(meta.name === expected.name,
            `${expected.name}: frontmatter name matches`,
            `Expected "${expected.name}", got "${meta.name}"`);

        assert(typeof meta.description === 'string' && meta.description.length > 10,
            `${expected.name}: has a description`,
            `Description: "${meta.description}"`);

        if (expected.builtin) {
            assert(meta.builtin === 'true',
                `${expected.name}: marked builtin: true`, `Got: ${meta.builtin}`);
        }

        for (const required of expected.requiredContent) {
            assert(content.includes(required),
                `${expected.name}: contains "${required}"`,
                `"${required}" not found in SKILL.md`);
        }
    }
}

// ─── Integration tests (require running app) ──────────────────────────────────

async function testProxyReachable() {
    section('Proxy Connectivity');
    try {
        const res = await get(`${PROXY}/api/skills/list`);
        assert(res.status === 200, 'Proxy is reachable on port 3456', `Got HTTP ${res.status}`);
    } catch (e) {
        fail('Proxy is reachable on port 3456', `Connection refused — is the app running? (${e.message})`);
        console.log('\n  ⚠️  Cannot reach the proxy. Start the app with "npm start" first.\n');
        process.exit(1);
    }
}

async function testSkillsList() {
    section('Skills List API  (/api/skills/list)');
    const res = await get(`${PROXY}/api/skills/list`);

    assert(Array.isArray(res.body), 'Response is an array', `Got: ${typeof res.body}`);
    assert(res.body.length >= 4, `At least 4 skills loaded (got ${res.body.length})`, 'Too few skills');

    const names = res.body.map(s => s.name);
    assert(names.includes('deep-researcher'), 'deep-researcher is in the list', `Found: ${names.join(', ')}`);
    assert(names.includes('brainstorming'),   'brainstorming is in the list',   `Found: ${names.join(', ')}`);
    assert(names.includes('copywriting'),     'copywriting is in the list',     `Found: ${names.join(', ')}`);
    assert(names.includes('web-extractor'),   'web-extractor is in the list',   `Found: ${names.join(', ')}`);

    // Every skill must have name + description
    const malformed = res.body.filter(s => !s.name || !s.description);
    assert(malformed.length === 0, 'Every skill has name and description',
        `Malformed: ${malformed.map(s => s.name || '(no name)').join(', ')}`);

    return res.body;
}

async function testSkillsReload() {
    section('Skill Reload  (/api/skills/reload)');
    const res = await post(`${PROXY}/api/skills/reload`, {});
    assert(res.status === 200,     'Reload returns HTTP 200',       `Got HTTP ${res.status}`);
    assert(res.body.ok === true,   'Reload returns { ok: true }',   `Got: ${JSON.stringify(res.body)}`);
    assert(typeof res.body.count === 'number' && res.body.count >= 4,
        `Reload reports ${res.body.count} skill(s) loaded`, 'count should be >= 4');
}

async function testSkillsDir() {
    section('Skills Directory  (/api/skills/dir)');
    const res = await get(`${PROXY}/api/skills/dir`);
    assert(res.status === 200,          'Returns HTTP 200',            `Got HTTP ${res.status}`);
    assert(typeof res.body.dir === 'string' && res.body.dir.length > 0,
        'Returns a non-empty dir path', `Got: ${JSON.stringify(res.body)}`);
    assert(fs.existsSync(res.body.dir), 'Returned dir actually exists on disk', `Path: ${res.body.dir}`);
    return res.body.dir;
}

async function testBuiltinSkill(skillsList) {
    section('Built-in Skill — deep-researcher');

    // 1. Present in list with correct metadata
    const skill = skillsList.find(s => s.name === 'deep-researcher');
    assert(!!skill, 'deep-researcher found in skills list', 'Not found');
    if (!skill) return;

    assert(skill.builtin === true,
        'deep-researcher has builtin: true',
        `builtin flag is: ${skill.builtin}`);

    assert(
        typeof skill.description === 'string' && skill.description.length > 10,
        `Has meaningful description: "${skill.description.slice(0, 60)}"`,
        'Description missing or too short'
    );

    // 2. SKILL.md exists and has required content
    const skillsDir = (await get(`${PROXY}/api/skills/dir`)).body.dir;
    const mdPath = path.join(skillsDir, 'deep-researcher', 'SKILL.md');
    assert(fs.existsSync(mdPath), 'SKILL.md file exists on disk', `Expected: ${mdPath}`);

    const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';

    assert(content.startsWith('---'), 'SKILL.md has YAML frontmatter', 'Does not start with ---');
    assert(content.includes('name: deep-researcher'), 'Frontmatter contains correct name', '');
    assert(content.includes('builtin: true'),         'Frontmatter contains builtin: true', '');

    // 3. Body contains the required workflow sections
    assert(content.includes('## Process'),    'Contains ## Process section',    'Missing');
    assert(content.includes('webSearch'),     'References webSearch tool',      'Missing');
    assert(content.includes('fetchPage'),     'References fetchPage tool',      'Missing');
    assert(content.includes('## Guidelines'),'Contains ## Guidelines section', 'Missing');
    assert(content.includes('Sources'),       'Contains Sources output section','Missing');
}

async function testUserInstalledSkill(skillsList) {
    section('User-Installed Skill — brainstorming');

    // 1. Present in list
    const skill = skillsList.find(s => s.name === 'brainstorming');
    assert(!!skill, 'brainstorming found in skills list', 'Not found');
    if (!skill) return;

    // This is a user skill, not builtin
    assert(skill.builtin !== true,
        'brainstorming is NOT marked as builtin (user-installed)',
        `builtin flag is: ${skill.builtin}`);

    assert(
        typeof skill.description === 'string' && skill.description.length > 20,
        `Has meaningful description (${skill.description.length} chars)`,
        'Description missing or too short'
    );

    // 2. SKILL.md exists and has required content
    const skillsDir = (await get(`${PROXY}/api/skills/dir`)).body.dir;
    const mdPath = path.join(skillsDir, 'brainstorming', 'SKILL.md');
    assert(fs.existsSync(mdPath), 'SKILL.md file exists on disk', `Expected: ${mdPath}`);

    const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';

    assert(content.startsWith('---'),            'SKILL.md has YAML frontmatter',          '');
    assert(content.includes('name: brainstorming'), 'Frontmatter contains correct name',    '');

    // 3. Key structural elements of the brainstorming skill
    assert(content.includes('HARD-GATE'),        'Contains HARD-GATE design constraint',   'Missing');
    assert(content.includes('## Checklist'),     'Contains ## Checklist section',          'Missing');
    assert(content.includes('## Process Flow'),  'Contains ## Process Flow section',       'Missing');
    assert(content.includes('one at a time'),    'Contains one-question-at-a-time rule',   'Missing');
    assert(content.includes('writing-plans'),    'References writing-plans handoff skill', 'Missing');
}

async function testCopywritingSkill(skillsList) {
    section('User-Installed Skill — copywriting');

    const skill = skillsList.find(s => s.name === 'copywriting');
    assert(!!skill, 'copywriting found in skills list', 'Not found');
    if (!skill) return;

    assert(
        typeof skill.description === 'string' && skill.description.length > 20,
        `Has meaningful description (${skill.description.length} chars)`,
        'Description too short'
    );

    const skillsDir = (await get(`${PROXY}/api/skills/dir`)).body.dir;
    const mdPath = path.join(skillsDir, 'copywriting', 'SKILL.md');
    assert(fs.existsSync(mdPath), 'SKILL.md file exists on disk', `Expected: ${mdPath}`);

    const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
    assert(content.includes('name: copywriting'),    'Frontmatter name is copywriting', '');
    assert(content.includes('version'),              'Metadata contains version field', '');
    assert(content.includes('## Before Writing'),    'Contains ## Before Writing section', 'Missing');
}

async function testLoadSkillTool() {
    section('loadSkill Tool (via agent endpoint)');

    // Send a minimal agent request that just calls loadSkill
    // We use a very small message so the model isn't needed — we just check the tool fires
    const res = await post(`${PROXY}/api/agent/chat`, {
        messages: [
            { role: 'user', content: 'Load the deep-researcher skill for me using loadSkill("deep-researcher")' }
        ],
        model: 'llama3.2',   // whatever is installed; the tool itself doesn't need inference
        backend: 'ollama',
        maxSteps: 3,
        _testMode: true      // harmless unknown field, just for identification in logs
    });

    // The response is NDJSON streamed — we get back the raw body string here
    // Check it contains a tool_result event for loadSkill
    const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    const lines   = bodyStr.split('\n').filter(Boolean);
    const events  = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const toolResultEvent = events.find(e => e.type === 'tool_result' && e.name === 'loadSkill');
    const hasSkillContent = toolResultEvent && typeof toolResultEvent.result === 'string'
        && toolResultEvent.result.includes('Deep Researcher');

    // Note: this test depends on the model actually calling loadSkill.
    // If it doesn't, we at least verify the endpoint responded.
    const responded = events.length > 0;
    assert(responded, 'Agent endpoint returned at least one event', 'No events in response');

    if (toolResultEvent) {
        assert(!toolResultEvent.error, 'loadSkill returned without error', `Error: ${toolResultEvent.result}`);
        assert(hasSkillContent, 'loadSkill result contains skill body text', `Got: ${(toolResultEvent.result || '').slice(0, 80)}`);
    } else {
        console.log('     ℹ️  Model did not call loadSkill tool (depends on model behaviour) — skipping content check');
    }
}

// ─── Run all tests ─────────────────────────────────────────────────────────────

(async () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║         OllamaBrah — Skills Test Suite               ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    // ── Phase 1: Unit tests (always run, no server needed) ───────────────────
    try {
        testSkillFilesOnDisk();
    } catch (e) {
        console.error('\n  💥 Unexpected error in unit tests:', e.message);
        failed++;
    }

    // ── Phase 2: Integration tests (require running proxy) ───────────────────
    let serverUp = false;
    try {
        await get(`${PROXY}/api/skills/list`);
        serverUp = true;
    } catch {
        console.log('\n── Integration Tests ───────────────────────────────────');
        console.log('  ⚠️  Proxy not reachable — skipping integration tests.');
        console.log('     Start the app with "npm start" and re-run to test the full suite.\n');
    }

    if (serverUp) {
        try {
            await testProxyReachable();
            const skillsList = await testSkillsList();
            await testSkillsReload();
            await testSkillsDir();
            await testBuiltinSkill(skillsList);
            await testUserInstalledSkill(skillsList);
            await testCopywritingSkill(skillsList);
            await testLoadSkillTool();
        } catch (e) {
            console.error('\n  💥 Unexpected error in integration tests:', e.message);
            failed++;
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(54));
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('\n  Failed tests:');
        failures.forEach(f => console.log(`    • ${f.name}\n      ${f.reason}`));
    }
    console.log('═'.repeat(54) + '\n');
    process.exit(failed > 0 ? 1 : 0);
})();
