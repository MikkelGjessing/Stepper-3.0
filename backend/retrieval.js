/**
 * Ask Stepper – Retrieval layer
 *
 * Provides `retrieveForKB(query)` and `retrieveForCurrentArticle(articleId, content, query)`
 * that search the knowledge base and return ranked article excerpts for the LLM.
 *
 * Replace the ServiceNow helpers with calls to any other KB backend as needed.
 */

'use strict';

// Use the built-in fetch available in Node 18+.
// If running on an older Node version that ships node-fetch, it can be
// required here; the built-in global is sufficient for Node >=18.
const _fetch = globalThis.fetch;

const SN_BASE_URL = process.env.SN_BASE_URL || '';
const SN_USERNAME = process.env.SN_USERNAME || '';
const SN_PASSWORD = process.env.SN_PASSWORD || '';

/**
 * Escape special characters in a string for safe inclusion in a ServiceNow
 * sysparm_query value. Prevents query injection by stripping/replacing
 * characters that have meaning in SN query syntax (^, %, NI, LIKE operators, etc.).
 *
 * We allow alphanumerics, spaces, hyphens and dots; everything else is stripped.
 * @param {string} str
 * @returns {string}
 */
function escapeSnQuery(str) {
  // Keep only characters that are safe in a LIKE/textLIKE operand value
  return String(str || '').replace(/[^a-zA-Z0-9 \-_.]/g, '');
}

/**
 * Search ServiceNow KB for articles matching `query`.
 * Returns up to `limit` articles with id, title, and text excerpt.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Promise<Array<{articleId:string, title:string, snippet:string, score:number}>>}
 */
async function searchServiceNow(query, limit = 5) {
  if (!SN_BASE_URL || !SN_USERNAME || !SN_PASSWORD) {
    console.warn('[retrieval] ServiceNow credentials not configured – returning empty results');
    return [];
  }

  const escaped = escapeSnQuery(query);
  const url =
    SN_BASE_URL.replace(/\/$/, '') +
    `?sysparm_query=workflow_state=published^textLIKE${escaped}` +
    `&sysparm_limit=${limit}` +
    `&sysparm_fields=sys_id,short_description,text`;

  const authHeader =
    'Basic ' + Buffer.from(`${SN_USERNAME}:${SN_PASSWORD}`).toString('base64');

  const res = await _fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/json' }
  });

  if (!res.ok) {
    throw new Error(`ServiceNow search failed: ${res.status}`);
  }

  const json = await res.json();
  const articles = json.result || [];

  return articles.map((a, i) => ({
    articleId: a.sys_id || `unknown-${i}`,
    title: a.short_description || 'Untitled',
    snippet: trimSnippet(a.text || '', 400),
    // Assign a mock descending relevance score; integrate a proper ranker if needed.
    score: Math.max(0.1, 1 - i * 0.15)
  }));
}

/**
 * Strip HTML tags and trim a text snippet to `maxChars` characters.
 * @param {string} html
 * @param {number} maxChars
 * @returns {string}
 */
function trimSnippet(html, maxChars) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/**
 * Retrieve KB articles relevant to `query` (KB mode).
 *
 * @param {string} query
 * @returns {Promise<Array<import('./types').ChatSource>>}
 */
async function retrieveForKB(query) {
  return searchServiceNow(query, 5);
}

/**
 * Retrieve context for a single open article (current-article mode).
 * When `content` is supplied by the extension we use it directly;
 * otherwise we attempt to fetch the article from ServiceNow.
 *
 * @param {string} articleId
 * @param {string} [content] - Plain-text article body passed from the extension
 * @param {string} query
 * @returns {Promise<Array<import('./types').ChatSource>>}
 */
async function retrieveForCurrentArticle(articleId, content, query) {
  if (content) {
    return [
      {
        articleId,
        title: 'Current article',
        snippet: trimSnippet(content, 1500),
        score: 1.0
      }
    ];
  }

  // Fall back to a ServiceNow lookup by sys_id
  if (!SN_BASE_URL || !SN_USERNAME || !SN_PASSWORD || !articleId) {
    return [];
  }

  const url =
    SN_BASE_URL.replace(/\/$/, '') +
    `/${encodeURIComponent(articleId)}` +
    `?sysparm_fields=sys_id,short_description,text`;

  const authHeader =
    'Basic ' + Buffer.from(`${SN_USERNAME}:${SN_PASSWORD}`).toString('base64');

  try {
    const res = await _fetch(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    });
    if (!res.ok) return [];
    const json = await res.json();
    const a = json.result || {};
    return [
      {
        articleId: a.sys_id || articleId,
        title: a.short_description || 'Current article',
        snippet: trimSnippet(a.text || '', 1500),
        score: 1.0
      }
    ];
  } catch (_) {
    return [];
  }
}

module.exports = { retrieveForKB, retrieveForCurrentArticle };
