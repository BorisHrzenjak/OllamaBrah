// proxy/search.js — pure search/fetch utilities

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// --- Web Search (Tavily + Jina Reader) ---

const SEARCH_TRIGGERS = [
    /\b(today|yesterday|this (week|month|year)|right now|currently|latest|recent|newest)\b/i,
    /\b(breaking|just announced|just released|as of \d{4})\b/i,
    /\b(what('s| is| are) the? (current|latest|newest|price|score|weather))\b/i,
    /\b(news about|update on|what happened (to|with|at)|who won|who is the current)\b/i,
    /\b(20(24|25|26))\b/,
    /\b(stock price|weather forecast|election results|release date)\b/i,
];

function heuristicNeedsSearch(text) {
    return SEARCH_TRIGGERS.some(re => re.test(text));
}

// Pick the tightest time_range that matches the query intent
const DAY_TRIGGERS   = /\b(today|right now|currently|yesterday|breaking|just announced|just released)\b/i;
const WEEK_TRIGGERS  = /\b(this week|latest|recent|newest|past few days)\b/i;
const YEAR_TRIGGERS  = /\b(this year|20(24|25|26))\b/i;

function heuristicTimeRange(text) {
    if (DAY_TRIGGERS.test(text))  return 'day';
    if (WEEK_TRIGGERS.test(text)) return 'week';
    if (YEAR_TRIGGERS.test(text)) return 'year';
    return 'month'; // sensible default for time-sensitive queries
}

function extractUrls(text) {
    const urlRegex = /https?:\/\/[^\s)>,"'\]]+/g;
    return [...new Set(text.match(urlRegex) || [])];
}

// Jina Reader: fetches live page content as markdown, free, no API key needed.
// Returns the page text on success, or a { _fetchError, _status } object on failure — never throws.
async function fetchPageViaJina(url, maxChars = 4000) {
    const JINA_ERROR_HINTS = {
        400: 'Bad request — the URL may be malformed.',
        401: 'Jina requires authentication for this URL.',
        403: 'Access forbidden — the site is blocking Jina.',
        404: 'Page not found (404).',
        410: 'Page is gone (410) — content was removed.',
        429: 'Rate-limited by Jina — too many requests. Try again shortly.',
        451: 'Page unavailable for legal/regional reasons (HTTP 451). This site blocks automated access. Try a different source.',
        500: 'The target site returned a server error (500).',
        503: 'The target site is temporarily unavailable (503).',
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s max
    try {
        const resp = await fetch(`https://r.jina.ai/${url}`, {
            headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
            signal: controller.signal
        });
        if (!resp.ok) {
            const hint = JINA_ERROR_HINTS[resp.status] || `Jina returned HTTP ${resp.status}.`;
            return { _fetchError: `Could not fetch ${url} — ${hint}`, _status: resp.status };
        }
        const text = await resp.text();
        return text.slice(0, maxChars);
    } catch (err) {
        if (err.name === 'AbortError') {
            return { _fetchError: `Timed out fetching ${url} — the site took too long to respond.`, _status: 0 };
        }
        return { _fetchError: `Network error fetching ${url}: ${err.message}`, _status: 0 };
    } finally {
        clearTimeout(timeout);
    }
}

// Fetch a URL as a raw Buffer (follows up to 5 redirects)
async function fetchBinaryUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && maxRedirects > 0) {
                resolve(fetchBinaryUrl(resp.headers.location, maxRedirects - 1));
                return;
            }
            const bufs = [];
            resp.on('data', d => bufs.push(d));
            resp.on('end', () => resolve(Buffer.concat(bufs)));
            resp.on('error', reject);
        }).on('error', reject);
    });
}

const NEWS_TRIGGERS = [
    /\bnews\b/i,
    /\bheadlines?\b/i,
    /\bstories\b/i,
    /\breports?\b/i,
    /\bbreaking\b/i,
];

function heuristicNeedsNewsSearch(text) {
    return NEWS_TRIGGERS.some(re => re.test(text));
}

async function fetchTavilyResults(query, { topic, time_range } = {}) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey || apiKey === 'your_tavily_api_key_here') {
        const userDataPath = process.env.USER_DATA_PATH;
        const envLocation = userDataPath ? `${userDataPath}\\.env` : 'the .env file in the app folder';
        console.warn('[Search] TAVILY_API_KEY not set — skipping search. Add it to:', envLocation);
        return { _configError: `Web search is unavailable: no Tavily API key is configured. To enable web search, add TAVILY_API_KEY=<your_key> to ${envLocation}. You can get a free key at https://tavily.com. In the meantime, you can still fetch specific pages directly using the fetchPage tool if you have a URL.` };
    }

    // For tight time ranges, auto-elevate to news topic and advanced depth
    // to avoid historical "on this day" noise and get genuinely fresh results
    const isUrgent = time_range === 'day' || time_range === 'week';
    if (isUrgent && !topic) topic = 'news';

    // Append today's date to the query for time-sensitive searches so Tavily
    // biases toward current results instead of historical "on this day" pages
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const enrichedQuery = time_range ? `${query.slice(0, 280)} ${today}` : query.slice(0, 300);

    const body = {
        api_key: apiKey,
        query: enrichedQuery,
        max_results: 5,
        search_depth: isUrgent ? 'advanced' : 'basic',
    };
    if (topic)      body.topic      = topic;
    if (time_range) body.time_range = time_range;
    console.log(`[Search] Tavily request: topic=${topic || 'general'}, time_range=${time_range || 'none'}, depth=${body.search_depth}, query="${enrichedQuery.slice(0, 100)}"`);
    const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
    return resp.json();
}

async function fetchExaResearch(query) {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey || apiKey === 'your_exa_api_key_here') {
        console.warn('[Research] EXA_API_KEY not set in .env — skipping deep research');
        return null;
    }
    console.log(`[Research] Querying Exa for: "${query.slice(0, 100)}"`);
    const resp = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: query.slice(0, 500),
            numResults: 5,
            type: 'auto',
            contents: {
                text: { maxCharacters: 2000 },
                highlights: { numSentences: 3, highlightsPerUrl: 3 }
            }
        })
    });
    if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        throw new Error(`Exa HTTP ${resp.status}: ${errorText}`);
    }
    return resp.json();
}

function formatExaResults(data) {
    if (!data?.results?.length) return null;
    const sections = data.results.map((r, i) => {
        const title = r.title || 'Untitled';
        const url = r.url || '';
        const lines = [
            `[${i + 1}] Title: ${title}`,
            `    URL: ${url}`,
        ];
        if (r.publishedDate) lines.push(`    Published: ${r.publishedDate.slice(0, 10)}`);
        if (r.text) lines.push(`\n${r.text.trim()}`);
        if (r.highlights?.length) lines.push(`\nKey highlights:\n${r.highlights.map(h => `- ${h}`).join('\n')}`);
        return lines.join('\n');
    });
    return sections.join('\n\n---\n\n');
}

// Build search metadata object for the frontend search step UI
function buildSearchMeta({ searchType, query, searchData, jinaResults, contextParts, heuristicTriggered }) {
    const meta = {
        searchType, // 'web' | 'deep_research'
        query: query.slice(0, 300),
        results: [],
        urlsFetched: [],
        contextTokens: 0,
        heuristicTriggered: !!heuristicTriggered
    };

    if (searchData?.results?.length > 0) {
        meta.results = searchData.results.map(r => ({
            title: r.title || r.url || '',
            url: r.url || '',
            snippet: (r.content || r.text || '').slice(0, 200)
        }));
    }

    if (jinaResults) {
        jinaResults.forEach(r => {
            if (r.status === 'fulfilled') {
                meta.urlsFetched.push({ url: r.value.url, chars: r.value.content.length });
            }
        });
    }

    // Estimate token cost of injected context (~3.5 chars per token)
    const contextText = contextParts.join('\n\n');
    meta.contextTokens = Math.ceil(contextText.length / 3.5);

    return meta;
}

module.exports = {
    SEARCH_TRIGGERS,
    heuristicNeedsSearch,
    heuristicNeedsNewsSearch,
    heuristicTimeRange,
    extractUrls,
    fetchPageViaJina,
    fetchBinaryUrl,
    fetchTavilyResults,
    fetchExaResearch,
    formatExaResults,
    buildSearchMeta,
};
