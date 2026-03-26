'use strict';

const { parsePdfBuffer } = require('./document-parser');

const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 180;
const MAX_SUMMARY_CHARS = 500;

function cleanText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function summarizeText(text) {
    const paragraphs = cleanText(text)
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);
    const picked = [];
    let total = 0;
    for (const paragraph of paragraphs) {
        if (paragraph.length < 30) continue;
        picked.push(paragraph);
        total += paragraph.length;
        if (picked.length >= 2 || total >= MAX_SUMMARY_CHARS) break;
    }
    const summary = picked.join(' ').slice(0, MAX_SUMMARY_CHARS).trim();
    return summary || cleanText(text).slice(0, MAX_SUMMARY_CHARS).trim();
}

function chunkText(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return [];

    const paragraphs = cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let current = '';

    const pushChunk = (value) => {
        const normalized = value.trim();
        if (!normalized) return;
        chunks.push({
            id: `chunk_${chunks.length + 1}`,
            text: normalized,
            charCount: normalized.length,
            preview: normalized.slice(0, 160)
        });
    };

    for (const paragraph of paragraphs) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length <= MAX_CHUNK_CHARS) {
            current = candidate;
            continue;
        }

        if (current) pushChunk(current);

        if (paragraph.length <= MAX_CHUNK_CHARS) {
            current = paragraph;
            continue;
        }

        let start = 0;
        while (start < paragraph.length) {
            const end = Math.min(start + MAX_CHUNK_CHARS, paragraph.length);
            pushChunk(paragraph.slice(start, end));
            if (end >= paragraph.length) break;
            start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
        }
        current = '';
    }

    if (current) pushChunk(current);
    return chunks;
}

async function extractPdfText(base64, fileName) {
    const buffer = Buffer.from(base64, 'base64');
    const data = await parsePdfBuffer(buffer, {
        fileName,
        source: 'attachment',
    });
    return {
        text: data.text || '',
        pageCount: data.pageCount || null,
        parser: data.parser || 'unknown',
        truncated: !!data.truncated,
    };
}

async function processAttachment(attachment) {
    const mimeType = attachment.mimeType || '';
    let text = attachment.textContent || '';
    let pageCount = null;
    let parser = null;
    let truncated = false;

    if (mimeType === 'application/pdf' || /\.pdf$/i.test(attachment.fileName || '')) {
        if (!attachment.base64) {
            throw new Error('PDF processing requires base64 content.');
        }
        const pdf = await extractPdfText(attachment.base64, attachment.fileName);
        text = pdf.text;
        pageCount = pdf.pageCount;
        parser = pdf.parser;
        truncated = pdf.truncated;
    }

    const cleaned = cleanText(text);
    if (!cleaned) {
        throw new Error('No readable text could be extracted from this document.');
    }

    const chunks = chunkText(cleaned);
    return {
        type: 'document',
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        mimeType,
        summary: summarizeText(cleaned),
        excerpt: cleaned.slice(0, 240),
        extractedCharCount: cleaned.length,
        chunkCount: chunks.length,
        pageCount,
        parser,
        truncated,
        chunks,
    };
}

async function handleProcessAttachments(req, res) {
    try {
        const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
        if (!attachments.length) {
            return res.status(400).json({ error: 'No attachments provided.' });
        }

        const processed = [];
        for (const attachment of attachments) {
            processed.push(await processAttachment(attachment));
        }
        res.json({ attachments: processed });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to process attachments.' });
    }
}

module.exports = {
    handleProcessAttachments,
};
