/**
 * Popup UI Controller
 * Manages the popup interface and user interactions
 */

// UI State Machine
const UI_STATE = {
  SEARCH: 'search',
  ARTICLE: 'article',
  FULL_ARTICLE: 'full_article',
  COMPLETE: 'complete'
};

let currentUIState = UI_STATE.SEARCH;
let currentStepIndex = 0; // Track current step in step-by-step mode

// State management
let currentArticles = [];
let currentSelectedArticle = null;
let storageChangeUnsubscribe = null;
let currentSettings = null;
let articleCompletionStates = {}; // { articleId: { completedStepIndexes: [], completedAt?: string } }
let hasSearched = false; // Track if user has performed a search

// ── Chat state ────────────────────────────────────────────────────────────────
/** Currently active top-level tab: 'guides' | 'chat' */
let activeTab = 'guides';
/** Currently selected chat mode: 'kb' | 'current_article' */
let chatMode = 'kb';
/** Whether a chat request is in-flight */
let chatLoading = false;

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const settingsBtn = document.getElementById('settingsBtn');
const resultsList = document.getElementById('resultsList');
const resultCount = document.getElementById('resultCount');
const refreshBtn = document.getElementById('refreshBtn');
const welcomeMessage = document.getElementById('welcomeMessage');
const resultsContent = document.getElementById('resultsContent');

// View containers
const searchView = document.getElementById('searchView');
const articleView = document.getElementById('articleView');
const fullArticleView = document.getElementById('fullArticleView');
const completeView = document.getElementById('completeView');

// Chat DOM elements
const tabSwitcher = document.getElementById('tabSwitcher');
const tabGuides = document.getElementById('tabGuides');
const tabChatBtn = document.getElementById('tabChat');
const guidesTab = document.getElementById('guidesTab');
const chatTab = document.getElementById('chatTab');
const chatModeBar = document.getElementById('chatModeBar');
const chatModeKBBtn = document.getElementById('chatModeKB');
const chatModeArticleBtn = document.getElementById('chatModeArticle');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup loaded');
  
  // Load settings first
  await loadSettings();
  
  // Load completion states
  await loadCompletionStates();
  
  // Load dummy articles if needed
  await Articles.loadDummyArticlesIfNeeded();
  
  // Load articles
  await loadArticles();
  
  // Setup event listeners
  setupEventListeners();
  
  // Subscribe to storage changes
  setupStorageListener();

  // Apply chat visibility based on settings
  applyChatSettings(currentSettings);
});

// Setup event listeners
function setupEventListeners() {
  searchBtn.addEventListener('click', handleSearch);
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  });
  
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  
  refreshBtn.addEventListener('click', async () => {
    await loadArticles();
    showNotification('Articles refreshed');
  });

  // Tab switcher
  if (tabGuides) {
    tabGuides.addEventListener('click', () => switchTab('guides'));
  }
  if (tabChatBtn) {
    tabChatBtn.addEventListener('click', () => switchTab('chat'));
  }

  // Chat mode toggle
  if (chatModeKBBtn) {
    chatModeKBBtn.addEventListener('click', () => setChatMode('kb'));
  }
  if (chatModeArticleBtn) {
    chatModeArticleBtn.addEventListener('click', () => setChatMode('current_article'));
  }

  // Chat send
  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', handleChatSend);
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleChatSend();
      }
    });
  }

  // Keyboard navigation for ARTICLE mode
  document.addEventListener('keydown', (e) => {
    if (currentUIState !== UI_STATE.ARTICLE) return;
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'Enter': {
        e.preventDefault();
        if (currentSelectedArticle && currentStepIndex === currentSelectedArticle.steps.length - 1) {
          handleCompleteProcess();
        } else {
          handleStepContinue();
        }
        break;
      }
      case 'ArrowLeft':
      case 'Backspace':
        if (currentStepIndex > 0) {
          e.preventDefault();
          handleStepBack();
        }
        break;
    }
  });
}

/**
 * Helper function to update search view visibility based on hasSearched state
 */
function updateSearchViewVisibility() {
  if (welcomeMessage && resultsContent) {
    if (hasSearched) {
      welcomeMessage.style.display = 'none';
      resultsContent.style.display = 'flex';
    } else {
      welcomeMessage.style.display = 'flex';
      resultsContent.style.display = 'none';
    }
  }
}

/**
 * View State Machine - Controls which view is visible
 */
function setView(state) {
  console.log('Setting view to:', state);
  currentUIState = state;
  
  // Hide all views
  searchView.style.display = 'none';
  articleView.style.display = 'none';
  fullArticleView.style.display = 'none';
  completeView.style.display = 'none';
  
  // Show the requested view
  switch (state) {
    case UI_STATE.SEARCH:
      searchView.style.display = 'flex';
      // Clear article state
      currentSelectedArticle = null;
      currentStepIndex = 0;
      // Show/hide welcome message based on hasSearched
      updateSearchViewVisibility();
      // Update chat mode bar (no article open)
      updateChatModeBar();
      break;
      
    case UI_STATE.ARTICLE:
      articleView.style.display = 'flex';
      break;
      
    case UI_STATE.FULL_ARTICLE:
      fullArticleView.style.display = 'flex';
      break;
      
    case UI_STATE.COMPLETE:
      completeView.style.display = 'flex';
      break;
  }
}

/**
 * Load settings from storage on startup
 * This ensures settings are loaded before articles are retrieved,
 * allowing Articles.getAllArticles() to properly filter based on settings
 */
async function loadSettings() {
  try {
    currentSettings = await Storage.getSettings();
    // Note: Not logging settings to avoid exposing secrets like PAT and API keys
    // Articles.getAllArticles() internally calls Storage.getSettings() to respect enableDummyArticles
  } catch (error) {
    console.error('Error loading settings:', error);
    currentSettings = {};
  }
}

/**
 * Load completion states from chrome.storage.local
 */
async function loadCompletionStates() {
  try {
    const result = await chrome.storage.local.get('articleCompletionStates');
    articleCompletionStates = result.articleCompletionStates || {};
  } catch (error) {
    console.error('Error loading completion states:', error);
    articleCompletionStates = {};
  }
}

/**
 * Save completion states to chrome.storage.local
 */
async function saveCompletionStates() {
  try {
    await chrome.storage.local.set({ articleCompletionStates });
  } catch (error) {
    console.error('Error saving completion states:', error);
  }
}

/**
 * Get completion state for an article
 */
function getCompletionState(articleId) {
  return articleCompletionStates[articleId] || { completedStepIndexes: [] };
}

/**
 * Mark a step as completed
 */
async function markStepCompleted(articleId, stepIndex) {
  if (!articleCompletionStates[articleId]) {
    articleCompletionStates[articleId] = { completedStepIndexes: [] };
  }
  
  const state = articleCompletionStates[articleId];
  if (!state.completedStepIndexes.includes(stepIndex)) {
    state.completedStepIndexes.push(stepIndex);
  }
  
  await saveCompletionStates();
}

/**
 * Mark article as fully completed
 */
async function markArticleCompleted(articleId) {
  if (!articleCompletionStates[articleId]) {
    articleCompletionStates[articleId] = { completedStepIndexes: [] };
  }
  
  articleCompletionStates[articleId].completedAt = new Date().toISOString();
  await saveCompletionStates();
}

/**
 * Reset progress for an article
 */
async function resetArticleProgress(articleId) {
  delete articleCompletionStates[articleId];
  await saveCompletionStates();
}

/**
 * Setup storage change listener to react to settings and article changes
 * Automatically refreshes the article list when changes are detected
 */
function setupStorageListener() {
  // Subscribe to storage changes
  storageChangeUnsubscribe = Storage.onChanged(async (changes, areaName) => {
    // React to settings changes
    if (changes.settings) {
      console.log('Settings changed, refreshing articles');
      currentSettings = await Storage.getSettings();
      await loadArticles();
      applyChatSettings(currentSettings);
    }
    
    // React to articles changes
    if (changes.articles) {
      console.log('Articles changed, refreshing display');
      await loadArticles();
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Chat feature – "Ask Stepper"
// ════════════════════════════════════════════════════════════════════════════

/**
 * Show or hide the tab switcher and chat tab based on current settings.
 * @param {Object} settings
 */
function applyChatSettings(settings) {
  if (!settings) return;
  const enabled = settings.enableChat === true;
  if (tabSwitcher) {
    tabSwitcher.style.display = enabled ? 'flex' : 'none';
  }
  // If chat is disabled while user is on chat tab, switch back to guides
  if (!enabled && activeTab === 'chat') {
    switchTab('guides');
  }
  // Update mode bar buttons based on per-mode permissions
  if (chatModeKBBtn) {
    chatModeKBBtn.style.display = settings.allowKnowledgeBaseChat === false ? 'none' : '';
  }
  if (chatModeArticleBtn) {
    chatModeArticleBtn.style.display = settings.allowCurrentArticleChat === false ? 'none' : '';
  }
}

/**
 * Switch the top-level tab.
 * @param {'guides'|'chat'} tab
 */
function switchTab(tab) {
  activeTab = tab;
  const isGuides = tab === 'guides';

  if (guidesTab) guidesTab.style.display = isGuides ? 'flex' : 'none';
  if (chatTab) chatTab.style.display = isGuides ? 'none' : 'flex';

  if (tabGuides) tabGuides.classList.toggle('tab-btn-active', isGuides);
  if (tabChatBtn) tabChatBtn.classList.toggle('tab-btn-active', !isGuides);

  // Reflect whether we're inside an article in the mode bar
  if (!isGuides) {
    updateChatModeBar();
  }
}

/**
 * Show/hide the article-mode toggle in the chat tab based on whether an
 * article is currently open.
 */
function updateChatModeBar() {
  const hasArticle = currentSelectedArticle !== null;
  const allowArticleMode = currentSettings && currentSettings.allowCurrentArticleChat !== false;
  if (chatModeBar) {
    chatModeBar.style.display = (hasArticle && allowArticleMode) ? 'flex' : 'none';
  }
  // If article closed but mode was current_article, fall back to kb
  if (!hasArticle && chatMode === 'current_article') {
    setChatMode('kb');
  }
}

/**
 * Switch chat retrieval mode.
 * @param {'kb'|'current_article'} mode
 */
function setChatMode(mode) {
  chatMode = mode;
  if (chatModeKBBtn) chatModeKBBtn.classList.toggle('chat-mode-btn-active', mode === 'kb');
  if (chatModeArticleBtn) chatModeArticleBtn.classList.toggle('chat-mode-btn-active', mode === 'current_article');
}

/**
 * Handle the send button / Enter key in the chat input.
 */
async function handleChatSend() {
  if (chatLoading) return;

  const message = (chatInput ? chatInput.value : '').trim();
  if (!message) return;

  // Clear input
  if (chatInput) chatInput.value = '';

  // Append user message bubble
  appendChatMessage('user', message);

  // Show loading indicator
  chatLoading = true;
  const loadingEl = appendChatLoading();
  if (chatSendBtn) chatSendBtn.disabled = true;

  try {
    // Build params
    const params = {
      message,
      mode: chatMode,
      settings: currentSettings
    };

    if (chatMode === 'current_article' && currentSelectedArticle) {
      params.currentArticleId = currentSelectedArticle.id;
      // Provide plain-text article content for backend context
      params.currentArticleContent = buildArticlePlainText(currentSelectedArticle);
    }

    const response = await Chat.sendMessage(params);
    loadingEl.remove();
    appendChatResponse(response);
  } catch (err) {
    loadingEl.remove();
    // Limit displayed error to a safe maximum length to avoid rendering large server payloads
    const rawMsg = (err && err.message) ? err.message : 'Something went wrong. Please try again.';
    const safeMsg = rawMsg.length > 200 ? rawMsg.slice(0, 200) + '…' : rawMsg;
    appendChatMessage('error', '⚠️ ' + safeMsg);
  } finally {
    chatLoading = false;
    if (chatSendBtn) chatSendBtn.disabled = false;
    if (chatInput) chatInput.focus();
  }
}

/**
 * Build a plain-text representation of an article for the backend context.
 * @param {Object} article
 * @returns {string}
 */
function buildArticlePlainText(article) {
  const parts = [];
  if (article.title) parts.push(article.title);
  if (article.summary) parts.push(article.summary);
  if (Array.isArray(article.steps)) {
    article.steps.forEach((step, i) => {
      const num = step.displayNumber || (i + 1);
      if (step.title) parts.push(`Step ${num}: ${step.title}`);
      if (step.bodyHtml) {
        // Strip tags for plain text
        const div = document.createElement('div');
        div.innerHTML = step.bodyHtml;
        const text = (div.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) parts.push(text);
      }
    });
  }
  return parts.join('\n\n');
}

/**
 * Append a plain text bubble to the chat log.
 * @param {'user'|'assistant'|'error'} role
 * @param {string} text
 * @returns {HTMLElement}
 */
function appendChatMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

/**
 * Append a loading spinner placeholder.
 * @returns {HTMLElement}
 */
function appendChatLoading() {
  const el = document.createElement('div');
  el.className = 'chat-bubble chat-bubble-assistant chat-loading';
  el.innerHTML = '<span class="chat-dots"><span>.</span><span>.</span><span>.</span></span>';
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return el;
}

/**
 * Append a full assistant response with sources and suggested actions.
 * @param {Object} response - ChatResponse shape
 */
function appendChatResponse(response) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-response';

  // Answer text
  const answerEl = document.createElement('div');
  answerEl.className = 'chat-bubble chat-bubble-assistant';
  answerEl.textContent = response.answer || '(No answer returned)';
  wrapper.appendChild(answerEl);

  // Sources
  if (Array.isArray(response.sources) && response.sources.length > 0) {
    const sourcesEl = document.createElement('div');
    sourcesEl.className = 'chat-sources';
    sourcesEl.innerHTML = '<div class="chat-sources-label">Sources</div>';
    response.sources.forEach(src => {
      const srcEl = document.createElement('div');
      srcEl.className = 'chat-source-item';
      srcEl.innerHTML = `<span class="chat-source-title">${escapeHtml(src.title || src.articleId)}</span>`;
      if (src.snippet) {
        const snipEl = document.createElement('div');
        snipEl.className = 'chat-source-snippet';
        snipEl.textContent = src.snippet.length > 120
          ? src.snippet.slice(0, 120) + '…'
          : src.snippet;
        srcEl.appendChild(snipEl);
      }
      sourcesEl.appendChild(srcEl);
    });
    wrapper.appendChild(sourcesEl);
  }

  // Suggested actions
  if (Array.isArray(response.suggestedActions) && response.suggestedActions.length > 0) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'chat-actions';
    response.suggestedActions.forEach(action => {
      const btn = document.createElement('button');
      btn.className = 'chat-action-btn';
      btn.textContent = action.label || 'Open article';
      if (action.type === 'open_article' && action.articleId) {
        btn.addEventListener('click', () => {
          // Switch to guides tab and open the article
          switchTab('guides');
          displayArticle(action.articleId);
        });
      }
      actionsEl.appendChild(btn);
    });
    wrapper.appendChild(actionsEl);
  }

  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ════════════════════════════════════════════════════════════════════════════
// End chat feature
// ════════════════════════════════════════════════════════════════════════════

// Load articles from storage
async function loadArticles() {
  try {
    currentArticles = await Articles.getAllArticles(true);
    console.log('Loaded articles:', currentArticles.length);
    displayResults(currentArticles);
  } catch (error) {
    console.error('Error loading articles:', error);
    showError('Failed to load articles');
  }
}

// Handle search
async function handleSearch() {
  const query = searchInput.value.trim();
  
  // If query is empty, revert to pre-search state
  if (!query) {
    hasSearched = false;
    resultsList.innerHTML = '';
    updateSearchViewVisibility();
    return;
  }
  
  console.log('Searching for:', query);
  
  // Mark that a search has been performed
  hasSearched = true;
  
  // Show results container
  updateSearchViewVisibility();
  
  try {
    // Use the new searchArticles function with settings
    const results = await Search.searchArticles(query, currentArticles, currentSettings);
    displayResults(results);
  } catch (error) {
    console.error('Search error:', error);
    // Fallback to keyword search on error
    const results = Search.search(query, currentArticles);
    displayResults(results);
  }
}

// Display search results
function displayResults(articles) {
  // Only render results if a search has been performed
  if (!hasSearched) {
    return;
  }
  
  if (!articles || articles.length === 0) {
    resultsList.innerHTML = `
      <div class="empty-state">
        <p>No articles found</p>
        <p>Try a different search or add some articles</p>
      </div>
    `;
    resultCount.textContent = '0 articles';
    return;
  }
  
  resultCount.textContent = `${articles.length} article${articles.length !== 1 ? 's' : ''}`;
  
  resultsList.innerHTML = articles.map(article => {
    const stepCount = article.steps && Array.isArray(article.steps) ? article.steps.length : 0;
    // Use article.title; warn and fall back if missing
    let displayTitle = article.title;
    if (!displayTitle || !displayTitle.trim()) {
      console.warn('[Stepper] Search result has no title, using fallback. id:', article.id);
      displayTitle = 'Untitled article';
    }
    console.log('[Stepper] Search result rendered: title=', displayTitle, '| id=', article.id);
    return `
      <div class="result-item" data-article-id="${article.id}">
        <div class="result-item-title">${escapeHtml(displayTitle)}</div>
        <div class="result-item-meta">
          ${article.summary ? `<div class="result-item-summary">${escapeHtml(article.summary)}</div>` : ''}
          <div class="result-item-info">
            <span class="result-item-steps">${stepCount} step${stepCount !== 1 ? 's' : ''}</span>
            ${article.estimatedMinutes ? `<span class="result-item-time">⏱ ${article.estimatedMinutes} min</span>` : ''}
          </div>
        </div>
        ${article.tags && article.tags.length > 0 ? `
          <div class="result-item-tags">
            ${article.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  // Add click handlers to result items
  document.querySelectorAll('.result-item').forEach(item => {
    item.addEventListener('click', () => {
      const articleId = item.getAttribute('data-article-id');
      displayArticle(articleId);
    });
  });
}

// Display selected article
async function displayArticle(articleId) {
  const article = await Articles.getArticleById(articleId);
  
  if (!article) {
    showError('Article not found');
    return;
  }
  
  currentSelectedArticle = article;
  currentStepIndex = 0; // Start at first step

  // Refresh chat mode bar now that an article is open
  updateChatModeBar();
  
  // Check if article has steps
  const steps = article.steps && Array.isArray(article.steps) && article.steps.length > 0 
    ? article.steps 
    : [];
  
  // Handle edge case: article with 0 steps
  if (steps.length === 0) {
    setView(UI_STATE.ARTICLE);
    const articleContentScrollable = document.getElementById('articleContentScrollable');
    articleContentScrollable.innerHTML = `
      <div class="error-message">
        <h3>⚠️ No Steps Available</h3>
        <p>This article does not contain any step-by-step instructions.</p>
        <button class="primary-btn" id="backToSearchBtn">← Back to Search</button>
      </div>
    `;
    
    const backToSearchBtn = document.getElementById('backToSearchBtn');
    if (backToSearchBtn) {
      backToSearchBtn.addEventListener('click', () => setView(UI_STATE.SEARCH));
    }
    
    return;
  }
  
  // Switch to step-by-step article view
  setView(UI_STATE.ARTICLE);
  renderStepView();
}

// Regex that matches leading "STEP N:", "Step 2 –", "STEP 1 -", "STEP 1" tokens.
// Used by _normalizeTitleForComparison to strip step-number prefixes before comparing.
const _STEP_TOKEN_RE = /^(?:step)\s+\d+\s*[:\-–]?\s*/i;

// Block-level element tags considered meaningful heading content for duplicate detection.
// Inline elements (<span>, <a>, <em>, etc.) and <br> are intentionally excluded.
const _HEADING_BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI']);

/**
 * Normalize a title string for fuzzy duplicate comparison.
 * - lowercase
 * - strip leading step-number tokens (STEP 1:, Step 2 –, etc.)
 * - replace colons and dashes with spaces
 * - collapse whitespace and trim
 * @param {string} str
 * @returns {string}
 */
function _normalizeTitleForComparison(str) {
  return String(str || '')
    .toLowerCase()
    .replace(_STEP_TOKEN_RE, '')       // strip leading step-number tokens
    .replace(/[:\-–]/g, ' ')           // punctuation → space
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim();
}

/**
 * Strip the promoted step title from the beginning of a body container.
 *
 * Checks the first 1–3 consecutive meaningful block elements and removes them
 * when their combined text matches the resolved step title (fuzzy comparison).
 * This prevents duplicated bold headings from appearing at the top of step bodies.
 *
 * @param {string}  stepTitle - The resolved display title for the step
 * @param {Element} bodyDiv   - The div whose leading children will be inspected/stripped
 */
function _stripPromotedTitleFromBody(stepTitle, bodyDiv) {
  if (!stepTitle || !bodyDiv) return;

  const normTitle = _normalizeTitleForComparison(stepTitle);
  if (!normTitle) return;

  // Collect up to 3 consecutive meaningful block elements from the start
  const leadingEls = [];
  for (const el of Array.from(bodyDiv.children)) {
    if (leadingEls.length >= 3) break;
    if (_HEADING_BLOCK_TAGS.has(el.tagName)) {
      leadingEls.push(el);
    } else {
      break; // non-block element interrupts the heading run
    }
  }

  if (leadingEls.length === 0) return;

  // Title with trailing artifact digits stripped ("…VAT1" → "…VAT")
  const normTitleStripped = normTitle.replace(/\s*\d+\s*$/, '').trim();

  for (let count = 1; count <= leadingEls.length; count++) {
    const subset = leadingEls.slice(0, count);
    const combinedText = subset.map(el => el.textContent).join(' ');
    const normCombined = _normalizeTitleForComparison(combinedText);

    if (!normCombined) continue;

    // Primary: exact match after normalization
    if (normCombined === normTitle) {
      subset.forEach(el => el.remove());
      return;
    }

    // Fuzzy: also strip trailing artifact digits from combined text
    const normCombinedStripped = normCombined.replace(/\s*\d+\s*$/, '').trim();
    if (normTitleStripped && normCombinedStripped &&
        normTitleStripped === normCombinedStripped) {
      subset.forEach(el => el.remove());
      return;
    }
  }
}

/**
 * Render step-by-step view (one step at a time with progress bar)
 */
function renderStepView() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const steps = article.steps;
  const totalSteps = steps.length;
  const currentStep = steps[currentStepIndex];
  
  const articleHeader = document.getElementById('articleHeader');
  const articleContentScrollable = document.getElementById('articleContentScrollable');
  const articleNavContainer = document.getElementById('articleNavContainer');
  const stepCounterEl = document.getElementById('stepCounter');
  
  // Calculate progress percentage
  const progressPercentage = ((currentStepIndex + 1) / totalSteps) * 100;

  // Resolve article header title — fall back and warn if missing
  let articleDisplayTitle = article.title;
  if (!articleDisplayTitle || !articleDisplayTitle.trim()) {
    console.warn('[Stepper] Article header rendered with no title, using fallback. id:', article.id);
    articleDisplayTitle = 'Untitled article';
  }
  console.log('[Stepper] Article header rendered: title=', articleDisplayTitle, '| id=', article.id);

  // Render header: article title + progress bar only (no step counter text)
  articleHeader.innerHTML = `
    <h2 class="step-view-title">${escapeHtml(articleDisplayTitle)}</h2>
    <div class="progress-bar-container">
      <div class="progress-bar-fill" style="width: ${progressPercentage}%"></div>
    </div>
  `;
  
  // Extract pure step title: strip "Step N:" prefix if present (added by the parser).
  // Guard against null/undefined up front to keep the remaining logic clean.
  let displayTitle = (currentStep.title || '').trim();
  // Strip "Step N:" / "STEP N:" / "Step N –" prefix (with separator)
  const stepPrefixMatch = displayTitle.match(/^(?:Step|STEP)\s+\d+\s*[:\-–]\s*/i);
  if (stepPrefixMatch) {
    displayTitle = displayTitle.slice(stepPrefixMatch[0].length).trim();
  }
  // Strip bare "Step N" / "STEP N" (no colon) — these are numeric markers, not titles.
  if (/^(?:Step|STEP)\s+\d+\s*$/i.test(displayTitle)) {
    displayTitle = '';
  }

  // Pre-process bodyHtml: sanitize once, then strip duplicate step-label elements.
  const bodyDiv = document.createElement('div');
  bodyDiv.innerHTML = sanitizeHtml(currentStep.bodyHtml || '');
  // Remove leading generic "STEP" / "STEP N" / "Step" / "Step N" labels from body
  // (they duplicate the step-label indicator already shown above the title).
  {
    let firstEl = bodyDiv.firstElementChild;
    while (firstEl && /^(?:STEP|Step)\s*\d*\s*$/.test(firstEl.textContent.trim())) {
      firstEl.remove();
      firstEl = bodyDiv.firstElementChild;
    }
  }
  // If no display title yet, promote the first body element as the title
  // (handles standalone "STEP N" markers where title was deferred to body).
  if (!displayTitle) {
    const firstEl = bodyDiv.firstElementChild;
    if (firstEl) {
      const firstText = firstEl.textContent.trim();
      if (firstText && firstText.length <= 100) {
        displayTitle = firstText;
        firstEl.remove();
      }
    }
  }
  // Strip leading body elements that duplicate the display title.
  // Uses fuzzy normalization to handle multi-paragraph headings, colon variants,
  // and trailing artifact digits (e.g. "…VAT1" in title vs "…VAT" in body).
  if (displayTitle) {
    _stripPromotedTitleFromBody(displayTitle, bodyDiv);
  }
  // If title is just the generic "STEP" / "Step" label (no number, no description),
  // promote the first body element as the real step title so that "STEP 1 / STEP / body"
  // becomes "STEP 1 / <actual title> / body" (see acceptance criteria).
  // Use the first sentence of the body element (not the full text) to keep the title short.
  if (/^(?:STEP|Step)\s*$/.test(displayTitle)) {
    const firstEl = bodyDiv.firstElementChild;
    if (firstEl) {
      const fullText = firstEl.textContent.trim();
      // Extract first sentence (split on sentence-ending punctuation followed by space or end)
      const firstSentence = fullText.replace(/\s+/g, ' ')
        .split(/[.!?](?:\s|$)/)[0].trim();
      const titleCandidate = firstSentence.length > 80
        ? firstSentence.substring(0, 80)
        : firstSentence;
      if (titleCandidate && !/^(?:STEP|Step)\s*\d*\s*$/.test(titleCandidate)) {
        displayTitle = titleCandidate;
        firstEl.remove();
      }
    }
  }
  // Never show an empty step title
  if (!displayTitle) {
    console.warn('[Stepper] Step has no display title, using fallback. Step index:', currentStepIndex + 1);
    displayTitle = `Step ${currentStepIndex + 1}`;
  }
  console.log('[Stepper] Step rendered: step.title=', displayTitle, '| article=', article.title, '| stepIndex=', currentStepIndex + 1);

  // Use the stored displayNumber when available (preserves original step numbering
  // from the source document); fall back to the sequential 1-based index.
  const displayNumber = currentStep.displayNumber || (currentStepIndex + 1);

  // Render step content into the scrollable area
  articleContentScrollable.innerHTML = `
    <div class="step-view-content">
      <div class="step-label">STEP ${displayNumber}</div>
      <h3 class="step-view-step-title">${escapeHtml(displayTitle)}</h3>
      <div class="step-view-step-body">
        ${bodyDiv.innerHTML}
      </div>
    </div>
  `;
  
  // Wrap images with thumbnail preview system
  wrapImagesWithPreview(articleContentScrollable);

  // Build nav buttons for footer
  const isLastStep = currentStepIndex === totalSteps - 1;
  const navButtonHtml = isLastStep 
    ? '<button class="nav-btn primary-btn" id="completeProcessBtn">✓ Complete process</button>'
    : '<button class="nav-btn primary-btn" id="stepContinueBtn">Continue →</button>';
  
  // Render nav buttons into the footer container
  articleNavContainer.innerHTML = `
    <div class="step-nav-row">
      <button class="nav-btn secondary-btn" id="stepBackBtn" ${currentStepIndex === 0 ? 'disabled' : ''}>
        ← Back
      </button>
      ${navButtonHtml}
    </div>
    <div class="step-action-row">
      <button class="action-btn secondary-btn" id="viewFullArticleBtn">📄 View full article</button>
      <button class="action-btn secondary-btn" id="searchNewArticleBtn">🔍 Search for new article</button>
    </div>
  `;
  
  // Update step counter label below the buttons
  if (stepCounterEl) {
    stepCounterEl.textContent = `Step ${currentStepIndex + 1} of ${totalSteps}`;
  }
  
  // Add event listeners (using onclick to avoid duplicate listeners)
  const stepBackBtn = document.getElementById('stepBackBtn');
  if (stepBackBtn) {
    stepBackBtn.onclick = handleStepBack;
  }
  
  const stepContinueBtn = document.getElementById('stepContinueBtn');
  if (stepContinueBtn) {
    stepContinueBtn.onclick = handleStepContinue;
  }
  
  const completeProcessBtn = document.getElementById('completeProcessBtn');
  if (completeProcessBtn) {
    completeProcessBtn.onclick = handleCompleteProcess;
  }
  
  const viewFullArticleBtn = document.getElementById('viewFullArticleBtn');
  if (viewFullArticleBtn) {
    viewFullArticleBtn.onclick = () => {
      setView(UI_STATE.FULL_ARTICLE);
      renderFullArticleView();
    };
  }
  
  const searchNewArticleBtn = document.getElementById('searchNewArticleBtn');
  if (searchNewArticleBtn) {
    searchNewArticleBtn.onclick = () => {
      setView(UI_STATE.SEARCH);
      searchInput.focus();
    };
  }

  // Asynchronously enrich the step body with any ID values found on the active tab
  if (currentSettings && currentSettings.enablePageScanning) {
    enrichStepWithPageIds(articleContentScrollable).catch(err => {
      console.log('Page ID enrichment skipped:', err.message);
    });
  }
}

/**
 * Extract words that look like ID field names from a text string.
 * Matches camelCase / PascalCase tokens ending with "ID" or "Id"
 * (e.g. "customerID", "TerminalID", "AccountId").
 * @param {string} text
 * @returns {string[]} Deduplicated list of keyword tokens
 */
function extractIdKeywords(text) {
  const keywords = new Set();
  const matches = text.matchAll(/\b(\w+[Ii][Dd])\b/g);
  for (const m of matches) keywords.add(m[1]);
  return [...keywords];
}

/**
 * Walk all text nodes inside `container`, and for each keyword present in
 * `pageValues` inject a `.page-id-value` badge showing the found value.
 * Example: "find customerID" → "find customerID [32109876]"
 * @param {Element} container
 * @param {Object} pageValues - { keyword: value } map
 */
function injectPageIdValues(container, pageValues) {
  const keyList = Object.keys(pageValues);
  if (keyList.length === 0) return;

  // Pre-build a case-insensitive lookup map to avoid repeated find() calls
  const keyMap = new Map(keyList.map(k => [k.toLowerCase(), k]));

  const keyPattern = new RegExp(
    '(' + keyList.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
    'gi'
  );

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  textNodes.forEach(textNode => {
    const text = textNode.nodeValue;
    keyPattern.lastIndex = 0;
    if (!keyPattern.test(text)) return;
    keyPattern.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = keyPattern.exec(text)) !== null) {
      // Guard against zero-length matches causing infinite loops
      if (match.index === keyPattern.lastIndex) {
        keyPattern.lastIndex++;
        continue;
      }

      const keyword = match[0];
      const key = keyMap.get(keyword.toLowerCase());
      if (!key) continue;

      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      frag.appendChild(document.createTextNode(keyword));

      const badge = document.createElement('span');
      badge.className = 'page-id-value';
      badge.textContent = ' [' + pageValues[key] + ']';
      frag.appendChild(badge);

      lastIndex = match.index + keyword.length;
    }

    if (frag.childNodes.length > 0) {
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
  });
}

/**
 * Enrich the rendered step content with ID values extracted from the active tab.
 * Extracts ID keywords from visible step text, asks the service worker to scan
 * the current page, then injects found values inline as [value] badges.
 * @param {Element} container - The articleContentScrollable element
 */
async function enrichStepWithPageIds(container) {
  if (!container) return;

  const stepBody = container.querySelector('.step-view-step-body');
  const stepTitle = container.querySelector('.step-view-step-title');
  const allText = (stepTitle ? stepTitle.textContent : '') + ' ' +
                  (stepBody ? stepBody.textContent : '');

  const keywords = extractIdKeywords(allText);
  if (keywords.length === 0) return;

  let pageValues = {};
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SCAN_PAGE', keywords });
    pageValues = response && response.results ? response.results : {};
  } catch (e) {
    // Extension context may not support scanning (e.g. on restricted pages) – fail silently
    return;
  }

  if (Object.keys(pageValues).length === 0) return;

  injectPageIdValues(container, pageValues);
}

/**
 * Handle Back button in step-by-step view
 */
function handleStepBack() {
  if (currentStepIndex > 0) {
    currentStepIndex--;
    renderStepView();
  }
}

/**
 * Handle Continue button in step-by-step view
 * Marks current step as completed and advances to next step
 */
async function handleStepContinue() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const totalSteps = article.steps.length;
  
  // Mark current step as completed
  await markStepCompleted(article.id, currentStepIndex);
  
  // Check if all steps are now completed
  const completionState = getCompletionState(article.id);
  if (areAllStepsCompleted(completionState, totalSteps) && !completionState.completedAt) {
    await markArticleCompleted(article.id);
  }
  
  // Advance to next step
  if (currentStepIndex < totalSteps - 1) {
    currentStepIndex++;
    renderStepView();
  }
}

/**
 * Handle Complete Process button on the last step
 * Marks the last step as completed, sets completedAt timestamp, and shows completion summary
 */
async function handleCompleteProcess() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const totalSteps = article.steps.length;
  
  // Mark the last step as completed (if not already)
  await markStepCompleted(article.id, currentStepIndex);
  
  // Mark article as completed with timestamp
  await markArticleCompleted(article.id);
  
  // Transition to completion summary view
  setView(UI_STATE.COMPLETE);
  renderCompleteView();
}

/**
 * Helper function to check if all steps in an article are completed
 */
function areAllStepsCompleted(completionState, totalSteps) {
  return completionState.completedStepIndexes.length === totalSteps;
}

// Render the full article view with all steps (clean reading format, no checkboxes)
function renderFullArticleView() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const steps = article.steps;
  const totalSteps = steps.length;
  const completionState = getCompletionState(article.id);
  const isArticleCompleted = completionState.completedAt && areAllStepsCompleted(completionState, totalSteps);
  
  const fullArticleContentScrollable = document.getElementById('fullArticleContentScrollable');
  
  // Build the article header
  let headerHtml = `
    <div class="full-article-header">
      <h2>${escapeHtml(article.title)}</h2>
      ${article.summary ? `<p class="full-article-summary">${escapeHtml(article.summary)}</p>` : ''}
    </div>
  `;
  
  // If article is completed, show banner
  if (isArticleCompleted) {
    headerHtml += `
      <div class="article-completed-banner">
        <h3>✅ Article Completed!</h3>
        <p>Completed on ${new Date(completionState.completedAt).toLocaleDateString()}</p>
      </div>
    `;
  }
  
  // Navigation buttons
  headerHtml += `
    <div class="full-article-navigation">
      <button class="secondary-btn" id="backToStepViewBtn">← Back to step-by-step</button>
      <button class="primary-btn" id="jumpToCurrentStepBtn">📍 Jump to current step</button>
    </div>
  `;
  
  // Render all steps
  let stepsHtml = '<div class="full-article-steps-list">';
  
  steps.forEach((step, index) => {
    const isStepCompleted = completionState.completedStepIndexes.includes(index);
    const isCurrentStep = index === currentStepIndex;
    
    stepsHtml += `
      <div class="full-article-step ${isStepCompleted ? 'completed' : ''} ${isCurrentStep ? 'current' : ''}" 
           data-step-index="${index}"
           id="full-article-step-${index}">
        <div class="full-article-step-header-clickable" data-step-index="${index}">
          <div class="full-article-step-title-row">
            <div class="full-article-step-number">${isStepCompleted ? '✓' : index + 1}</div>
            <h3 class="full-article-step-title">${escapeHtml(step.title)}</h3>
          </div>
        </div>
        <div class="full-article-step-body">
          ${sanitizeHtml(step.bodyHtml)}
        </div>
      </div>
    `;
  });
  
  stepsHtml += '</div>';
  
  // Combine everything
  fullArticleContentScrollable.innerHTML = headerHtml + stepsHtml;
  
  // Wrap images with thumbnail preview system
  wrapImagesWithPreview(fullArticleContentScrollable);

  // Add event listeners for navigation buttons (using onclick to avoid duplicate listeners)
  const backToStepViewBtn = document.getElementById('backToStepViewBtn');
  if (backToStepViewBtn) {
    backToStepViewBtn.onclick = () => {
      setView(UI_STATE.ARTICLE);
      renderStepView();
    };
  }
  
  const jumpToCurrentStepBtn = document.getElementById('jumpToCurrentStepBtn');
  if (jumpToCurrentStepBtn) {
    jumpToCurrentStepBtn.onclick = () => {
      const currentStepElement = document.getElementById(`full-article-step-${currentStepIndex}`);
      if (currentStepElement) {
        currentStepElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
  }
  
  // Add click handlers to step headers to jump to that step in step-by-step view
  document.querySelectorAll('.full-article-step-header-clickable').forEach(header => {
    header.onclick = () => {
      const stepIndex = parseInt(header.getAttribute('data-step-index'), 10);
      currentStepIndex = stepIndex;
      setView(UI_STATE.ARTICLE);
      renderStepView();
    };
  });
}

/**
 * Render the completion summary view
 * Shows article completion status, metrics, and step overview
 */
function renderCompleteView() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const steps = article.steps;
  const totalSteps = steps.length;
  const completionState = getCompletionState(article.id);
  const completedCount = completionState.completedStepIndexes.length;
  const missingSteps = [];
  
  // Find missing steps
  for (let i = 0; i < totalSteps; i++) {
    if (!completionState.completedStepIndexes.includes(i)) {
      missingSteps.push({ index: i, title: steps[i].title });
    }
  }
  
  // Format the completion date
  let formattedDate = 'Unknown';
  if (completionState.completedAt) {
    try {
      const date = new Date(completionState.completedAt);
      formattedDate = date.toLocaleString();
    } catch (e) {
      console.error('Error formatting date:', e);
    }
  }
  
  const completeContentScrollable = document.getElementById('completeContentScrollable');
  
  // Build completion header with status banner
  let html = `
    <div class="complete-view-header">
      <div class="completion-status-banner">
        <h2>✓ Process Completed</h2>
        <p class="completion-timestamp">Completed on ${escapeHtml(formattedDate)}</p>
      </div>
      
      <h3 class="completion-article-title">${escapeHtml(article.title)}</h3>
      
      <div class="completion-metrics">
        <div class="completion-metric">
          <div class="metric-value">${completedCount} / ${totalSteps}</div>
          <div class="metric-label">Steps completed</div>
        </div>
        ${missingSteps.length > 0 ? `
          <div class="completion-metric warning">
            <div class="metric-value">${missingSteps.length}</div>
            <div class="metric-label">Steps missing</div>
          </div>
        ` : ''}
      </div>
      
      ${missingSteps.length > 0 ? `
        <div class="missing-steps-notice">
          <h4>⚠️ Missing Steps:</h4>
          <ul>
            ${missingSteps.map(step => 
              `<li>Step ${step.index + 1}: ${escapeHtml(step.title)}</li>`
            ).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
    
    <div class="completion-steps-overview">
      <h4>Step Overview</h4>
      <div class="completion-steps-list">
        ${steps.map((step, index) => {
          const isCompleted = completionState.completedStepIndexes.includes(index);
          return `
            <div class="completion-step-item ${isCompleted ? 'completed' : 'not-completed'}">
              <div class="completion-step-indicator">
                ${isCompleted ? '✓' : '○'}
              </div>
              <div class="completion-step-info">
                <span class="completion-step-number">Step ${index + 1}</span>
                <span class="completion-step-title">${escapeHtml(step.title)}</span>
              </div>
              <div class="completion-step-status">
                ${isCompleted ? 'Completed' : 'Not completed'}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    
    <div class="completion-actions">
      <button class="primary-btn" id="restartProcessBtn">🔄 Restart process</button>
      <button class="secondary-btn" id="returnToStepBtn">← Return to step-by-step</button>
      <button class="secondary-btn" id="searchNewFromCompleteBtn">🔍 Search for new article</button>
    </div>
  `;
  
  completeContentScrollable.innerHTML = html;
  
  // Add event listeners
  const restartProcessBtn = document.getElementById('restartProcessBtn');
  if (restartProcessBtn) {
    restartProcessBtn.onclick = handleRestartProcess;
  }
  
  const returnToStepBtn = document.getElementById('returnToStepBtn');
  if (returnToStepBtn) {
    returnToStepBtn.onclick = handleReturnToStepView;
  }
  
  const searchNewFromCompleteBtn = document.getElementById('searchNewFromCompleteBtn');
  if (searchNewFromCompleteBtn) {
    searchNewFromCompleteBtn.onclick = handleSearchNewFromComplete;
  }
}

/**
 * Handle Return to Step-by-step button from complete view
 * Returns to the last step in ARTICLE view
 */
function handleReturnToStepView() {
  if (!currentSelectedArticle) return;
  
  const totalSteps = currentSelectedArticle.steps.length;
  currentStepIndex = totalSteps - 1;
  setView(UI_STATE.ARTICLE);
  renderStepView();
}

/**
 * Handle Search for new article button from complete view
 * Returns to SEARCH view and focuses search input
 */
function handleSearchNewFromComplete() {
  setView(UI_STATE.SEARCH);
  searchInput.focus();
}

/**
 * Handle Restart Process button
 * Clears completion state and returns to first step
 */
async function handleRestartProcess() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  
  // Clear completion state for this article
  await resetArticleProgress(article.id);
  
  // Return to first step
  currentStepIndex = 0;
  setView(UI_STATE.ARTICLE);
  renderStepView();
}

// Show notification
function showNotification(message) {
  // Simple notification - could be enhanced with a toast component
  console.log('Notification:', message);
  alert(message);
}

// Show error
function showError(message) {
  console.error('Error:', message);
  alert('Error: ' + message);
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Sanitize HTML content - allows only safe tags and removes scripts
function sanitizeHtml(html) {
  if (!html) return '';
  
  const div = document.createElement('div');
  div.innerHTML = html;
  
  // Remove all script tags
  const scripts = div.querySelectorAll('script');
  scripts.forEach(script => script.remove());
  
  // Remove event handlers
  const allElements = div.querySelectorAll('*');
  allElements.forEach(el => {
    // Remove all event handler attributes
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    });
    
    // Remove javascript: URLs
    if (el.hasAttribute('href') && el.getAttribute('href').toLowerCase().includes('javascript:')) {
      el.removeAttribute('href');
    }
    if (el.hasAttribute('src') && el.getAttribute('src').toLowerCase().includes('javascript:')) {
      el.removeAttribute('src');
    }
  });
  
  return div.innerHTML;
}

/**
 * Wraps all <img> elements inside a container with a compact thumbnail preview
 * and attaches click/keyboard handlers to open the image viewer tab.
 * Idempotent: images already wrapped are skipped via .image-preview ancestor
 * check and data-previewized attribute.
 */
function wrapImagesWithPreview(container) {
  if (!container) return;
  const images = container.querySelectorAll('img');
  images.forEach(img => {
    // Skip if already wrapped inside a preview container
    if (img.closest('.image-preview')) return;

    const src = img.src || img.getAttribute('src') || '';
    const alt = img.alt || '';

    // Build preview wrapper
    const preview = document.createElement('div');
    preview.className = 'image-preview';
    preview.setAttribute('role', 'button');
    preview.setAttribute('tabindex', '0');
    preview.setAttribute('aria-label', 'Click to display image');
    preview.dataset.previewized = 'true';

    // Thumbnail image (reuse original src, lazy-load)
    const thumb = document.createElement('img');
    thumb.className = 'image-thumb';
    thumb.src = src;
    thumb.alt = alt;
    thumb.loading = 'lazy';
    thumb.addEventListener('error', () => {
      preview.style.display = 'none';
    });

    // Overlay text
    const overlay = document.createElement('div');
    overlay.className = 'image-overlay';
    overlay.textContent = 'Click to display image';

    preview.appendChild(thumb);
    preview.appendChild(overlay);

    // Replace original img with preview container (removes original from DOM)
    img.replaceWith(preview);

    // Open image viewer tab on click or Enter key
    const openViewer = () => openImageViewer(src, alt);
    preview.addEventListener('click', openViewer);
    preview.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        openViewer();
        e.preventDefault();
      }
    });
  });
}

/**
 * Open the image in a dedicated viewer tab so it can display outside the
 * side-panel column without any size constraints.
 * The image src is stashed in chrome.storage.session (keyed by a unique id)
 * to support arbitrarily-large data URLs that would overflow a query string.
 */
function openImageViewer(src, alt) {
  const key = 'imgViewer_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  chrome.storage.session.set({ [key]: { src, alt } }, () => {
    const viewerUrl = chrome.runtime.getURL('src/ui/image_viewer.html') +
      '?key=' + encodeURIComponent(key);
    chrome.tabs.create({ url: viewerUrl }).catch(() => {
      // Fallback: open as popup window
      chrome.windows.create({ url: viewerUrl, type: 'popup', width: 1100, height: 800 });
    });
  });
}
