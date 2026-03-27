'use strict';

const pdfParse = require('pdf-parse');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorker } = require('tesseract.js');

const DEFAULT_OCR_LANGUAGE = 'eng';
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_DPI = 150;
const OCR_CACHE_DIR = path.join(process.env.USER_DATA_PATH || process.cwd(), 'tesseract-cache');

let liteParseModulePromise = null;
const liteParseInstancePromises = new Map();

function now() {
    return Date.now();
}

function logPdfParseEvent(stage, details = {}) {
    const parts = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${String(value)}`);
    console.log(`[pdf-parser] ${stage}${parts.length ? ' | ' + parts.join(' | ') : ''}`);
}

function clonePdfBuffer(buffer) {
    return Buffer.from(buffer);
}

function createTempPdfPath() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return path.join(os.tmpdir(), `ollamabrah-liteparse-${token}.pdf`);
}

async function getLiteParseModule() {
    if (!liteParseModulePromise) {
        liteParseModulePromise = import('@llamaindex/liteparse');
    }
    return liteParseModulePromise;
}

async function getLiteParseInstance({ ocrLanguage = DEFAULT_OCR_LANGUAGE, maxPages = DEFAULT_MAX_PAGES } = {}) {
    const cacheKey = `${ocrLanguage}:${maxPages}`;
    if (!liteParseInstancePromises.has(cacheKey)) {
        liteParseInstancePromises.set(cacheKey, getLiteParseModule().then(({ LiteParse }) => new LiteParse({
            outputFormat: 'json',
            ocrEnabled: true,
            ocrLanguage,
            dpi: DEFAULT_DPI,
            maxPages,
        })));
    }
    return liteParseInstancePromises.get(cacheKey);
}

function getFriendlyPdfError(err) {
    const message = String(err && err.message ? err.message : err || '').trim();
    const lower = message.toLowerCase();

    if (lower.includes('password') || lower.includes('encrypted') || lower.includes('protected')) {
        return 'This PDF appears to be protected and could not be opened.';
    }

    if (
        lower.includes('tesseract')
        || lower.includes('ocr')
        || lower.includes('traineddata')
        || lower.includes('fetch failed')
        || lower.includes('network')
        || lower.includes('download')
    ) {
        return 'This PDF appears to be scan-based. No readable text could be extracted on this device yet.';
    }

    return 'No readable text could be extracted from this PDF.';
}

async function parseWithLiteParse(buffer, { fileName, ocrLanguage, maxPages, source }) {
    const startedAt = now();
    const parser = await getLiteParseInstance({ ocrLanguage, maxPages });
    const result = await parser.parse(clonePdfBuffer(buffer), true);
    const text = String(result && result.text ? result.text : '');
    const pageCount = Array.isArray(result && result.pages) ? result.pages.length : null;
    const truncated = Boolean(pageCount && maxPages && pageCount === maxPages);
    const elapsedMs = now() - startedAt;

    logPdfParseEvent('liteparse_success', {
        source,
        fileName,
        elapsedMs,
        pageCount,
        textLength: text.length,
        truncated,
        ocrLanguage,
    });

    return {
        text,
        pageCount,
        parser: 'liteparse',
        truncated,
    };
}

async function parseWithPdfParse(buffer, { fileName, source, reason }) {
    const startedAt = now();
    const result = await pdfParse(clonePdfBuffer(buffer), { max: 0 });
    const text = String(result && result.text ? result.text : '');
    const pageCount = result && result.numpages ? result.numpages : null;
    const elapsedMs = now() - startedAt;

    logPdfParseEvent('pdf_parse_fallback_success', {
        source,
        fileName,
        reason,
        elapsedMs,
        pageCount,
        textLength: text.length,
    });

    return {
        text,
        pageCount,
        parser: 'pdf-parse-fallback',
        truncated: false,
    };
}

async function createOcrWorker(ocrLanguage) {
    return createWorker(ocrLanguage, undefined, {
        cachePath: OCR_CACHE_DIR,
        gzip: true,
    });
}

async function ocrImageBuffer(worker, imageBuffer, { fileName, source, pageNum, ocrLanguage }) {
    const startedAt = now();
    const result = await worker.recognize(imageBuffer);
    const text = String(result && result.data && result.data.text ? result.data.text : '');
    const elapsedMs = now() - startedAt;

    logPdfParseEvent('screenshot_ocr_page', {
        source,
        fileName,
        pageNum,
        elapsedMs,
        textLength: text.trim().length,
        ocrLanguage,
    });

    return text;
}

async function parseImageBuffer(buffer, options = {}) {
    const fileName = options.fileName || 'unknown-image';
    const source = options.source || 'unknown';
    const ocrLanguage = options.ocrLanguage || DEFAULT_OCR_LANGUAGE;
    const worker = await createOcrWorker(ocrLanguage);

    try {
        const text = await ocrImageBuffer(worker, clonePdfBuffer(buffer), {
            fileName,
            source,
            pageNum: 1,
            ocrLanguage,
        });

        return {
            text,
            pageCount: 1,
            parser: 'tesseract-image-ocr',
            truncated: false,
        };
    } finally {
        try { await worker.terminate(); } catch (_) {}
    }
}

async function parseWithScreenshotOcr(buffer, { fileName, ocrLanguage, maxPages, source }) {
    const startedAt = now();
    const parser = await getLiteParseInstance({ ocrLanguage, maxPages });
    const tempPdfPath = createTempPdfPath();
    fs.writeFileSync(tempPdfPath, clonePdfBuffer(buffer));
    let screenshots;
    try {
        screenshots = await parser.screenshot(tempPdfPath, undefined, true);
    } finally {
        try { fs.unlinkSync(tempPdfPath); } catch (_) {}
    }
    const pageCount = Array.isArray(screenshots) ? screenshots.length : 0;
    const pageTexts = [];
    const worker = await createOcrWorker(ocrLanguage);

    try {
        for (const shot of screenshots || []) {
            const pageText = await ocrImageBuffer(worker, shot.imageBuffer, {
                fileName,
                source,
                pageNum: shot.pageNum,
                ocrLanguage,
            });
            pageTexts.push(String(pageText || '').trim());
        }
    } finally {
        try { await worker.terminate(); } catch (_) {}
    }

    const text = pageTexts.filter(Boolean).join('\n\n');
    const elapsedMs = now() - startedAt;
    const truncated = Boolean(pageCount && maxPages && pageCount === maxPages);

    logPdfParseEvent('screenshot_ocr_complete', {
        source,
        fileName,
        elapsedMs,
        pageCount,
        textLength: text.length,
        truncated,
        ocrLanguage,
    });

    return {
        text,
        pageCount: pageCount || null,
        parser: 'liteparse-screenshot-ocr',
        truncated,
    };
}

async function parsePdfBuffer(buffer, options = {}) {
    const fileName = options.fileName || 'unknown.pdf';
    const source = options.source || 'unknown';
    const ocrLanguage = options.ocrLanguage || DEFAULT_OCR_LANGUAGE;
    const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : DEFAULT_MAX_PAGES;
    let liteParseError = null;

    try {
        const liteResult = await parseWithLiteParse(buffer, { fileName, ocrLanguage, maxPages, source });
        if (liteResult.text.trim()) {
            return liteResult;
        }
        logPdfParseEvent('liteparse_empty_result', {
            source,
            fileName,
            pageCount: liteResult.pageCount,
            truncated: liteResult.truncated,
        });
    } catch (err) {
        liteParseError = err;
        logPdfParseEvent('liteparse_failed', {
            source,
            fileName,
            error: err && err.message ? err.message : String(err),
            ocrLanguage,
        });
    }

    try {
        const screenshotOcrResult = await parseWithScreenshotOcr(buffer, {
            fileName,
            ocrLanguage,
            maxPages,
            source,
        });
        if (screenshotOcrResult.text.trim()) {
            return screenshotOcrResult;
        }
        logPdfParseEvent('screenshot_ocr_empty', {
            source,
            fileName,
            pageCount: screenshotOcrResult.pageCount,
            truncated: screenshotOcrResult.truncated,
        });
    } catch (screenshotErr) {
        logPdfParseEvent('screenshot_ocr_failed', {
            source,
            fileName,
            error: screenshotErr && screenshotErr.message ? screenshotErr.message : String(screenshotErr),
            ocrLanguage,
        });
    }

    try {
        const fallbackResult = await parseWithPdfParse(buffer, {
            fileName,
            source,
            reason: liteParseError ? 'liteparse_error_after_screenshot_ocr' : 'liteparse_empty_after_screenshot_ocr',
        });
        if (fallbackResult.text.trim()) {
            return fallbackResult;
        }
        logPdfParseEvent('pdf_parse_fallback_empty', {
            source,
            fileName,
            pageCount: fallbackResult.pageCount,
        });
    } catch (fallbackErr) {
        logPdfParseEvent('pdf_parse_fallback_failed', {
            source,
            fileName,
            error: fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr),
        });
    }

    throw new Error(getFriendlyPdfError(liteParseError));
}

module.exports = {
    parseImageBuffer,
    parsePdfBuffer,
};
