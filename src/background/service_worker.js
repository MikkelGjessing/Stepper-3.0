/**
 * Service Worker for Stepper 3.0
 * Handles background tasks and initialization
 */

// ── Default ServiceNow settings (single source of truth for the worker) ──────
// Edit here to rotate credentials or change the default endpoint/filter.
// These values are merged with any stored settings at runtime so that
// newly added fields always have a safe fallback.
//
//   baseUrl  : ServiceNow Knowledge Management REST API endpoint
//   filter   : sysparm_query filter (URL-encoded when building the request)
//   username : Basic-auth username  ← rotate here
//   password : Basic-auth password  ← rotate here (never logged)
// ─────────────────────────────────────────────────────────────────────────────
function getDefaultServiceNowSettings() {
  return {
    enabled: true,
    baseUrl: 'https://nets.service-now.com/api/sn_km_api/knowledge/articles',
    filter: 'workflow_state=published^sys_view_count>100',
    username: 'Co-Pilot',
    password: 'ejSHm*ScWIfV576@Z90rOoqF4wofHMX#mVOC|YSn',
    autoSyncWeekly: true,
    lastSyncAt: null,
    lastError: null,
    articleCount: 0
  };
}

/**
 * Migrate any leftover placeholder tokens from an older installation.
 * Only replaces the exact placeholder strings; all other values are left untouched.
 * @param {Object} sn - Merged serviceNow settings object
 * @returns {Object} Settings with placeholders replaced by real defaults
 */
function migrateServiceNowPlaceholders(sn) {
  if (!sn) return getDefaultServiceNowSettings();
  const realDefaults = getDefaultServiceNowSettings();
  const migrated = { ...sn };
  if (migrated.username === '__SERVICENOW_USERNAME__') {
    migrated.username = realDefaults.username;
  }
  if (migrated.password === '__SERVICENOW_PASSWORD__') {
    migrated.password = realDefaults.password;
  }
  return migrated;
}

// Initialize on install
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('Stepper 3.0 installed/updated:', details.reason);
  
  // Initialize default settings if not present
  const { settings } = await chrome.storage.local.get('settings');
  
  if (!settings) {
    const defaultSettings = {
      repoSourceType: 'url',
      repoUrl: '',
      azureApiBaseUrl: '',
      azurePat: '',
      enableDummyArticles: true,
      enableLLMSearch: false,
      llmEndpoint: '',
      llmApiKey: '',
      serviceNow: getDefaultServiceNowSettings()
    };
    
    await chrome.storage.local.set({ settings: defaultSettings });
    console.log('Default settings initialized');
  } else if (!settings.serviceNow) {
    // Existing installation – add serviceNow block without overwriting other settings
    await chrome.storage.local.set({
      settings: { ...settings, serviceNow: getDefaultServiceNowSettings() }
    });
    console.log('ServiceNow settings initialized for existing installation');
  } else {
    // Existing installation with serviceNow settings – migrate any placeholder tokens
    const migrated = migrateServiceNowPlaceholders(settings.serviceNow);
    if (
      migrated.username !== settings.serviceNow.username ||
      migrated.password !== settings.serviceNow.password
    ) {
      await chrome.storage.local.set({
        settings: { ...settings, serviceNow: migrated }
      });
      console.log('ServiceNow placeholder credentials migrated to real defaults');
    }
  }
  
  // Initialize articles array if not present
  const { articles } = await chrome.storage.local.get('articles');
  if (!articles) {
    await chrome.storage.local.set({ articles: [] });
    console.log('Articles array initialized');
  }

  // Schedule weekly ServiceNow sync (10080 minutes = 7 days).
  // chrome.alarms.create() is idempotent by name: if the alarm already exists
  // it is simply updated (its schedule resets). This is intentional – we want
  // the period to reflect any changes made to this value after an extension update.
  chrome.alarms.create('servicenow-weekly-sync', { periodInMinutes: 10080 });
  console.log('ServiceNow weekly sync alarm scheduled');

  // Run an initial sync if enabled and never synced before
  await maybeRunInitialServiceNowSync();
});

// Re-schedule alarm on startup (service workers can be killed and restarted).
// Recreating the alarm resets its schedule from "now", which is acceptable –
// the worker could have been idle for days before restarting.
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('servicenow-weekly-sync', { periodInMinutes: 10080 });
  await maybeRunInitialServiceNowSync();
});

// Handle periodic alarm
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'servicenow-weekly-sync') {
    const { settings } = await chrome.storage.local.get('settings');
    const sn = migrateServiceNowPlaceholders({
      ...getDefaultServiceNowSettings(),
      ...(settings?.serviceNow || {})
    });
    if (
      sn.enabled &&
      sn.autoSyncWeekly &&
      sn.username !== '__SERVICENOW_USERNAME__' &&
      sn.password !== '__SERVICENOW_PASSWORD__'
    ) {
      console.log('ServiceNow weekly alarm fired – starting sync');
      await runServiceNowSync(sn);
    }
  }
});

/**
 * Run an initial sync when the extension is first installed or started,
 * but only if ServiceNow sync is enabled, has real credentials (not placeholders),
 * and has never been run before.
 */
async function maybeRunInitialServiceNowSync() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const sn = migrateServiceNowPlaceholders({
      ...getDefaultServiceNowSettings(),
      ...(settings?.serviceNow || {})
    });
    if (
      sn.enabled &&
      !sn.lastSyncAt &&
      sn.username !== '__SERVICENOW_USERNAME__' &&
      sn.password !== '__SERVICENOW_PASSWORD__'
    ) {
      console.log('Running initial ServiceNow sync (never synced before)');
      await runServiceNowSync(sn);
    }
  } catch (err) {
    console.error('Error in maybeRunInitialServiceNowSync:', err.message);
  }
}

// Handle messages from popup/options
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Service worker received message:', message.type);
  
  switch (message.type) {
    case 'ping':
      sendResponse({ status: 'alive' });
      break;
    case 'refreshArticles':
      // TODO: Implement article refresh logic
      console.log('Article refresh requested');
      sendResponse({ status: 'success', message: 'Refresh initiated' });
      break;
    case 'SCAN_PAGE':
      handleScanPage(message.keywords)
        .then(result => sendResponse(result))
        .catch(() => sendResponse({ results: {} }));
      return true; // Keep message channel open for async response
    case 'SYNC_REPO':
      handleSyncRepo(message.settings)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ 
          success: false, 
          message: `Sync failed: ${error.message}` 
        }));
      return true; // Keep message channel open for async response
    case 'SYNC_SERVICENOW':
      handleSyncServiceNow()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({
          success: false,
          message: `ServiceNow sync failed: ${error.message}`
        }));
      return true; // Keep message channel open for async response
    case 'TEST_SERVICENOW':
      handleTestServiceNow(message.settings)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({
          success: false,
          message: `Connection test failed: ${error.message}`
        }));
      return true; // Keep message channel open for async response
    default:
      sendResponse({ status: 'unknown', message: 'Unknown message type' });
  }
  
  return true; // Keep message channel open for async responses
});

/**
 * Handle SYNC_SERVICENOW message – reads settings from storage,
 * runs a full sync, and persists the result (lastSyncAt, articleCount, lastError).
 * @returns {Promise<Object>} Sync result
 */
async function handleSyncServiceNow() {
  const { settings } = await chrome.storage.local.get('settings');
  const sn = migrateServiceNowPlaceholders({
    ...getDefaultServiceNowSettings(),
    ...(settings?.serviceNow || {})
  });
  return await runServiceNowSync(sn);
}

/**
 * Handle TEST_SERVICENOW message – performs a minimal fetch to check connectivity.
 * @param {Object} snSettings - ServiceNow settings (may come from form, not yet saved)
 * @returns {Promise<Object>} { success, message }
 */
async function handleTestServiceNow(snSettings) {
  const sn = migrateServiceNowPlaceholders({ ...getDefaultServiceNowSettings(), ...(snSettings || {}) });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // Lightweight test: fetch with limit=1 to verify connectivity and auth
    const url = buildServiceNowUrl(sn.baseUrl, sn.filter, 1, 0);
    // NOTE: Authorization header is intentionally not logged
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': buildBasicAuthHeader(sn.username, sn.password)
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return { success: true, message: 'Connection successful' };
    }
    return { success: false, message: classifyHttpError(response.status) };
  } catch (err) {
    return { success: false, message: classifyNetworkError(err) };
  }
}

/**
 * Core ServiceNow sync logic.
 * Phase 1: fetches the article index (metadata).
 * Phase 2: for each index article that lacks a full body, fetches the full detail.
 * Phase 3: validates body content, then runs the shared ingestion pipeline.
 * @param {Object} sn - ServiceNow settings block
 * @returns {Promise<Object>} { success, count, message, indexCount, fetchedCount, skippedCount, parsedCount }
 */
async function runServiceNowSync(sn) {
  const syncedAt = new Date().toISOString();
  try {
    // ── Phase 1: fetch article index ────────────────────────────────────────
    const indexArticles = await fetchServiceNowArticleIndex(sn);

    console.log(`[ServiceNow] Index fetch complete: ${indexArticles.length} articles`);
    if (indexArticles.length > 0) {
      console.log(`[ServiceNow] Index article fields: ${Object.keys(indexArticles[0]).join(', ')}`);
    }

    if (!indexArticles || indexArticles.length === 0) {
      const result = {
        success: false,
        count: 0,
        message: 'No matching articles found for current filter',
        indexCount: 0, fetchedCount: 0, skippedCount: 0, parsedCount: 0
      };
      await persistServiceNowSyncMeta(sn, null, result.message, 0,
        { indexCount: 0, fetchedCount: 0, skippedCount: 0, parsedCount: 0 });
      return result;
    }

    // ── Phase 2: enrich each article with full body content ──────────────────
    const fullArticles = [];
    const skippedArticles = [];

    for (const indexArticle of indexArticles) {
      if (hasFullBody(indexArticle)) {
        // List response already included the full body – use it directly
        const { value: idxBody, field: idxBodyField } = detectBodyField(indexArticle);
        console.log(
          `[ServiceNow] Article "${indexArticle.short_description || indexArticle.sys_id}" ` +
          `has body in index response | bodyField=${idxBodyField} | bodyLen=${idxBody.trim().length}`
        );
        fullArticles.push(indexArticle);
      } else {
        // Need a second request to retrieve the full article body
        const detail = await fetchServiceNowArticleDetail(indexArticle, sn);
        if (detail && hasFullBody(detail)) {
          fullArticles.push({ ...indexArticle, ...detail });
        } else {
          const title = indexArticle.short_description || indexArticle.sys_id || '(unknown)';
          console.warn(`[ServiceNow] Skipping "${title}": detail content missing`);
          skippedArticles.push({ title, reason: 'detail content missing' });
        }
      }
    }

    console.log(
      `[ServiceNow] Full articles ready: ${fullArticles.length} | missing body (skipped): ${skippedArticles.length}`
    );

    if (fullArticles.length === 0) {
      const msg =
        `All ${indexArticles.length} article(s) skipped: full content could not be retrieved`;
      await persistServiceNowSyncMeta(sn, null, msg, 0, {
        indexCount: indexArticles.length,
        fetchedCount: 0,
        skippedCount: skippedArticles.length,
        parsedCount: 0
      });
      return {
        success: false,
        count: 0,
        message: msg,
        indexCount: indexArticles.length,
        fetchedCount: 0,
        skippedCount: skippedArticles.length,
        parsedCount: 0
      };
    }

    // ── Phase 3: import / upsert articles ────────────────────────────────────
    const { upserted, stale, errors } = await ingestServiceNowArticles(fullArticles, syncedAt);

    const message =
      `Synced ${upserted} ServiceNow article(s)` +
      ` (${indexArticles.length} found, ${skippedArticles.length} skipped)` +
      (stale > 0 ? ` · ${stale} marked stale` : '') +
      (errors.length > 0 ? ` · ${errors.length} error(s)` : '');

    const syncStats = {
      indexCount: indexArticles.length,
      fetchedCount: fullArticles.length,
      skippedCount: skippedArticles.length,
      parsedCount: upserted
    };

    await persistServiceNowSyncMeta(sn, syncedAt, null, upserted, syncStats);

    return { success: true, count: upserted, message, ...syncStats };
  } catch (err) {
    const errorMsg = classifyNetworkError(err);
    await persistServiceNowSyncMeta(sn, null, errorMsg, 0);
    return { success: false, count: 0, message: errorMsg };
  }
}

/**
 * Persist sync metadata (lastSyncAt, lastError, articleCount, syncStats) back to storage.
 * Does a shallow merge so other settings fields are preserved.
 * @param {Object}      sn           - ServiceNow settings block
 * @param {string|null} lastSyncAt   - ISO timestamp of this sync (null on failure)
 * @param {string|null} lastError    - Error message (null on success)
 * @param {number}      articleCount - Number of articles upserted
 * @param {Object}      [syncStats]  - Optional detailed stats: { indexCount, fetchedCount, skippedCount, parsedCount }
 */
async function persistServiceNowSyncMeta(sn, lastSyncAt, lastError, articleCount, syncStats) {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const updated = {
      ...(settings || {}),
      serviceNow: {
        ...getDefaultServiceNowSettings(),
        ...(settings?.serviceNow || {}),
        lastSyncAt: lastSyncAt || sn.lastSyncAt,
        lastError: lastError || null,
        articleCount,
        ...(syncStats ? { syncStats } : {})
      }
    };
    await chrome.storage.local.set({ settings: updated });
  } catch (err) {
    console.error('Failed to persist ServiceNow sync metadata:', err.message);
  }
}

/**
 * Fetch all ServiceNow Knowledge articles (index / metadata), following pagination.
 *
 * This function retrieves the article list only – it does NOT guarantee that
 * a full HTML body is present on each returned object.  Call
 * fetchServiceNowArticleDetail() for articles that lack a full body.
 *
 * Supports three response shapes defensively:
 *   • Array directly
 *   • { result: [...] }
 *   • { result: { articles: [...] } }
 *
 * @param {Object} sn - ServiceNow settings
 * @returns {Promise<Array>} Flat array of raw article index objects
 */
async function fetchServiceNowArticleIndex(sn) {
  const PAGE_SIZE = 100;
  let offset = 0;
  const allArticles = [];

  // Safety guard: max pages to avoid infinite loops on misconfigured APIs.
  // At PAGE_SIZE=100 this caps fetches at 5 000 articles per sync.
  // If your ServiceNow instance has more matching articles, increase MAX_PAGES
  // or narrow the sysparm_query filter.
  const MAX_PAGES = 50;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = buildServiceNowUrl(sn.baseUrl, sn.filter, PAGE_SIZE, offset);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      // NOTE: Authorization header is intentionally not logged
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': buildBasicAuthHeader(sn.username, sn.password)
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(classifyHttpError(response.status));
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Unexpected API response: could not parse JSON');
    }

    // Defensive adapter: handle all known payload shapes
    const page_articles = extractArticlesFromPayload(data);

    if (!page_articles || page_articles.length === 0) break;

    allArticles.push(...page_articles);

    // Stop if we got fewer results than the page size (last page)
    if (page_articles.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
  }

  return allArticles;
}

/**
 * Explicit field list requested from the ServiceNow API.
 * Requesting these fields by name ensures the list endpoint returns body
 * content even when the default response omits large text fields.
 */
const SN_BODY_FIELDS =
  'sys_id,number,short_description,text,description,article,body,content,sys_updated_on';

/**
 * Extract the clean base URL (origin + pathname only) from a stored base URL,
 * discarding any query parameters or fragments the user may have included.
 * @param {string} baseUrl
 * @returns {string} Clean URL containing only origin + pathname
 */
function getCleanBaseUrl(baseUrl) {
  const { origin, pathname } = new URL(baseUrl);
  return new URL(pathname, origin).toString();
}

/**
 * Build a ServiceNow Knowledge API URL with pagination parameters.
 * Includes an explicit sysparm_fields list so the list endpoint returns full
 * body/content fields alongside the normal metadata.
 *
 * Only the origin and pathname of baseUrl are used; any query parameters
 * present in the stored value are discarded so that all query parameters are
 * always constructed here and appended programmatically.
 *
 * @param {string} baseUrl - Base endpoint URL (only origin + pathname are used)
 * @param {string} filter  - raw sysparm_query value (not yet encoded)
 * @param {number} limit
 * @param {number} offset
 * @returns {string}
 */
function buildServiceNowUrl(baseUrl, filter, limit, offset) {
  // Strip any query params from the stored base URL so that the URL field
  // accepts a plain base endpoint and all query parameters are built here.
  const url = new URL(getCleanBaseUrl(baseUrl));
  if (filter) url.searchParams.set('sysparm_query', filter);
  url.searchParams.set('sysparm_fields', SN_BODY_FIELDS);
  url.searchParams.set('sysparm_limit', String(limit));
  url.searchParams.set('sysparm_offset', String(offset));
  return url.toString();
}

/**
 * Build Basic Authorization header value.
 * Basic auth encodes credentials as base64 (not encrypted) so the connection
 * MUST use HTTPS – which is enforced by the manifest host_permission pattern
 * (https://nets.service-now.com/*) and the default baseUrl.
 * The value itself is never logged or stored in a visible location.
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
function buildBasicAuthHeader(username, password) {
  return 'Basic ' + btoa(username + ':' + password);
}

/**
 * Extract the articles array from the various ServiceNow response shapes.
 * @param {*} data - Parsed JSON payload
 * @returns {Array}
 */
function extractArticlesFromPayload(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.result)) return data.result;
    if (data.result && typeof data.result === 'object') {
      if (Array.isArray(data.result.articles)) return data.result.articles;
      if (Array.isArray(data.result.items)) return data.result.items;
    }
    // Some endpoints wrap in a `articles` top-level key
    if (Array.isArray(data.articles)) return data.articles;
  }
  return [];
}

/**
 * Extract a single article object from a ServiceNow detail endpoint response.
 * Handles the most common shapes returned by /articles/{id} endpoints:
 *   • { result: {...} }         – single-object result (most common)
 *   • { result: [{...}] }       – single-element array result
 *   • { sys_id: ..., ... }      – bare object (no wrapper)
 * @param {*} data - Parsed JSON payload from a detail request
 * @returns {Object|null}
 */
function extractArticleDetailFromPayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.result) {
    if (!Array.isArray(data.result) && typeof data.result === 'object') return data.result;
    if (Array.isArray(data.result) && data.result.length > 0) return data.result[0];
  }
  // Bare object: check for a field that only a real article would have
  if (data.sys_id || data.number || data.short_description) return data;
  return null;
}

/**
 * Minimum body length (characters) required to consider an article "complete".
 * Responses shorter than this are treated as metadata-only and trigger a detail fetch.
 */
const BODY_MIN_LENGTH = 200;

/**
 * Ordered list of field names that may contain the article's full HTML/text body.
 * The fields explicitly requested via SN_BODY_FIELDS are included here, along with
 * legacy field names (text_html, wiki) that some ServiceNow instances return by
 * default even without explicit field selection.
 */
const BODY_FIELD_CANDIDATES = [
  'text_html', 'wiki', 'article', 'text', 'description', 'body', 'content'
];

/**
 * Inspect a raw ServiceNow article record and return the first non-empty body
 * field together with its field name.
 * @param {Object} article - Raw article record
 * @returns {{ value: string, field: string|null }}
 */
function detectBodyField(article) {
  for (const field of BODY_FIELD_CANDIDATES) {
    const val = article[field];
    if (typeof val === 'string' && val.trim().length > 0) {
      return { value: val, field };
    }
  }
  return { value: '', field: null };
}

/**
 * Extract the best available body/content string from a raw ServiceNow article record.
 * Checks all known field names in priority order and returns the first non-empty string.
 * @param {Object} article - Raw article record
 * @returns {string} Body string (may be empty)
 */
function extractBodyField(article) {
  return detectBodyField(article).value;
}

/**
 * Return true when a raw ServiceNow article object already contains a
 * sufficiently long body/content field.
 * @param {Object} article - Raw article record
 * @returns {boolean}
 */
function hasFullBody(article) {
  return extractBodyField(article).trim().length >= BODY_MIN_LENGTH;
}

/**
 * Fetch the full detail record for a single ServiceNow article.
 *
 * Identifier resolution order:
 *   1. `sys_id` appended to sn.baseUrl (preferred – deterministic & stable)
 *   2. `link` / `url` field on the index article (direct REST URL)
 *   3. `number` or `kb_number` appended to sn.baseUrl (fallback)
 *
 * The detail URL always includes sysparm_fields so that the response contains
 * all likely body fields regardless of the API's default field set.
 *
 * Returns null on any failure so the caller can mark the article as skipped.
 *
 * @param {Object} articleRef - Index article record (may be metadata-only)
 * @param {Object} sn         - ServiceNow settings (baseUrl, username, password)
 * @returns {Promise<Object|null>} Full article record or null
 */
async function fetchServiceNowArticleDetail(articleRef, sn) {
  const title = articleRef.short_description || articleRef.title || articleRef.name || '(unknown)';

  // ── Build detail URL ──────────────────────────────────────────────────────
  let detailUrl = null;
  let identifier = null;

  // Prefer sys_id for the detail request – it is stable and unambiguous
  if (articleRef.sys_id && typeof articleRef.sys_id === 'string') {
    identifier = articleRef.sys_id;
    const cleanBase = getCleanBaseUrl(sn.baseUrl).replace(/\/+$/, '');
    const u = new URL(`${cleanBase}/${encodeURIComponent(identifier)}`);
    u.searchParams.set('sysparm_fields', SN_BODY_FIELDS);
    detailUrl = u.toString();
  } else if (articleRef.link && typeof articleRef.link === 'string') {
    identifier = articleRef.link;
    const u = new URL(articleRef.link);
    u.searchParams.set('sysparm_fields', SN_BODY_FIELDS);
    detailUrl = u.toString();
  } else if (articleRef.url && typeof articleRef.url === 'string') {
    identifier = articleRef.url;
    const u = new URL(articleRef.url);
    u.searchParams.set('sysparm_fields', SN_BODY_FIELDS);
    detailUrl = u.toString();
  } else {
    identifier = articleRef.number || articleRef.kb_number || null;
    if (!identifier) {
      console.warn(
        `[ServiceNow Detail] No identifier found for "${title}"; ` +
        `available fields: ${Object.keys(articleRef).join(', ')}`
      );
      return null;
    }
    const cleanBase = getCleanBaseUrl(sn.baseUrl).replace(/\/+$/, '');
    const u = new URL(`${cleanBase}/${encodeURIComponent(identifier)}`);
    u.searchParams.set('sysparm_fields', SN_BODY_FIELDS);
    detailUrl = u.toString();
  }

  console.log(
    `[ServiceNow Detail] Fetching: title="${title}" | identifier=${identifier}`
  );

  // ── HTTP request ──────────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(detailUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': buildBasicAuthHeader(sn.username, sn.password)
      },
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[ServiceNow Detail] Network error for "${title}": ${err.message}`);
    return null;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    console.warn(
      `[ServiceNow Detail] HTTP ${response.status} for "${title}" (${detailUrl})`
    );
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    console.warn(`[ServiceNow Detail] JSON parse error for "${title}"`);
    return null;
  }

  // ── Extract article from response ─────────────────────────────────────────
  const detail = extractArticleDetailFromPayload(data);
  if (!detail) {
    console.warn(
      `[ServiceNow Detail] Could not extract article object from response for "${title}"`
    );
    return null;
  }

  const { value: body, field: bodyField } = detectBodyField(detail);
  const bodyLen = body.trim().length;

  console.log(
    `[ServiceNow Detail] title="${title}" | bodyField=${bodyField || 'none'} | ` +
    `bodyLen=${bodyLen} | bodyPresent=${bodyLen >= BODY_MIN_LENGTH}`
  );

  return detail;
}

/**
 * Map and store raw ServiceNow articles.
 * Replicates the logic of Articles.importServiceNowArticles() for use in the
 * service worker (which cannot import the articles.js module).
 *
 * @param {Array}  rawArticles
 * @param {string} syncedAt    ISO timestamp
 * @returns {Promise<{upserted:number, stale:number, errors:string[]}>}
 */
async function ingestServiceNowArticles(rawArticles, syncedAt) {
  const errors = [];
  const processed = [];
  const syncedRemoteIds = new Set();
  let missingBodyCount = 0;

  for (const raw of rawArticles) {
    try {
      const remoteId = raw.sys_id || raw.kb_number || raw.number || null;
      const title =
        raw.short_description || raw.title || raw.name || '(Untitled)';
      const { value: rawHtml, field: bodyField } = detectBodyField(raw);
      const rawBodyLength = rawHtml.trim().length;

      // Basic HTML sanitization (removes script/iframe/object/embed)
      const safeHtml = sanitizeHtml(rawHtml);

      // Segment HTML body into steps using the shared pipeline
      const steps = segmentHtmlIntoSteps(safeHtml, title);

      // Determine parse status for storage / debugging
      const parseStatus =
        steps.length > 1  ? 'parsed'   :
        rawBodyLength > 0 ? 'fallback' : 'empty';

      if (rawBodyLength === 0) missingBodyCount++;

      // Debug logging (mirrors Articles.logStepInfo() format for uploaded articles)
      console.log(
        `[ServiceNow Import] title="${title}" | bodyField=${bodyField || 'none'} | bodyLen=${rawBodyLength} | ` +
        `parseStatus=${parseStatus} | steps=${steps.length}` +
        (steps.length > 0 ? ` | titles: ${steps.map(s => s.title).join(' | ')}` : '')
      );

      const article = {
        id: null, // resolved during upsert below
        title,
        summary: raw.meta_description || raw.description || '',
        tags: raw.kb_category
          ? [raw.kb_category]
          : (raw.topic ? [raw.topic] : []),
        estimatedMinutes: null,
        steps,
        source: 'servicenow',
        remoteId,
        syncedAt,
        rawBodyLength,
        parseStatus,
        stale: false,
        createdAt: raw.sys_created_on || syncedAt,
        updatedAt: syncedAt
      };

      processed.push(article);
      if (remoteId) syncedRemoteIds.add(remoteId);
    } catch (err) {
      errors.push(
        `Failed to process article "${raw.short_description || raw.sys_id}": ${err.message}`
      );
    }
  }

  if (missingBodyCount > 0) {
    console.warn(
      `[ServiceNow Import] ${missingBodyCount} of ${processed.length} article(s) have no body content`
    );
  }

  // Load existing articles
  const { articles: allArticles } = await chrome.storage.local.get('articles');
  const stored = Array.isArray(allArticles) ? [...allArticles] : [];

  // Build lookup map by remoteId
  const existingByRemoteId = new Map();
  for (const a of stored) {
    if (a.source === 'servicenow' && a.remoteId) {
      existingByRemoteId.set(a.remoteId, a);
    }
  }

  let upsertedCount = 0;
  const upsertedIds = new Set();

  for (const article of processed) {
    const existing = article.remoteId ? existingByRemoteId.get(article.remoteId) : null;
    if (existing) {
      article.id = existing.id;
      article.createdAt = existing.createdAt;
      const idx = stored.findIndex(a => a.id === existing.id);
      if (idx !== -1) stored[idx] = article;
    } else {
      article.id = generateUUID();
      stored.push(article);
    }
    upsertedIds.add(article.id);
    upsertedCount++;
  }

  // Mark absent ServiceNow articles as stale
  let staleCount = 0;
  for (const a of stored) {
    if (a.source === 'servicenow' && !upsertedIds.has(a.id) && !a.stale) {
      a.stale = true;
      staleCount++;
    }
  }

  await chrome.storage.local.set({ articles: stored });

  return { upserted: upsertedCount, stale: staleCount, errors };
}

/**
 * Remove ServiceNow UI chrome and noise from a raw HTML string.
 * Called before step segmentation to strip artefacts such as "Leave a comment",
 * "Copy Permalink", and form elements that appear in ServiceNow article exports.
 *
 * NOTE: Service workers do not have access to DOMParser, so this function uses
 * string-based regex processing.  For typical KB articles (a few KB of HTML)
 * the performance is negligible.  The regexes are applied to already-sanitised
 * HTML (scripts/iframes removed by sanitizeHtml() first), so the content is
 * well-formed enough for these patterns to work reliably.
 * @param {string} html
 * @returns {string} Cleaned HTML string
 */
function normalizeServiceNowHtml(html) {
  if (!html) return '';

  // Remove entire <form> blocks (handles "Top of Form" / "Bottom of Form" wrappers)
  html = html.replace(/<form[\s\S]*?<\/form>/gi, '');

  // Remove individual form-control elements
  html = html.replace(/<(?:input|button|textarea|select)[^>]*\/?>/gi, '');

  // ServiceNow UI-noise patterns: remove any block/inline element whose sole text
  // content matches a known noise phrase.  We iterate replacements so nested tags are caught.
  const SN_NOISE = [
    /^leave\s+a\s+comment/i,
    /^copy\s+permalink$/i,
    /^top\s+of\s+form$/i,
    /^bottom\s+of\s+form$/i
  ];
  html = html.replace(
    /<(p|div|span|a|li|td|th)([^>]*)>([\s\S]*?)<\/\1>/gi,
    (match, tag, attrs, inner) => {
      const text = htmlToPlainText(inner).trim();
      if (text && SN_NOISE.some(re => re.test(text))) return '';
      return match;
    }
  );

  // Convert non-breaking spaces and similar whitespace to regular spaces
  html = html.replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ');

  return html;
}

/**
 * Extract the "Procedure" section from a ServiceNow KB article HTML string.
 * Locates the heading that matches "2. Procedure" / "Procedure (how to)" etc. and
 * returns the HTML between that heading and the next numbered top-level section.
 * Returns null when no Procedure heading is found.
 * @param {string} html
 * @returns {string|null}
 */
function extractProcedureSection(html) {
  if (!html) return null;

  // Collect all h1–h6 headings with their positions
  const headingRe = /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/gi;
  const headings = [];
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    const text = htmlToPlainText(m[3]).trim();
    headings.push({ text, index: m.index, endIndex: m.index + m[0].length });
  }

  // Find the first heading whose text mentions "procedure"
  let procedureIdx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (/\bprocedure\b/i.test(headings[i].text)) {
      procedureIdx = i;
      break;
    }
  }
  if (procedureIdx === -1) return null;

  const contentStart = headings[procedureIdx].endIndex;

  // Content ends before the next top-level numbered section heading or known section names
  let contentEnd = html.length;
  for (let i = procedureIdx + 1; i < headings.length; i++) {
    const t = headings[i].text;
    if (/^\d+\.\s/.test(t) || /^(?:related|general)\s+info/i.test(t) || /^appendix/i.test(t)) {
      contentEnd = headings[i].index;
      break;
    }
  }

  return html.slice(contentStart, contentEnd);
}

/**
 * Find all "Step N:" / "Step N – Title" marker positions inside an HTML string.
 * Strips inner HTML tags before applying the step pattern so that markers nested
 * inside <strong>, <em>, or other inline elements are still detected.
 *
 * NOTE: Service workers do not have access to DOMParser.  The regex here uses
 * backreferences to ensure opening/closing tags are balanced.  For typical KB
 * article content (well-formed, no deeply-nested same-type block elements) this
 * is both correct and fast enough.
 * @param {string} html
 * @returns {Array<{index:number,endIndex:number,stepNum:number,stepTitle:string}>}
 */
function findStepMarkers(html) {
  const markers = [];
  // Match any block-level element (p or h1–h6), non-greedy on content
  const blockRe = /<(h[1-6]|p)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  const stepRe = /^Step\s+(\d+)\s*[:\-–]\s*(.+)$/i;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const textContent = htmlToPlainText(m[0]).trim();
    const stepMatch = textContent.match(stepRe);
    if (stepMatch) {
      markers.push({
        index: m.index,
        endIndex: m.index + m[0].length,
        stepNum: parseInt(stepMatch[1], 10),
        stepTitle: stepMatch[2].trim()
      });
    }
  }
  return markers;
}

/**
 * Build step objects from step-marker positions.
 * Produces title format "Step N: Title" to match the DOM-based segmentIntoSteps().
 * @param {string} html
 * @param {Array} markers - From findStepMarkers()
 * @returns {Array<{index:number,title:string,bodyHtml:string,images:Array}>}
 */
function buildStepsFromStepMarkers(html, markers) {
  const steps = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const bodyStart = marker.endIndex;
    const bodyEnd = i + 1 < markers.length ? markers[i + 1].index : html.length;
    steps.push({
      index: marker.stepNum,
      title: `Step ${marker.stepNum}: ${marker.stepTitle}`,
      bodyHtml: html.slice(bodyStart, bodyEnd).trim(),
      images: []
    });
  }
  return steps;
}

/**
 * Segment an HTML string into Step objects (service-worker version).
 * Mirrors the three-level fallback used by the DOM-based segmentIntoSteps() in
 * articles.js so that ServiceNow articles are processed the same way as uploads:
 *   1. Normalize ServiceNow noise
 *   2. Focus on the Procedure section (if present)
 *   3. "Step N:" marker segmentation
 *   4. H2-based segmentation fallback
 *   5. Single-step fallback
 * @param {string} html
 * @param {string} articleTitle
 * @returns {Array<{index:number,title:string,bodyHtml:string,images:Array}>}
 */
function segmentHtmlIntoSteps(html, articleTitle) {
  if (!html || !html.trim()) {
    return [{ index: 1, title: 'Procedure', bodyHtml: '', images: [] }];
  }

  // Step 1: Strip ServiceNow UI chrome / noise
  html = normalizeServiceNowHtml(html);

  // Step 2: Focus on the Procedure section when the article has section structure
  const procedureHtml = extractProcedureSection(html) || html;

  // Step 3: "Step N:" marker segmentation (robust – handles HTML-wrapped text)
  const stepMarkers = findStepMarkers(procedureHtml);
  if (stepMarkers.length > 0) {
    return buildStepsFromStepMarkers(procedureHtml, stepMarkers);
  }

  // Step 4: H2-based fallback
  const h2Matches = [...procedureHtml.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (h2Matches.length > 0) {
    return buildStepsFromH2(procedureHtml, h2Matches);
  }

  // Step 5: Single-step fallback
  return [{ index: 1, title: articleTitle || 'Procedure', bodyHtml: procedureHtml, images: [] }];
}

function buildStepsFromH2(html, matches) {
  const steps = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    // Extract plain-text title: remove all HTML tags, then decode common entities
    const rawTitle = htmlToPlainText(matches[i][1]);
    steps.push({
      index: i + 1,
      title: rawTitle,
      bodyHtml: html.slice(start, end).trim(),
      images: []
    });
  }
  return steps;
}


/**
 * Basic HTML sanitizer for the service worker context.
 * Removes dangerous tags (script, iframe, object, embed) by repeatedly
 * stripping them until the string no longer changes, preventing bypass
 * via nested or malformed tag injection.
 * @param {string} html
 * @returns {string}
 */
function sanitizeHtml(html) {
  if (!html) return '';
  // Iteratively remove dangerous tags until stable (prevents nested-tag bypass)
  const DANGEROUS = /<(script|iframe|object|embed)[\s\S]*?<\/\1>|<(script|iframe|object|embed)[^>]*\/?>/gi;
  let prev;
  let result = html;
  do {
    prev = result;
    result = prev.replace(DANGEROUS, '');
  } while (result !== prev);
  return result;
}

/**
 * Extract plain text from an HTML string by replacing all angle-bracket
 * delimited sequences with an empty string, then decoding common entities.
 * Used only for step-title extraction where HTML markup is unwanted.
 * @param {string} html
 * @returns {string}
 */
function htmlToPlainText(html) {
  if (!html) return '';
  // Replace anything between < and > (greedy enough to cover tag content)
  // then decode common HTML entities to restore readable text.
  // NOTE: &amp; is decoded LAST to avoid double-unescaping (e.g. &amp;lt; → < instead of &lt;)
  return html
    .split('<').join('\x00')  // mark each < so we can detect the boundary
    .split('>').join('\x01')  // mark each >
    .replace(/\x00[^\x01]*\x01/g, '') // remove \x00....\x01 (tag contents)
    .replace(/\x00|\x01/g, '')        // remove any remaining markers
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')          // decode &amp; last to prevent double-unescaping
    .trim();
}


function classifyHttpError(status) {
  if (status === 401 || status === 403) return 'Authentication failed: check username and password';
  if (status === 404) return 'Knowledge API endpoint not found: verify Base URL and that the sn_km_api plugin is enabled';
  return `HTTP ${status}: request failed`;
}

/**
 * Return a user-friendly error message for a fetch/network error.
 * @param {Error} err
 * @returns {string}
 */
function classifyNetworkError(err) {
  if (err && err.name === 'AbortError') return 'Connection timed out';
  if (err && (
    err.message.includes('Failed to fetch') ||
    err.message.includes('NetworkError') ||
    err.message.includes('CORS') ||
    err.message.includes('blocked')
  )) {
    return 'ServiceNow blocked the request; CORS may need to be allowed for the API origin';
  }
  return err ? err.message : 'Unknown network error';
}


/**
 * Scan the active tab page for ID values matching the given keywords.
 * Uses chrome.scripting.executeScript to run an inline function in the page.
 * @param {string[]} keywords - List of ID keyword names to look up (e.g. ["customerID"])
 * @returns {Promise<{results: Object}>} Map of keyword → found value
 */
async function handleScanPage(keywords) {
  try {
    if (!Array.isArray(keywords) || keywords.length === 0) return { results: {} };

    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs?.length) return { results: {} };

    const tab = tabs[0];
    // Skip chrome-internal and extension pages (scripting API cannot access them)
    const url = tab.url || '';
    if (!tab.id || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('devtools://')) {
      return { results: {} };
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (keywords) => {
        const results = {};
        const bodyText = document.body ? document.body.innerText : '';
        keywords.forEach(keyword => {
          const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match keyword (case-insensitive) optionally followed by : = or whitespace, then the value
          const pattern = new RegExp(esc + '\\s*[:=]?\\s*([A-Za-z0-9_\\-]+)', 'i');
          const match = bodyText.match(pattern);
          // Only store if the captured group is different from the keyword itself
          if (match && match[1] && match[1].toLowerCase() !== keyword.toLowerCase()) {
            results[keyword] = match[1];
          }
        });
        return results;
      },
      args: [keywords]
    });

    return { results: injectionResults?.[0]?.result || {} };
  } catch (error) {
    console.log('Page scan unavailable:', error.message);
    return { results: {} };
  }
}

/**
 * Handle repository sync
 * @param {Object} settings - Settings object
 * @returns {Promise<Object>} Sync result
 */
async function handleSyncRepo(settings) {
  try {
    // Dynamically import Articles module functionality
    // Since service worker can't directly use window.Articles, we'll replicate the logic
    
    // Get current settings if not provided
    if (!settings) {
      const { settings: storedSettings } = await chrome.storage.local.get('settings');
      settings = storedSettings;
    }
    
    if (!settings) {
      return {
        success: false,
        message: 'No settings found'
      };
    }
    
    // Perform the sync using the same logic
    const result = await syncFromRepo(settings);
    return result;
    
  } catch (error) {
    console.error('Error in handleSyncRepo:', error);
    return {
      success: false,
      message: `Sync failed: ${error.message}`
    };
  }
}

/**
 * Sync articles from repository (service worker version)
 * @param {Object} settings - Settings object
 * @returns {Promise<Object>} Result object
 */
async function syncFromRepo(settings) {
  try {
    let articles = [];
    
    // Fetch articles based on source type
    if (settings.repoSourceType === 'url' && settings.repoUrl) {
      articles = await fetchFromUrl(settings.repoUrl);
    } else if (settings.repoSourceType === 'azure' && settings.azureApiBaseUrl && settings.azurePat) {
      articles = await fetchFromAzure(settings.azureApiBaseUrl, settings.azurePat);
    } else {
      return {
        success: false,
        message: 'Invalid repository configuration. Please check your settings.'
      };
    }
    
    if (!Array.isArray(articles) || articles.length === 0) {
      return {
        success: false,
        message: 'No articles found in repository or invalid response format.'
      };
    }
    
    // Validate and process articles
    const validArticles = [];
    const errors = [];
    
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      
      if (!validateArticle(article)) {
        errors.push(`Article ${i + 1} failed validation`);
        continue;
      }
      
      // Ensure article has required metadata
      const processedArticle = {
        id: article.id || generateUUID(),
        title: article.title,
        summary: article.summary || '',
        tags: Array.isArray(article.tags) ? article.tags : [],
        estimatedMinutes: article.estimatedMinutes || null,
        steps: article.steps.map((step, index) => ({
          index: step.index !== undefined ? step.index : index + 1,
          title: step.title,
          bodyHtml: step.bodyHtml,
          images: Array.isArray(step.images) ? step.images.filter(img => {
            // Validate image URLs
            return img.dataUrlOrRemoteUrl && sanitizeImageUrl(img.dataUrlOrRemoteUrl);
          }) : []
        })),
        source: 'repo',
        createdAt: article.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      validArticles.push(processedArticle);
    }
    
    if (validArticles.length === 0) {
      return {
        success: false,
        message: `Failed to sync: ${errors.length > 0 ? errors.join('; ') : 'No valid articles found'}`
      };
    }
    
    // Upsert articles
    const { articles: existingArticles } = await chrome.storage.local.get('articles');
    const allExisting = Array.isArray(existingArticles) ? existingArticles : [];
    
    // Remove old repo articles
    const nonRepoArticles = allExisting.filter(a => a.source !== 'repo');
    
    // Combine non-repo articles with new repo articles
    const updatedArticles = [...nonRepoArticles, ...validArticles];
    
    await chrome.storage.local.set({ articles: updatedArticles });
    
    const message = `Successfully synced ${validArticles.length} article(s) from repository${errors.length > 0 ? `. ${errors.length} article(s) skipped due to validation errors.` : '.'}`;
    
    return {
      success: true,
      count: validArticles.length,
      errors: errors.length,
      message
    };
    
  } catch (error) {
    console.error('Error syncing from repository:', error);
    return {
      success: false,
      message: `Sync failed: ${error.message}`
    };
  }
}

/**
 * Fetch articles from URL
 */
async function fetchFromUrl(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : (data.articles || []);
    
  } catch (error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error('Network error: Unable to connect to repository. Please check your internet connection and URL.');
    }
    throw error;
  }
}

/**
 * Fetch articles from Azure DevOps
 */
async function fetchFromAzure(baseUrl, pat) {
  try {
    const authHeader = 'Basic ' + btoa(':' + pat);
    
    const response = await fetch(baseUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': authHeader
      }
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Authentication failed: Invalid Personal Access Token');
      } else if (response.status === 404) {
        throw new Error('Resource not found: Please check your Azure API URL');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : (data.articles || []);
    
  } catch (error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error('Network error: Unable to connect to Azure DevOps. Please check your internet connection and URL.');
    }
    throw error;
  }
}

/**
 * Validate article object
 */
function validateArticle(article) {
  if (!article.title || typeof article.title !== 'string') {
    return false;
  }
  
  if (!Array.isArray(article.steps) || article.steps.length === 0) {
    return false;
  }
  
  for (const step of article.steps) {
    if (typeof step.index !== 'number' || 
        typeof step.title !== 'string' || 
        typeof step.bodyHtml !== 'string') {
      return false;
    }
    
    if (step.images && !Array.isArray(step.images)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Sanitize image URL
 */
function sanitizeImageUrl(url) {
  if (url.startsWith('data:image/')) {
    return url;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  return null;
}

/**
 * Generate UUID
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    
    const hexArray = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
    return `${hexArray.slice(0, 4).join('')}-${hexArray.slice(4, 6).join('')}-${hexArray.slice(6, 8).join('')}-${hexArray.slice(8, 10).join('')}-${hexArray.slice(10).join('')}`;
  }
  
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Log service worker lifecycle
console.log('Stepper 3.0 service worker loaded');

/**
 * Open side panel when extension icon is clicked
 * This is required for side panel to open - action.default_popup is NOT used
 */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    console.log('Extension icon clicked, opening side panel for tab:', tab.id);
    await chrome.sidePanel.open({ tabId: tab.id });
    console.log('Side panel opened successfully');
  } catch (error) {
    console.error('Error opening side panel:', error);
    // Fallback: try without tabId
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      console.log('Side panel opened successfully using windowId');
    } catch (fallbackError) {
      console.error('Fallback error opening side panel:', fallbackError);
    }
  }
});
