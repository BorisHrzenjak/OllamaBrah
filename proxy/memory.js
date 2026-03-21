'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { LocalDocumentIndex } = require('vectra/lib/LocalDocumentIndex');

const MEMORY_DIR = process.env.MEMORY_DIR
    || path.join(os.homedir(), '.ollamabar', 'memory');
const EMBED_MODEL = process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text';

function getOllamaBaseUrl() {
    return (process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434').trim().replace(/\/$/, '');
}

function formatOllamaConnectionError(err) {
    const message = String(err?.message || err || 'Unknown error');
    if (message.includes('Failed to parse URL')) {
        return 'Ollama URL is invalid. Check OLLAMA_API_BASE_URL in your environment or .env file.';
    }
    if (message === 'fetch failed') {
        return 'Ollama is not reachable for memory setup.';
    }
    return message;
}

let _index = null;

function normalizeMemoryRecord(id, meta = {}, score = null) {
    return {
        id,
        text: meta?.text ?? '',
        score,
        timestamp: meta?.timestamp,
        source: meta?.source || 'unknown',
        sourceType: meta?.sourceType || meta?.source || 'unknown',
        createdAt: meta?.createdAt || meta?.timestamp,
        conversationId: meta?.conversationId || null,
        messageId: meta?.messageId || null,
        extractionMode: meta?.extractionMode || 'manual',
        reviewed: meta?.reviewed !== false,
        origin: meta?.origin || null,
    };
}

async function embedTexts(inputs) {
    const resp = await fetch(`${getOllamaBaseUrl()}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: inputs })
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Ollama embed HTTP ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    if (!data.embeddings || data.embeddings.length === 0) {
        throw new Error('Ollama returned empty embeddings — is nomic-embed-text pulled?');
    }
    return data.embeddings;
}

async function getIndex() {
    if (_index) return _index;
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const idx = new LocalDocumentIndex({
        folderPath: MEMORY_DIR,
        embeddings: {
            createEmbeddings: async (inputs) => {
                try {
                    const arr = Array.isArray(inputs) ? inputs : [inputs];
                    const output = await embedTexts(arr);
                    return { status: 'success', output };
                } catch (err) {
                    return { status: 'error', message: err.message };
                }
            }
        }
    });
    if (!(await idx.isCatalogCreated())) {
        await idx.createIndex();
    }
    _index = idx;
    return _index;
}

const DEDUP_THRESHOLD = 0.75; // cosine similarity above this = semantically duplicate

const CANONICAL_TERM_ALIASES = [
    [/\bUser's\s+mom\b/gi, "User's mother"],
    [/\bUser's\s+mum\b/gi, "User's mother"],
    [/\bUser's\s+mother\b/gi, "User's mother"],
    [/\bUser's\s+mommy\b/gi, "User's mother"],
    [/\bUser's\s+dad\b/gi, "User's father"],
    [/\bUser's\s+daddy\b/gi, "User's father"],
    [/\bUser's\s+father\b/gi, "User's father"],
    [/\bUser's\s+bro\b/gi, "User's brother"],
    [/\bUser's\s+brother\b/gi, "User's brother"],
    [/\bUser's\s+sis\b/gi, "User's sister"],
    [/\bUser's\s+sister\b/gi, "User's sister"],
    [/\bUser's\s+wife\b/gi, "User's spouse"],
    [/\bUser's\s+husband\b/gi, "User's spouse"],
    [/\bUser's\s+partner\b/gi, "User's spouse"],
];

const CANONICAL_PHRASE_ALIASES = [
    [/\bis\s+called\b/gi, 'is named'],
    [/\bis\s+named\s+named\b/gi, 'is named'],
    [/\blives\s+at\b/gi, 'lives in'],
    [/\bworks\s+on\b/gi, 'works with'],
    [/\buses\s+([^,.!\n]+)\s+as\s+([^,.!\n]+)/gi, 'uses $1 for $2'],
];

function normalizeMemoryText(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function canonicalizeMemoryText(text) {
    let output = String(text || '');
    for (const [pattern, replacement] of CANONICAL_TERM_ALIASES) {
        output = output.replace(pattern, replacement);
    }
    for (const [pattern, replacement] of CANONICAL_PHRASE_ALIASES) {
        output = output.replace(pattern, replacement);
    }
    return output.replace(/\s+/g, ' ').trim();
}

function lexicalOverlapScore(a, b) {
    const aTokens = new Set(normalizeMemoryText(a).split(' ').filter(t => t.length >= 3));
    const bTokens = new Set(normalizeMemoryText(b).split(' ').filter(t => t.length >= 3));
    if (!aTokens.size || !bTokens.size) return 0;
    let overlap = 0;
    aTokens.forEach(token => { if (bTokens.has(token)) overlap += 1; });
    return overlap / Math.max(aTokens.size, bTokens.size);
}

function tokenizeMemoryText(text) {
    return normalizeMemoryText(text).split(' ').filter(t => t.length >= 2);
}

function lexicalQueryScore(query, candidate) {
    const queryNorm = normalizeMemoryText(query);
    const candidateNorm = normalizeMemoryText(candidate);
    if (!queryNorm || !candidateNorm) return 0;

    let score = 0;
    if (candidateNorm === queryNorm) score += 10;
    if (candidateNorm.includes(queryNorm)) score += 6;

    const queryTokens = tokenizeMemoryText(query);
    const candidateTokens = new Set(tokenizeMemoryText(candidate));
    let matchedTokens = 0;
    let strongMatches = 0;

    for (const token of queryTokens) {
        if (candidateTokens.has(token)) {
            matchedTokens += 1;
            score += token.length >= 5 ? 2.5 : 1.5;
            if (token.length >= 4) strongMatches += 1;
        }
    }

    if (queryTokens.length > 0) {
        score += (matchedTokens / queryTokens.length) * 4;
    }
    if (strongMatches >= 2) score += 3;

    const overlap = lexicalOverlapScore(query, candidate);
    score += overlap * 4;
    return score;
}

function hybridRankScore(query, candidateText, semanticScore) {
    const lexicalScore = lexicalQueryScore(query, candidateText);
    const semanticComponent = Math.max(0, semanticScore || 0) * 8;
    return {
        lexicalScore,
        score: lexicalScore + semanticComponent,
    };
}

async function addMemory(text, metadata = {}) {
    const index = await getIndex();
    const canonicalText = canonicalizeMemoryText(text);
    const canonicalNorm = normalizeMemoryText(canonicalText);

    try {
        const docs = await index.listDocuments();
        for (const doc of docs) {
            const meta = await doc.loadMetadata().catch(() => ({}));
            const existingText = meta?.text || '';
            const existingCanonicalNorm = normalizeMemoryText(canonicalizeMemoryText(existingText));
            if (existingCanonicalNorm && existingCanonicalNorm === canonicalNorm) {
                console.log(`[Memory] Skipping canonical duplicate: "${existingText.slice(0, 80)}"`);
                return doc.uri;
            }
        }
    } catch (err) {
        console.warn('[Memory] Canonical duplicate check failed, continuing:', err.message);
    }

    // Check for semantically similar existing memory before saving
    try {
        const similar = await index.queryDocuments(canonicalText, { maxDocuments: 1 });
        if (similar.length > 0 && similar[0].score >= DEDUP_THRESHOLD) {
            const meta = await similar[0].loadMetadata().catch(() => ({}));
            const existingText = meta?.text || '';
            const incomingNorm = canonicalNorm;
            const existingNorm = normalizeMemoryText(existingText);
            const overlap = lexicalOverlapScore(canonicalText, existingText);
            const sameMeaning = incomingNorm === existingNorm
                || incomingNorm.includes(existingNorm)
                || existingNorm.includes(incomingNorm)
                || overlap >= 0.6;
            if (sameMeaning) {
                console.log(`[Memory] Skipping duplicate (score: ${similar[0].score.toFixed(3)}, overlap: ${overlap.toFixed(2)}): "${existingText.slice(0, 80)}"`);
                return similar[0].uri; // return existing ID without saving
            }
        }
    } catch (err) {
        console.warn('[Memory] Dedup check failed, saving anyway:', err.message);
    }

    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await index.upsertDocument(id, text, 'text', {
        text: canonicalText,
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        reviewed: metadata.reviewed !== false,
        ...metadata
    });
    return id;
}

async function updateMemory(id, updates = {}) {
    const index = await getIndex();
    const docs = await index.listDocuments();
    const item = docs.find(doc => doc.uri === id);
    if (!item) throw new Error('Memory not found');
    const meta = await item.loadMetadata().catch(() => ({}));
    const next = {
        ...meta,
        ...updates,
        text: canonicalizeMemoryText(updates.text ?? meta.text),
    };
    await index.upsertDocument(id, next.text, 'text', next);
    return normalizeMemoryRecord(id, next, null);
}

async function searchMemories(query, k = 3) {
    try {
        const index = await getIndex();
        const docs = await index.listDocuments();
        const semanticResults = await index.queryDocuments(query, { maxDocuments: Math.max(k * 3, 12) });
        const semanticById = new Map(semanticResults.map(r => [r.uri, r.score]));

        const hydrated = await Promise.all(docs.map(async (doc) => {
            const meta = await doc.loadMetadata().catch(() => ({}));
            const text = meta?.text ?? '';
            const semanticScore = semanticById.get(doc.uri) ?? 0;
            const ranked = hybridRankScore(query, text, semanticScore);
            return {
                id: doc.uri,
                meta,
                semanticScore,
                lexicalScore: ranked.lexicalScore,
                hybridScore: ranked.score,
            };
        }));

        const filtered = hydrated
            .filter(item => item.semanticScore > 0.1 || item.lexicalScore >= 2.5)
            .sort((a, b) => b.hybridScore - a.hybridScore || new Date(b.meta?.timestamp || 0) - new Date(a.meta?.timestamp || 0))
            .slice(0, k);

        return filtered.map((r) => {
            const record = normalizeMemoryRecord(r.id, r.meta, r.hybridScore);
            record.semanticScore = r.semanticScore;
            record.lexicalScore = r.lexicalScore;
            return record;
        });
    } catch (err) {
        console.warn('[Memory] Search failed:', err.message);
        return [];
    }
}

async function listMemories() {
    try {
        _index = null; // always read fresh from disk so external changes are visible
        const index = await getIndex();
        const docs = await index.listDocuments();
        const results = await Promise.all(docs.map(async (d) => {
            const meta = await d.loadMetadata().catch(() => ({}));
            return normalizeMemoryRecord(d.uri, meta, null);
        }));
        return results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    } catch (err) {
        console.warn('[Memory] List failed:', err.message);
        return [];
    }
}

async function deleteMemory(id) {
    const index = await getIndex();
    await index.deleteDocument(id);
}

async function clearMemories() {
    _index = null;
    try { fs.rmSync(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    await getIndex(); // re-init with fresh index
}

async function dedupeExistingMemories() {
    const index = await getIndex();
    const docs = await index.listDocuments();
    const hydrated = await Promise.all(docs.map(async (doc) => {
        const meta = await doc.loadMetadata().catch(() => ({}));
        const text = meta?.text || '';
        return {
            doc,
            meta,
            text,
            canonicalText: canonicalizeMemoryText(text),
            canonicalNorm: normalizeMemoryText(canonicalizeMemoryText(text)),
            timestamp: meta?.timestamp || meta?.createdAt || null,
        };
    }));

    const groups = new Map();
    hydrated.forEach(item => {
        if (!item.canonicalNorm) return;
        if (!groups.has(item.canonicalNorm)) groups.set(item.canonicalNorm, []);
        groups.get(item.canonicalNorm).push(item);
    });

    let updated = 0;
    let removed = 0;
    const merged = [];

    for (const [canonicalNorm, items] of groups.entries()) {
        items.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
        const keep = items[0];
        if ((keep.text || '') !== keep.canonicalText) {
            await index.upsertDocument(keep.doc.uri, keep.canonicalText, 'text', {
                ...keep.meta,
                text: keep.canonicalText,
            });
            updated += 1;
        }

        if (items.length > 1) {
            for (const duplicate of items.slice(1)) {
                await index.deleteDocument(duplicate.doc.uri);
                removed += 1;
            }
            merged.push({ canonical: keep.canonicalText, removed: items.length - 1 });
        }
    }

    return { updated, removed, merged };
}

async function getStatus() {
    try {
        const resp = await fetch(`${getOllamaBaseUrl()}/api/tags`);
        if (!resp.ok) return { available: false, reason: 'Ollama not reachable', count: 0 };
        const data = await resp.json();
        const models = data.models || [];
        const hasEmbed = models.some(m => m.name && m.name.startsWith('nomic-embed-text'));
        const memories = await listMemories();
        return {
            available: hasEmbed,
            embedModel: EMBED_MODEL,
            memoryDir: MEMORY_DIR,
            count: memories.length,
            reason: hasEmbed ? null : `Run: ollama pull ${EMBED_MODEL}`
        };
    } catch (err) {
        return { available: false, reason: formatOllamaConnectionError(err), count: 0 };
    }
}

module.exports = { addMemory, updateMemory, searchMemories, listMemories, deleteMemory, clearMemories, dedupeExistingMemories, getStatus };
