'use strict';

const SCHEMA_VERSION = 1;
const MAX_ITEMS_PER_SECTION = 6;
const MAX_ITEM_LENGTH = 220;
const MAX_SUMMARY_LENGTH = 500;
const MAX_TRANSCRIPT_MESSAGES = 18;
const TRANSCRIPT_OVERLAP_MESSAGES = 4;

function trimText(value, maxLength = MAX_ITEM_LENGTH) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function uniqueList(values, maxItems = MAX_ITEMS_PER_SECTION, maxItemLength = MAX_ITEM_LENGTH) {
    const seen = new Set();
    const items = [];
    for (const value of Array.isArray(values) ? values : []) {
        const text = trimText(value, maxItemLength);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(text);
        if (items.length >= maxItems) break;
    }
    return items;
}

function createEmptyWorkingMemory() {
    return {
        schemaVersion: SCHEMA_VERSION,
        summary: '',
        goals: [],
        constraints: [],
        decisions: [],
        openQuestions: [],
        keyFacts: [],
        filesInPlay: [],
        latestOutputs: [],
        sourceMessageCount: 0,
        lastUpdatedAt: null,
        stale: true,
        refreshReason: null,
    };
}

function normalizeWorkingMemory(input = {}) {
    const next = createEmptyWorkingMemory();
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        next.summary = trimText(input.summary, MAX_SUMMARY_LENGTH);
        next.goals = uniqueList(input.goals);
        next.constraints = uniqueList(input.constraints);
        next.decisions = uniqueList(input.decisions);
        next.openQuestions = uniqueList(input.openQuestions);
        next.keyFacts = uniqueList(input.keyFacts);
        next.filesInPlay = uniqueList(input.filesInPlay);
        next.latestOutputs = uniqueList(input.latestOutputs, 4, 260);
        next.sourceMessageCount = Math.max(0, parseInt(input.sourceMessageCount, 10) || 0);
        next.lastUpdatedAt = input.lastUpdatedAt ? String(input.lastUpdatedAt) : null;
        next.stale = input.stale !== false;
        next.refreshReason = input.refreshReason ? trimText(input.refreshReason, 80) : null;
    }

    if (!next.summary) {
        next.summary = buildFallbackSummary(next);
    }
    return next;
}

function sanitizeAttachment(attachment) {
    if (!attachment || typeof attachment !== 'object') return null;
    return {
        type: trimText(attachment.type, 40) || 'document',
        fileName: trimText(attachment.fileName, 160),
        mimeType: trimText(attachment.mimeType, 80),
        summary: trimText(attachment.summary, 220),
        excerpt: trimText(attachment.excerpt, 180),
        pageCount: Number.isFinite(attachment.pageCount) ? attachment.pageCount : null,
        chunkCount: Number.isFinite(attachment.chunkCount) ? attachment.chunkCount : null,
        parser: trimText(attachment.parser, 80),
    };
}

function sanitizeMessageForWorkingMemory(message) {
    const next = {
        role: message?.role === 'assistant' ? 'assistant' : 'user',
        content: trimText(message?.content, 4000),
        pinned: message?.pinned === true,
    };
    const attachments = (message?.attachments || message?.images || [])
        .map(sanitizeAttachment)
        .filter(Boolean);
    if (attachments.length > 0) next.attachments = attachments;
    return next;
}

function buildWorkingMemoryTranscriptWindow(messages, existingMemory = {}) {
    const sanitized = (Array.isArray(messages) ? messages : [])
        .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant'))
        .map(sanitizeMessageForWorkingMemory);
    if (sanitized.length <= MAX_TRANSCRIPT_MESSAGES) return sanitized;

    const normalized = normalizeWorkingMemory(existingMemory);
    const previousCount = Math.max(0, normalized.sourceMessageCount || 0);
    const incrementalStart = previousCount > 0 && previousCount < sanitized.length
        ? Math.max(0, previousCount - TRANSCRIPT_OVERLAP_MESSAGES)
        : Math.max(0, sanitized.length - MAX_TRANSCRIPT_MESSAGES);

    return sanitized.slice(incrementalStart);
}

function formatAttachmentSummary(attachments = []) {
    const lines = [];
    for (const attachment of attachments) {
        const bits = [];
        if (attachment.fileName) bits.push(attachment.fileName);
        if (attachment.type) bits.push(attachment.type);
        if (attachment.pageCount) bits.push(`${attachment.pageCount} pages`);
        if (attachment.chunkCount) bits.push(`${attachment.chunkCount} chunks`);
        if (attachment.parser) bits.push(attachment.parser);
        if (attachment.summary) bits.push(`summary: ${attachment.summary}`);
        else if (attachment.excerpt) bits.push(`excerpt: ${attachment.excerpt}`);
        const line = bits.join(' | ');
        if (line) lines.push(line);
    }
    return lines;
}

function buildWorkingMemoryTranscript(messages, existingMemory = {}) {
    const windowed = buildWorkingMemoryTranscriptWindow(messages, existingMemory);
    return windowed.map((message, index) => {
        const header = `[${index + 1}] ${message.role.toUpperCase()}${message.pinned ? ' [PINNED]' : ''}`;
        const parts = [header];
        if (message.content) parts.push(message.content);
        const attachmentLines = formatAttachmentSummary(message.attachments || []);
        if (attachmentLines.length > 0) {
            parts.push(`Attachments:\n- ${attachmentLines.join('\n- ')}`);
        }
        return parts.join('\n');
    }).join('\n\n---\n\n');
}

function buildFallbackSummary(memory) {
    const normalized = memory && typeof memory === 'object' ? memory : {};
    const pieces = [];
    if (trimText(normalized.summary, MAX_SUMMARY_LENGTH)) return trimText(normalized.summary, MAX_SUMMARY_LENGTH);
    if (Array.isArray(normalized.goals) && normalized.goals[0]) pieces.push(`Goal: ${normalized.goals[0]}`);
    if (Array.isArray(normalized.constraints) && normalized.constraints[0]) pieces.push(`Constraint: ${normalized.constraints[0]}`);
    if (Array.isArray(normalized.decisions) && normalized.decisions[0]) pieces.push(`Decision: ${normalized.decisions[0]}`);
    if (Array.isArray(normalized.openQuestions) && normalized.openQuestions[0]) pieces.push(`Open: ${normalized.openQuestions[0]}`);
    return trimText(pieces.join(' '), MAX_SUMMARY_LENGTH);
}

function inferFilesInPlay(messages, existingItems = []) {
    const inferred = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        const attachments = message?.attachments || message?.images || [];
        for (const attachment of attachments) {
            const name = trimText(attachment?.fileName, 160);
            if (name) inferred.push(name);
        }
    }
    return uniqueList([...(existingItems || []), ...inferred], MAX_ITEMS_PER_SECTION, 160);
}

function inferLatestOutputs(messages, existingItems = []) {
    const inferred = [];
    const assistantMessages = (Array.isArray(messages) ? messages : []).filter(msg => msg?.role === 'assistant');
    for (let i = assistantMessages.length - 1; i >= 0 && inferred.length < 4; i -= 1) {
        const content = trimText(assistantMessages[i]?.content, 260);
        if (!content) continue;
        const firstParagraph = trimText(content.split(/\n{2,}/)[0], 180);
        if (firstParagraph) inferred.push(firstParagraph);
    }
    return uniqueList([...inferred, ...(existingItems || [])], 4, 260);
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('No JSON content returned');

    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenceMatch ? fenceMatch[1].trim() : raw;

    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error('Could not find JSON object in model response');
    }
    return candidate.slice(firstBrace, lastBrace + 1);
}

function parseWorkingMemoryResponse(text) {
    const json = extractJsonObject(text);
    return normalizeWorkingMemory(JSON.parse(json));
}

function mergeWorkingMemory(existingMemory, candidateMemory, messages, refreshReason = 'refresh') {
    const existing = normalizeWorkingMemory(existingMemory);
    const candidate = normalizeWorkingMemory(candidateMemory);
    const merged = normalizeWorkingMemory({
        ...existing,
        ...candidate,
        filesInPlay: candidate.filesInPlay.length > 0
            ? candidate.filesInPlay
            : inferFilesInPlay(messages, existing.filesInPlay),
        latestOutputs: candidate.latestOutputs.length > 0
            ? candidate.latestOutputs
            : inferLatestOutputs(messages, existing.latestOutputs),
        summary: candidate.summary || existing.summary,
        sourceMessageCount: Array.isArray(messages) ? messages.length : existing.sourceMessageCount,
        lastUpdatedAt: new Date().toISOString(),
        stale: false,
        refreshReason,
    });

    if (!merged.summary) {
        merged.summary = buildFallbackSummary(merged);
    }
    return merged;
}

function buildWorkingMemoryPrompt({ existingMemory, messages }) {
    const normalized = normalizeWorkingMemory(existingMemory);
    const transcript = buildWorkingMemoryTranscript(messages, normalized);
    const compactMemory = {
        summary: normalized.summary,
        goals: normalized.goals,
        constraints: normalized.constraints,
        decisions: normalized.decisions,
        openQuestions: normalized.openQuestions,
        keyFacts: normalized.keyFacts,
        filesInPlay: normalized.filesInPlay,
        latestOutputs: normalized.latestOutputs,
    };

    return (
        'You maintain a compact working memory for an ongoing chat conversation.\n' +
        'Update the working memory JSON using the transcript below.\n\n' +
        'Return ONLY a JSON object with exactly these keys:\n' +
        '{\n' +
        '  "summary": string,\n' +
        '  "goals": string[],\n' +
        '  "constraints": string[],\n' +
        '  "decisions": string[],\n' +
        '  "openQuestions": string[],\n' +
        '  "keyFacts": string[],\n' +
        '  "filesInPlay": string[],\n' +
        '  "latestOutputs": string[]\n' +
        '}\n\n' +
        'Rules:\n' +
        '- Preserve stable context that will help future turns.\n' +
        '- Capture explicit user goals, constraints, decisions, and unresolved questions.\n' +
        '- Keep items concise, concrete, and non-duplicative.\n' +
        '- Do not invent facts or plans that are not grounded in the transcript.\n' +
        '- If a section has no useful content, return an empty array.\n' +
        '- Keep the summary under 90 words.\n' +
        '- Prefer file names over vague references like "the PDF".\n' +
        '- latestOutputs should capture the most recent useful assistant deliverables or recommendations.\n\n' +
        `Existing working memory:\n${JSON.stringify(compactMemory, null, 2)}\n\n` +
        `Conversation transcript:\n${transcript || '(empty conversation)' }\n`
    );
}

module.exports = {
    SCHEMA_VERSION,
    createEmptyWorkingMemory,
    normalizeWorkingMemory,
    sanitizeMessageForWorkingMemory,
    buildWorkingMemoryTranscriptWindow,
    buildWorkingMemoryTranscript,
    buildWorkingMemoryPrompt,
    parseWorkingMemoryResponse,
    mergeWorkingMemory,
    inferFilesInPlay,
    inferLatestOutputs,
    extractJsonObject,
};
