/**
 * OllamaBrah — Brainstorming Skill Behavioral Test
 *
 * Sends a real request through the agent endpoint with the brainstorming
 * skill activated, then evaluates whether the model followed the skill's
 * rules (HARD-GATE, one question at a time, no premature implementation, etc.)
 *
 * Usage:  node tests/brainstorming-skill.test.js
 * Requires the app to be running (npm start).
 */

'use strict';

const http = require('http');

const PROXY = 'http://localhost:3456';

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
const failures = [];

function pass(name)            { console.log(`  ✅ ${name}`); passed++; }
function fail(name, reason)    { console.log(`  ❌ ${name}\n     → ${reason}`); failed++; failures.push({ name, reason }); }
function info(msg)             { console.log(`  ℹ️  ${msg}`); }
function section(title)        { console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`); }
function assert(ok, name, why) { ok ? pass(name) : fail(name, why); }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function getJSON(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
        }).on('error', reject);
    });
}

/** POST to an endpoint that streams NDJSON. Collects all lines and parses them. */
function postStream(url, data, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data);
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        };
        const req = http.request(url, opts, res => {
            let buffer = '';
            const events = [];
            const timer = setTimeout(() => {
                req.destroy();
                resolve(events); // return what we have on timeout
            }, timeoutMs);

            res.on('data', chunk => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete last line
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try { events.push(JSON.parse(line)); } catch { /* non-JSON line, skip */ }
                }
            });
            res.on('end', () => {
                clearTimeout(timer);
                if (buffer.trim()) {
                    try { events.push(JSON.parse(buffer)); } catch {}
                }
                resolve(events);
            });
            res.on('error', err => { clearTimeout(timer); reject(err); });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ─── Detect installed model ───────────────────────────────────────────────────

async function pickModel() {
    try {
        const data = await getJSON(`${PROXY}/proxy/api/tags`);
        const models = (data.models || []).map(m => m.name);
        if (!models.length) return null;
        // Prefer larger/smarter models for a behavioural test
        const preferred = models.find(m => /32b|27b|22b|14b|qwen|gemma|llama3\.3|mistral/i.test(m));
        return preferred || models[0];
    } catch { return null; }
}

// ─── Evaluators ──────────────────────────────────────────────────────────────

function evaluateEvents(events, model) {
    section('Raw Event Summary');
    const byType = {};
    events.forEach(e => { byType[e.type] = (byType[e.type] || 0) + 1; });
    info(`Model used: ${model}`);
    info(`Total events: ${events.length}`);
    info(`Event types: ${Object.entries(byType).map(([k,v]) => `${k}×${v}`).join(', ')}`);

    // Collect full assistant text (proxy may emit type: 'text', 'chunk', or 'content')
    const textChunks = events
        .filter(e => e.type === 'text' || e.type === 'chunk' || e.type === 'content')
        .map(e => e.content || e.text || e.delta || '');
    const fullText   = textChunks.join('');

    // Collect tool calls and results
    const toolCalls   = events.filter(e => e.type === 'tool_call');
    const toolResults = events.filter(e => e.type === 'tool_result');

    if (fullText.length > 0) {
        console.log('\n  ── Model response preview ──────────────────────────────');
        const preview = fullText.slice(0, 600).replace(/\n/g, '\n  ');
        console.log(`  ${preview}${fullText.length > 600 ? '\n  [... truncated]' : ''}`);
        console.log('  ────────────────────────────────────────────────────────\n');
    }

    return { fullText, toolCalls, toolResults };
}

function testSkillLoading(toolCalls, toolResults) {
    section('Skill Loading');

    const loadSkillCall = toolCalls.find(e => e.name === 'loadSkill');
    assert(!!loadSkillCall,
        'Model called loadSkill tool',
        'loadSkill was never called — model ignored the skill hint');

    if (loadSkillCall) {
        assert(loadSkillCall.args?.name === 'brainstorming',
            'loadSkill called with name="brainstorming"',
            `Called with: ${JSON.stringify(loadSkillCall.args)}`);
    }

    const loadSkillResult = toolResults.find(e => e.name === 'loadSkill');
    if (loadSkillResult) {
        assert(!loadSkillResult.error,
            'loadSkill returned successfully (no error)',
            `Error: ${loadSkillResult.result}`);
        assert(
            typeof loadSkillResult.result === 'string' && loadSkillResult.result.includes('HARD-GATE'),
            'loadSkill result contains the full SKILL.md body (found HARD-GATE marker)',
            'HARD-GATE not found in returned content — wrong or truncated skill body');
    }
}

function testHardGate(fullText) {
    section('HARD-GATE — No Premature Implementation');

    // Signs of jumping straight to implementation
    const codeBlockCount = (fullText.match(/```[\w]*/g) || []).length;
    const hasImplementationCode = codeBlockCount > 0 &&
        /```(js|javascript|ts|typescript|python|html|css|jsx|tsx|go|rust|java)/i.test(fullText);

    assert(!hasImplementationCode,
        'Did NOT write implementation code before design approval',
        `Found ${codeBlockCount} fenced code block(s) with implementation language — HARD-GATE violated`);

    // Should not have started a full implementation plan
    const jumpedToImpl = /here('s| is) the (implementation|code|solution|full code)/i.test(fullText) ||
        /I('ll| will) (implement|build|create|code) (this|it) (now|for you)/i.test(fullText);
    assert(!jumpedToImpl,
        'Did NOT announce immediate implementation',
        'Model announced it would implement — should brainstorm first');
}

function testConversationalProcess(fullText) {
    section('Brainstorming Process');

    // Must ask at least one question
    const questionCount = (fullText.match(/\?/g) || []).length;
    assert(questionCount >= 1,
        `Asked at least one clarifying question (found ${questionCount})`,
        'Response contains no questions — model should gather requirements first');

    // Should not fire off a wall of questions at once (one at a time rule)
    const directQuestions = (fullText.match(/\n[-*\d]+[.)]\s.+\?/g) || []).length;
    assert(directQuestions <= 2,
        `Did not overwhelm with a list of questions (found ${directQuestions} bulleted questions)`,
        `Found ${directQuestions} bulleted questions — skill says ask one at a time`);

    // Response should be conversational, not a huge wall of text on first turn
    const wordCount = fullText.trim().split(/\s+/).length;
    assert(wordCount < 600,
        `First response is conversational length (${wordCount} words)`,
        `${wordCount} words is very long for a first brainstorming turn — should explore first, not dump everything`);

    // Should NOT have produced a full design doc immediately
    const hasFullDesign = /#{1,2} (architecture|components|data flow|tech stack|database schema)/i.test(fullText);
    assert(!hasFullDesign,
        'Did NOT produce a full design document prematurely',
        'Model jumped to detailed architecture — should ask questions and explore first');
}

function testContextAwareness(fullText) {
    section('Context Awareness');

    // Should acknowledge it read the skill / is in brainstorming mode
    const acknowledgesBrainstorm = /brainstorm|explore|understand|clarif|question|help (me |us )?(understand|think|design|plan)/i.test(fullText);
    assert(acknowledgesBrainstorm,
        'Response acknowledges brainstorming/exploration mode',
        'Model does not seem aware it\'s in brainstorming mode');

    // Should NOT say it can't help or refuse
    const refusedOrConfused = /I (can't|cannot|don't|do not) (help|assist|access|do that)/i.test(fullText);
    assert(!refusedOrConfused,
        'Did not refuse or express confusion',
        'Model refused or expressed inability to help');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║   OllamaBrah — Brainstorming Skill Behavioral Test   ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    // Check proxy
    section('Setup');
    let model;
    try {
        model = await pickModel();
        if (!model) { console.log('\n  ❌ No models found via Ollama. Is Ollama running?\n'); process.exit(1); }
        info(`Using model: ${model}`);
    } catch {
        console.log('\n  ❌ Cannot reach proxy on port 3456. Start the app with "npm start" first.\n');
        process.exit(1);
    }

    // Build request that mimics exactly what the app sends when user types /brainstorming
    const TOPIC = 'I want to build a habit tracker app for my phone';
    info(`Test topic: "${TOPIC}"`);
    info('Sending request to agent endpoint (this may take 20–60s)...\n');

    const requestBody = {
        messages: [
            { role: 'user', content: TOPIC }
        ],
        model,
        backend: 'ollama',
        maxSteps: 6,
        _skillHint: 'Use the brainstorming skill — call loadSkill("brainstorming") first to get the full instructions, then proceed.',
    };

    let events;
    try {
        events = await postStream(`${PROXY}/api/agent/chat`, requestBody, 90000);
    } catch (e) {
        console.log(`\n  ❌ Request failed: ${e.message}\n`);
        process.exit(1);
    }

    if (!events.length) {
        console.log('\n  ❌ No events received — the agent returned an empty response.\n');
        process.exit(1);
    }

    // Evaluate
    const { fullText, toolCalls, toolResults } = evaluateEvents(events, model);
    testSkillLoading(toolCalls, toolResults);
    testHardGate(fullText);
    testConversationalProcess(fullText);
    testContextAwareness(fullText);

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(54));
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('\n  Failed tests:');
        failures.forEach(f => console.log(`    • ${f.name}\n      ${f.reason}`));
    }
    if (failed === 0) console.log('  🎉 Brainstorming skill is behaving correctly.');
    console.log('═'.repeat(54) + '\n');
    process.exit(failed > 0 ? 1 : 0);
})();
