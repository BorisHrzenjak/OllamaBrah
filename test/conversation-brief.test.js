const assert = require('assert');

const memory = require('../proxy/conversation-memory');

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
        process.exitCode = 1;
    }
}

console.log('conversation-brief\n');

test('normalizeWorkingMemory fills defaults and trims lists', () => {
    const normalized = memory.normalizeWorkingMemory({
        summary: '  Summary here  ',
        goals: [' One ', 'one', '', 'Two'],
        stale: false,
    });

    assert.strictEqual(normalized.summary, 'Summary here');
    assert.deepStrictEqual(normalized.goals, ['One', 'Two']);
    assert.strictEqual(normalized.stale, false);
    assert(Array.isArray(normalized.constraints));
});

test('parseWorkingMemoryResponse extracts JSON from fenced block', () => {
    const parsed = memory.parseWorkingMemoryResponse(
        '```json\n{"summary":"Keep coding","goals":["Ship feature"],"constraints":[],"decisions":[],"openQuestions":[],"keyFacts":[],"filesInPlay":[],"latestOutputs":[]}\n```'
    );

    assert.strictEqual(parsed.summary, 'Keep coding');
    assert.deepStrictEqual(parsed.goals, ['Ship feature']);
});

test('mergeWorkingMemory infers files and outputs from transcript', () => {
    const merged = memory.mergeWorkingMemory(
        memory.createEmptyWorkingMemory(),
        {
            summary: 'Working on a bug fix',
            goals: ['Fix the parser'],
            constraints: [],
            decisions: [],
            openQuestions: [],
            keyFacts: [],
            filesInPlay: [],
            latestOutputs: [],
        },
        [
            {
                role: 'user',
                content: 'Please fix parser.js',
                attachments: [{ fileName: 'parser.js', type: 'document' }],
            },
            {
                role: 'assistant',
                content: 'I updated parser.js and added a guard around the JSON parse step.',
            },
        ],
        'test'
    );

    assert.strictEqual(merged.summary, 'Working on a bug fix');
    assert(merged.filesInPlay.includes('parser.js'));
    assert(merged.latestOutputs.some(item => item.includes('updated parser.js')));
    assert.strictEqual(merged.refreshReason, 'test');
    assert.strictEqual(merged.sourceMessageCount, 2);
});

