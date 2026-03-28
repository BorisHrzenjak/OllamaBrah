'use strict';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const FALLBACK_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

let cachedReachableBaseUrl = null;

function normalizeBaseUrl(url) {
    const value = String(url || '').trim().replace(/\/$/, '');
    if (!value) return DEFAULT_OLLAMA_BASE_URL;
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported Ollama URL protocol: ${parsed.protocol}`);
    }
    return parsed.toString().replace(/\/$/, '');
}

function getConfiguredOllamaBaseUrl() {
    return normalizeBaseUrl(process.env.OLLAMA_API_BASE_URL || DEFAULT_OLLAMA_BASE_URL);
}

function getOllamaBaseUrlCandidates() {
    const configured = getConfiguredOllamaBaseUrl();
    const candidates = [cachedReachableBaseUrl, configured];

    if (!process.env.OLLAMA_API_BASE_URL) {
        if (configured === DEFAULT_OLLAMA_BASE_URL) {
            candidates.push(FALLBACK_OLLAMA_BASE_URL);
        } else if (configured === FALLBACK_OLLAMA_BASE_URL) {
            candidates.push(DEFAULT_OLLAMA_BASE_URL);
        }
    }

    return [...new Set(candidates.filter(Boolean))];
}

async function fetchOllama(pathname, options = {}) {
    let lastError = null;
    for (const baseUrl of getOllamaBaseUrlCandidates()) {
        try {
            const response = await fetch(`${baseUrl}${pathname}`, options);
            cachedReachableBaseUrl = baseUrl;
            return response;
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Ollama is not reachable.');
}

async function resolveOllamaBaseUrl(probePath = '/api/tags') {
    if (cachedReachableBaseUrl) return cachedReachableBaseUrl;
    await fetchOllama(probePath, { signal: AbortSignal.timeout(1500) });
    return cachedReachableBaseUrl || getConfiguredOllamaBaseUrl();
}

module.exports = {
    DEFAULT_OLLAMA_BASE_URL,
    getConfiguredOllamaBaseUrl,
    getOllamaBaseUrlCandidates,
    fetchOllama,
    resolveOllamaBaseUrl,
};
