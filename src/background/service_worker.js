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
    username: '__SERVICENOW_USERNAME__',
    password: '__SERVICENOW_PASSWORD__',
    autoSyncWeekly: true,
    lastSyncAt: null,
    lastError: null,
    articleCount: 0
  };
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
    const sn = { ...getDefaultServiceNowSettings(), ...(settings?.serviceNow || {}) };
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
    const sn = { ...getDefaultServiceNowSettings(), ...(settings?.serviceNow || {}) };
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
  const sn = { ...getDefaultServiceNowSettings(), ...(settings?.serviceNow || {}) };
  return await runServiceNowSync(sn);
}

/**
 * Handle TEST_SERVICENOW message – performs a minimal fetch to check connectivity.
 * @param {Object} snSettings - ServiceNow settings (may come from form, not yet saved)
 * @returns {Promise<Object>} { success, message }
 */
async function handleTestServiceNow(snSettings) {
  const sn = { ...getDefaultServiceNowSettings(), ...(snSettings || {}) };
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
 * Fetches all matching articles using pagination and stores them via upsert.
 * @param {Object} sn - ServiceNow settings block
 * @returns {Promise<Object>} { success, count, message }
 */
async function runServiceNowSync(sn) {
  const syncedAt = new Date().toISOString();
  try {
    const rawArticles = await fetchServiceNowArticles(sn);

    if (!rawArticles || rawArticles.length === 0) {
      const result = {
        success: false,
        count: 0,
        message: 'No matching articles found for current filter'
      };
      await persistServiceNowSyncMeta(sn, null, result.message, 0);
      return result;
    }

    // Import articles using the in-worker ingestion function
    const { upserted, stale, errors } = await ingestServiceNowArticles(rawArticles, syncedAt);

    const message = `Successfully synced ${upserted} ServiceNow article(s)` +
      (stale > 0 ? ` (${stale} marked stale)` : '') +
      (errors.length > 0 ? `. ${errors.length} error(s) during import.` : '.');

    await persistServiceNowSyncMeta(sn, syncedAt, null, upserted);

    return { success: true, count: upserted, message };
  } catch (err) {
    const errorMsg = classifyNetworkError(err);
    await persistServiceNowSyncMeta(sn, null, errorMsg, 0);
    return { success: false, count: 0, message: errorMsg };
  }
}

/**
 * Persist sync metadata (lastSyncAt, lastError, articleCount) back to storage.
 * Does a shallow merge so other settings fields are preserved.
 */
async function persistServiceNowSyncMeta(sn, lastSyncAt, lastError, articleCount) {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const updated = {
      ...(settings || {}),
      serviceNow: {
        ...getDefaultServiceNowSettings(),
        ...(settings?.serviceNow || {}),
        lastSyncAt: lastSyncAt || sn.lastSyncAt,
        lastError: lastError || null,
        articleCount
      }
    };
    await chrome.storage.local.set({ settings: updated });
  } catch (err) {
    console.error('Failed to persist ServiceNow sync metadata:', err.message);
  }
}

/**
 * Fetch all ServiceNow Knowledge articles, following pagination.
 *
 * Supports three response shapes defensively:
 *   • Array directly
 *   • { result: [...] }
 *   • { result: { articles: [...] } }
 *
 * @param {Object} sn - ServiceNow settings
 * @returns {Promise<Array>} Flat array of raw article objects
 */
async function fetchServiceNowArticles(sn) {
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
 * Build a ServiceNow Knowledge API URL with pagination parameters.
 * @param {string} baseUrl
 * @param {string} filter - raw sysparm_query value (not yet encoded)
 * @param {number} limit
 * @param {number} offset
 * @returns {string}
 */
function buildServiceNowUrl(baseUrl, filter, limit, offset) {
  const url = new URL(baseUrl);
  if (filter) url.searchParams.set('sysparm_query', filter);
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

  for (const raw of rawArticles) {
    try {
      const remoteId = raw.sys_id || raw.kb_number || raw.number || null;
      const title =
        raw.short_description || raw.title || raw.name || '(Untitled)';
      const rawHtml =
        raw.text_html || raw.wiki || raw.text ||
        raw.description || raw.body || raw.content || '';

      // Basic HTML sanitization (removes script/iframe/object/embed)
      const safeHtml = sanitizeHtml(rawHtml);

      // Segment HTML body into steps
      const steps = segmentHtmlIntoSteps(safeHtml, title);

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
 * Segment an HTML string into Step objects (service-worker version).
 * Uses H2 elements as step boundaries; falls back to a single "Procedure" step.
 * @param {string} html
 * @param {string} articleTitle
 * @returns {Array<{index:number,title:string,bodyHtml:string,images:Array}>}
 */
function segmentHtmlIntoSteps(html, articleTitle) {
  if (!html || !html.trim()) {
    return [{ index: 1, title: 'Procedure', bodyHtml: '', images: [] }];
  }

  // Step-marker pattern: "Step 1: Title" or "Step 1 – Title"
  const stepPattern = /step\s+(\d+)\s*[:\-–]\s*(.+)/i;
  const stepMarkerMatches = [...html.matchAll(new RegExp(
    '<(?:h[1-6]|p)[^>]*>\\s*' + stepPattern.source + '\\s*</(?:h[1-6]|p)>',
    'gi'
  ))];

  if (stepMarkerMatches.length > 0) {
    return buildStepsFromMarkers(html, stepMarkerMatches);
  }

  // Fall back to H2-based segmentation
  const h2Pattern = /<h2[^>]*>(.*?)<\/h2>/gi;
  const h2Matches = [...html.matchAll(h2Pattern)];

  if (h2Matches.length > 0) {
    return buildStepsFromH2(html, h2Matches);
  }

  // Single-step fallback
  return [{ index: 1, title: articleTitle || 'Procedure', bodyHtml: html, images: [] }];
}

function buildStepsFromMarkers(html, matches) {
  const steps = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    steps.push({
      index: parseInt(matches[i][1], 10),
      title: matches[i][2].trim(),
      bodyHtml: html.slice(start, end).trim(),
      images: []
    });
  }
  return steps;
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
