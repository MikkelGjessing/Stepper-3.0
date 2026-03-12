/**
 * Chat API helper – Ask Stepper
 *
 * Sends chat requests to the configured backend service and returns
 * structured responses. All LLM calls are performed server-side; no
 * model API keys are held in the extension.
 *
 * Depends on:
 *   - Storage   (src/lib/storage.js)  – to read chatBackendUrl from settings
 *
 * Shapes used here are documented in src/shared/types.js.
 */

// eslint-disable-next-line no-unused-vars
const Chat = (() => {
  /** @type {string|null} Cached anonymised session identifier */
  let _sessionId = null;

  /**
   * Return a stable anonymous session ID for this browser session.
   * The value is generated once per page load and is NOT persisted.
   * @returns {string}
   */
  function getSessionId() {
    if (!_sessionId) {
      _sessionId =
        'sess_' +
        Date.now().toString(36) +
        '_' +
        Math.random().toString(36).slice(2, 10);
    }
    return _sessionId;
  }

  /**
   * Send a chat message to the backend and return the parsed response.
   *
   * @param {Object}  params
   * @param {string}  params.message              - User question
   * @param {'kb'|'current_article'} params.mode  - Retrieval mode
   * @param {string}  [params.currentArticleId]   - ID of open article
   * @param {string}  [params.currentArticleContent] - Plain-text content of open article
   * @param {Object}  [params.settings]           - Pre-loaded settings (skips storage read)
   * @returns {Promise<import('../shared/types.js').ChatResponse>}
   */
  async function sendMessage(params) {
    const { message, mode, currentArticleId, currentArticleContent } = params;

    // Resolve backend URL from settings
    let settings = params.settings;
    if (!settings) {
      settings = await Storage.getSettings();
    }

    const backendUrl = (settings.chatBackendUrl || '').trim();
    if (!backendUrl) {
      throw new Error('Chat backend URL is not configured. Please set it in Settings.');
    }

    // Build the /chat endpoint URL
    const endpoint = backendUrl.replace(/\/$/, '') + '/chat';

    /** @type {import('../shared/types.js').ChatRequest} */
    const body = {
      message,
      mode: mode || 'kb',
      sessionId: getSessionId()
    };

    if (currentArticleId) {
      body.currentArticleId = currentArticleId;
    }

    // Send article content in current_article mode so the backend can answer
    // without having to fetch the article independently.
    if (mode === 'current_article' && currentArticleContent) {
      body.currentArticleContent = currentArticleContent;
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (networkErr) {
      throw new Error(
        'Could not reach the chat backend. Check your network connection and the backend URL in Settings.'
      );
    }

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errJson = await response.json();
        errorDetail = errJson.error || errJson.message || '';
      } catch (_) {
        // ignore JSON parse errors for error responses
      }
      throw new Error(
        `Backend returned ${response.status}${errorDetail ? ': ' + errorDetail : ''}.`
      );
    }

    /** @type {import('../shared/types.js').ChatResponse} */
    const data = await response.json();
    return data;
  }

  /**
   * Check whether the backend is reachable (/health endpoint).
   *
   * @param {string} backendUrl - Base URL of the backend
   * @returns {Promise<boolean>}
   */
  async function checkHealth(backendUrl) {
    const url = (backendUrl || '').trim().replace(/\/$/, '') + '/health';
    try {
      const res = await fetch(url, { method: 'GET' });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  return { sendMessage, checkHealth, getSessionId };
})();
