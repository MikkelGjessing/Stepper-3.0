/**
 * Shared types and interfaces for the Ask Stepper chat feature.
 *
 * This file documents the data shapes used by both the extension UI
 * and the backend service. JavaScript objects conforming to these
 * shapes are passed between layers; no runtime enforcement is done here.
 */

/**
 * Chat request sent from the extension to the backend.
 *
 * @typedef {Object} ChatRequest
 * @property {string}  message           - The user's question
 * @property {'kb'|'current_article'} mode - Retrieval mode
 * @property {string}  [currentArticleId] - ID of the currently open article (current_article mode)
 * @property {string}  [currentArticleContent] - Plain-text content of the open article
 * @property {string}  sessionId         - Anonymous session identifier
 * @property {string}  [userId]          - Anonymized user identifier (optional)
 */

/**
 * A single knowledge-base source cited in a chat response.
 *
 * @typedef {Object} ChatSource
 * @property {string} articleId  - KB article identifier (e.g. "KB00123")
 * @property {string} title      - Article title
 * @property {string} snippet    - Relevant excerpt from the article
 * @property {number} score      - Relevance score (0–1)
 */

/**
 * A suggested follow-up action attached to a chat response.
 *
 * @typedef {Object} SuggestedAction
 * @property {'open_article'|'jump_to_step'|'view_related'} type
 * @property {string} label      - Human-readable button label
 * @property {string} [articleId]
 * @property {number} [stepIndex]
 */

/**
 * Chat response returned by the backend.
 *
 * @typedef {Object} ChatResponse
 * @property {string}           answer           - Grounded LLM answer
 * @property {ChatSource[]}     sources          - Cited knowledge-base articles
 * @property {SuggestedAction[]} suggestedActions - Follow-up action suggestions
 * @property {string}           [sessionId]      - Echo of the request session ID
 */

/**
 * Chat settings stored in extension preferences.
 *
 * @typedef {Object} ChatSettings
 * @property {boolean} enableChat                - Master switch; hides chat UI when false
 * @property {string}  chatBackendUrl            - URL of the backend /chat endpoint
 * @property {boolean} allowCurrentArticleChat   - Allow "Ask about current article" mode
 * @property {boolean} allowKnowledgeBaseChat    - Allow "Ask the knowledge base" mode
 */

// Export a factory for default chat settings so it can be imported by storage.js.
// (In MV3 service workers and content scripts this file is loaded as a plain <script>
//  tag; actual ES-module export syntax is not used to stay compatible.)
// eslint-disable-next-line no-unused-vars
function defaultChatSettings() {
  return {
    enableChat: false,
    chatBackendUrl: '',
    allowCurrentArticleChat: true,
    allowKnowledgeBaseChat: true
  };
}
