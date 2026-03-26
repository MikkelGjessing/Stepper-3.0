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

// Case State Machine
const CASE_STATE = {
  NOT_STARTED: 'not_started',
  ACTIVE: 'active'
};

let currentUIState = UI_STATE.SEARCH;
let currentStepIndex = 0; // Track current step in step-by-step mode

// Case state
let caseState = CASE_STATE.NOT_STARTED;
let activeCase = null; // { startedAt, completedInstructions: [{articleId, articleTitle, completedAt, order}] }
let caseStartText = ''; // Loaded from config/case_start_text.md

// State management
let currentArticles = [];
let currentSelectedArticle = null;
let storageChangeUnsubscribe = null;
let currentSettings = null;
let articleCompletionStates = {}; // { articleId: { completedStepIndexes: [], completedAt?: string } }
let hasSearched = false; // Track if user has performed a search

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const settingsBtn = document.getElementById('settingsBtn');
const resultsList = document.getElementById('resultsList');
const resultCount = document.getElementById('resultCount');
const mainFooter = document.getElementById('mainFooter');
const welcomeMessage = document.getElementById('welcomeMessage');
const resultsContent = document.getElementById('resultsContent');

// View containers
const searchView = document.getElementById('searchView');
const articleView = document.getElementById('articleView');
const fullArticleView = document.getElementById('fullArticleView');
const completeView = document.getElementById('completeView');
const caseNotStartedView = document.getElementById('caseNotStartedView');

// Case Active DOM elements (inside searchView)
const caseActiveOverview = document.getElementById('caseActiveOverview');
const completedInstructionsList = document.getElementById('completedInstructionsList');

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup loaded');
  
  // Load settings first
  await loadSettings();
  
  // Load completion states
  await loadCompletionStates();

  // Load case state and config text
  await loadCaseState();
  await loadCaseStartText();
  
  // Load dummy articles if needed
  await Articles.loadDummyArticlesIfNeeded();
  
  // Load articles
  await loadArticles();
  
  // Setup event listeners
  setupEventListeners();
  
  // Subscribe to storage changes
  setupStorageListener();

  // Initialise the chat drawer (requires settings to be loaded)
  initChatDrawer();

  // Show appropriate view based on case state
  applyCaseState();
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

  // Case workflow event listeners
  const startCaseBtn = document.getElementById('startCaseBtn');
  if (startCaseBtn) startCaseBtn.addEventListener('click', handleStartCase);

  const caseStartCancelBtn = document.getElementById('caseStartCancelBtn');
  if (caseStartCancelBtn) caseStartCancelBtn.addEventListener('click', handleCancelStartCase);

  const caseStartConfirmBtn = document.getElementById('caseStartConfirmBtn');
  if (caseStartConfirmBtn) caseStartConfirmBtn.addEventListener('click', handleConfirmStartCase);

  const concludeCaseBtn = document.getElementById('concludeCaseBtn');
  if (concludeCaseBtn) concludeCaseBtn.addEventListener('click', handleConcludeCase);

  const caseCopySummaryBtn = document.getElementById('caseCopySummaryBtn');
  if (caseCopySummaryBtn) caseCopySummaryBtn.addEventListener('click', handleCopyCaseSummary);

  const caseConcludeCloseBtn = document.getElementById('caseConcludeCloseBtn');
  if (caseConcludeCloseBtn) caseConcludeCloseBtn.addEventListener('click', handleCloseConcludeCase);

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

// ═══════════════════════════════════════════════════
// CASE WORKFLOW
// ═══════════════════════════════════════════════════

/**
 * Load case state from chrome.storage.local
 */
async function loadCaseState() {
  try {
    const result = await chrome.storage.local.get('activeCase');
    if (result.activeCase) {
      activeCase = result.activeCase;
      caseState = CASE_STATE.ACTIVE;
    } else {
      activeCase = null;
      caseState = CASE_STATE.NOT_STARTED;
    }
  } catch (error) {
    console.error('Error loading case state:', error);
    activeCase = null;
    caseState = CASE_STATE.NOT_STARTED;
  }
}

/**
 * Save current case state to chrome.storage.local
 */
async function saveCaseState() {
  try {
    if (activeCase) {
      await chrome.storage.local.set({ activeCase });
    } else {
      await chrome.storage.local.remove('activeCase');
    }
  } catch (error) {
    console.error('Error saving case state:', error);
  }
}

/**
 * Load the configurable case-start text from config/case_start_text.md
 */
async function loadCaseStartText() {
  try {
    const url = chrome.runtime.getURL('config/case_start_text.md');
    const response = await fetch(url);
    if (response.ok) {
      const text = await response.text();
      caseStartText = text.trim();
    }
  } catch (error) {
    console.error('Error loading case start text:', error);
    caseStartText = 'Please confirm you are ready to begin the case.';
  }
}

/**
 * Convert a simple markdown string to safe HTML.
 * Supports: paragraphs, unordered lists (- or *), basic bold/italic.
 * @param {string} md
 * @returns {string} HTML string
 */
function simpleMarkdownToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const parts = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const listMatch = line.match(/^[-*]\s+(.*)/);
    if (listMatch) {
      if (!inList) { parts.push('<ul>'); inList = true; }
      parts.push('<li>' + escapeHtmlInline(listMatch[1]) + '</li>');
    } else {
      if (inList) { parts.push('</ul>'); inList = false; }
      if (line.trim() === '') {
        // blank line separates paragraphs – no extra element needed
      } else {
        parts.push('<p>' + escapeHtmlInline(line.trim()) + '</p>');
      }
    }
  }
  if (inList) parts.push('</ul>');
  return parts.join('');
}

/**
 * Escape HTML in inline text while preserving simple **bold** and *italic* markdown.
 */
function escapeHtmlInline(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

/**
 * Apply the current case state to the UI.
 * Shows the correct top-level view.
 */
function applyCaseState() {
  if (caseState === CASE_STATE.NOT_STARTED) {
    // Hide search view, show case-not-started view
    if (searchView) searchView.style.display = 'none';
    if (articleView) articleView.style.display = 'none';
    if (fullArticleView) fullArticleView.style.display = 'none';
    if (completeView) completeView.style.display = 'none';
    if (caseNotStartedView) caseNotStartedView.style.display = 'flex';
    if (caseActiveOverview) caseActiveOverview.style.display = 'none';
  } else if (caseState === CASE_STATE.ACTIVE) {
    // Hide case-not-started, show search view
    if (caseNotStartedView) caseNotStartedView.style.display = 'none';
    setView(UI_STATE.SEARCH);
    renderCaseActiveOverview();
    if (caseActiveOverview) caseActiveOverview.style.display = 'flex';
  }
}

/**
 * Render the completed instructions list inside the case active overview.
 */
function renderCaseActiveOverview() {
  if (!completedInstructionsList || !activeCase) return;

  const instructions = activeCase.completedInstructions || [];
  if (instructions.length === 0) {
    completedInstructionsList.innerHTML = '<p class="case-empty-state">No completed instructions yet.</p>';
    return;
  }

  const sorted = [...instructions].sort((a, b) => a.order - b.order);
  completedInstructionsList.innerHTML = sorted.map(item => `
    <div class="completed-instruction-card">
      <span class="completed-instruction-order">${item.order}</span>
      <span class="completed-instruction-title">${escapeHtml(item.articleTitle || 'Untitled')}</span>
    </div>
  `).join('');
}

/**
 * Handle "Start case" button click – show the start-case modal.
 */
function handleStartCase() {
  const modal = document.getElementById('caseStartModal');
  const body = document.getElementById('caseStartModalBody');
  if (!modal || !body) return;

  body.innerHTML = simpleMarkdownToHtml(caseStartText);
  modal.style.display = 'flex';
}

/**
 * Handle Cancel in the start-case modal.
 */
function handleCancelStartCase() {
  const modal = document.getElementById('caseStartModal');
  if (modal) modal.style.display = 'none';
}

/**
 * Handle Confirm in the start-case modal – activate the case.
 */
async function handleConfirmStartCase() {
  const modal = document.getElementById('caseStartModal');
  if (modal) modal.style.display = 'none';

  activeCase = {
    startedAt: new Date().toISOString(),
    completedInstructions: []
  };
  caseState = CASE_STATE.ACTIVE;
  await saveCaseState();

  applyCaseState();
  if (searchInput) searchInput.focus();
}

/**
 * Handle "Conclude case" button – show the conclusion modal with the summary.
 */
function handleConcludeCase() {
  const modal = document.getElementById('caseConcludeModal');
  const body = document.getElementById('caseConcludeModalBody');
  if (!modal || !body) return;

  const instructions = (activeCase && activeCase.completedInstructions) ? activeCase.completedInstructions : [];
  const summaryText = generateCaseSummary(instructions);

  body.innerHTML = `
    <div class="conclude-instructions-list">
      ${instructions.length === 0
        ? '<p class="case-empty-state">No instructions were completed during this case.</p>'
        : [...instructions].sort((a, b) => a.order - b.order).map(item => `
            <div class="concluded-instruction-item">
              <span class="concluded-instruction-order">${item.order}.</span>
              <span class="concluded-instruction-title">${escapeHtml(item.articleTitle || 'Untitled')}</span>
            </div>`).join('')
      }
    </div>
    <div class="conclude-summary-block">
      <label class="conclude-summary-label">CRM log text</label>
      <pre class="conclude-summary-text" id="caseSummaryText">${escapeHtml(summaryText)}</pre>
    </div>
  `;

  // Store summary text for copy
  modal.dataset.summaryText = summaryText;
  modal.style.display = 'flex';
}

/**
 * Handle copying the CRM summary text to clipboard.
 */
async function handleCopyCaseSummary() {
  const modal = document.getElementById('caseConcludeModal');
  const summaryText = modal ? modal.dataset.summaryText : '';
  if (!summaryText) return;

  try {
    await navigator.clipboard.writeText(summaryText);
    const btn = document.getElementById('caseCopySummaryBtn');
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  } catch (err) {
    console.error('Failed to copy summary:', err);
  }
}

/**
 * Handle "Close case" in the conclude modal – reset state and return to NOT_STARTED.
 */
async function handleCloseConcludeCase() {
  const modal = document.getElementById('caseConcludeModal');
  if (modal) modal.style.display = 'none';

  // Clear case state
  activeCase = null;
  caseState = CASE_STATE.NOT_STARTED;
  await saveCaseState();

  // Reset search state so the next case starts fresh
  hasSearched = false;
  currentSelectedArticle = null;
  currentStepIndex = 0;

  applyCaseState();
}

/**
 * Add a completed instruction to the active case record.
 * @param {string} articleId
 * @param {string} articleTitle
 */
async function addCompletedInstructionToCase(articleId, articleTitle) {
  if (!activeCase || caseState !== CASE_STATE.ACTIVE) return;

  const order = (activeCase.completedInstructions.length) + 1;
  activeCase.completedInstructions.push({
    articleId,
    articleTitle: articleTitle || 'Untitled',
    completedAt: new Date().toISOString(),
    order
  });
  await saveCaseState();
}

/**
 * View State Machine - Controls which view is visible
 */
function setView(state) {
  console.log('Setting view to:', state);
  currentUIState = state;
  
  // Hide all views
  if (caseNotStartedView) caseNotStartedView.style.display = 'none';
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
      // Show case active overview if case is active
      if (caseActiveOverview) {
        caseActiveOverview.style.display = caseState === CASE_STATE.ACTIVE ? 'flex' : 'none';
      }
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
      applyChatSettings();
    }
    
    // React to articles changes
    if (changes.articles) {
      console.log('Articles changed, refreshing display');
      await loadArticles();
    }
  });
}

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
 * Marks the last step as completed, sets completedAt timestamp.
 * If a case is active, adds the instruction to the case record and returns to search view.
 * Otherwise shows the article-level completion summary.
 */
async function handleCompleteProcess() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  
  // Mark the last step as completed (if not already)
  await markStepCompleted(article.id, currentStepIndex);
  
  // Mark article as completed with timestamp
  await markArticleCompleted(article.id);

  // If a case is active, record this instruction in the case and return to search
  if (caseState === CASE_STATE.ACTIVE) {
    await addCompletedInstructionToCase(article.id, article.title);
    // Return to search/case view and refresh the completed instructions list
    setView(UI_STATE.SEARCH);
    renderCaseActiveOverview();
    if (searchInput) searchInput.focus();
    return;
  }
  
  // No active case – show the article-level completion summary as before
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

// ═══════════════════════════════════════════════════
// CHAT DRAWER
// ═══════════════════════════════════════════════════

const CHAT_DRAWER_STATE = {
  CLOSED: 'closed',
  OPEN_MEDIUM: 'open_medium',
  OPEN_EXPANDED: 'open_expanded'
};

// Animation duration must match the CSS transition in .chat-drawer (0.3s)
const CHAT_DRAWER_ANIMATION_MS = 300;
// Maximum chat input auto-grow height in px (matches CSS max-height on .chat-input)
const CHAT_INPUT_MAX_HEIGHT_PX = 80;
// Number of recent history turns sent to the backend for context
const MAX_CHAT_HISTORY_TURNS = 10;

let chatDrawerState = CHAT_DRAWER_STATE.CLOSED;
let chatMode = 'kb'; // 'kb' | 'current_article'
let chatHistory = []; // { role: 'user'|'assistant'|'system', content: string, sources?: [] }
let chatIsLoading = false;

// DOM references (resolved after DOMContentLoaded)
let chatDrawerEl = null;
let chatTriggerBtn = null;
let chatDrawerCloseBtn = null;
let chatDrawerResizeBtn = null;
let chatModeSwitch = null;
let chatContextLabel = null;
let chatMessagesEl = null;
let chatInputEl = null;
let chatSendBtn = null;

/**
 * Initialise the chat drawer after DOM is ready and settings are loaded.
 * Called from the existing DOMContentLoaded handler.
 */
function initChatDrawer() {
  chatDrawerEl        = document.getElementById('chatDrawer');
  chatTriggerBtn      = document.getElementById('chatTriggerBtn');
  chatDrawerCloseBtn  = document.getElementById('chatDrawerClose');
  chatDrawerResizeBtn = document.getElementById('chatDrawerResize');
  chatModeSwitch      = document.getElementById('chatModeSwitch');
  chatContextLabel    = document.getElementById('chatContextLabel');
  chatMessagesEl      = document.getElementById('chatMessages');
  chatInputEl         = document.getElementById('chatInput');
  chatSendBtn         = document.getElementById('chatSendBtn');

  if (!chatDrawerEl) return;

  // Show/hide trigger based on settings
  applyChatSettings();

  // Event listeners
  chatTriggerBtn.addEventListener('click', toggleChatDrawer);
  chatDrawerCloseBtn.addEventListener('click', closeChatDrawer);
  chatDrawerResizeBtn.addEventListener('click', cycleChatDrawerSize);
  chatModeSwitch.addEventListener('click', toggleChatMode);
  chatSendBtn.addEventListener('click', handleChatSend);
  chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  });
  // Auto-grow textarea
  chatInputEl.addEventListener('input', () => {
    chatInputEl.style.height = 'auto';
    chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX) + 'px';
  });
}

/**
 * Apply current settings to show/hide the trigger and configure allowed modes.
 */
function applyChatSettings() {
  if (!chatTriggerBtn) return;
  const settings = currentSettings || {};
  if (settings.enableChat) {
    chatTriggerBtn.style.display = 'flex';
    if (mainFooter) mainFooter.style.display = 'flex';
  } else {
    chatTriggerBtn.style.display = 'none';
    if (mainFooter) mainFooter.style.display = 'none';
    // Also close drawer if settings were changed while it was open
    if (chatDrawerState !== CHAT_DRAWER_STATE.CLOSED) {
      closeChatDrawer();
    }
  }
}

/**
 * Determine the appropriate default chat mode based on current UI state.
 * If an article is open and allowCurrentArticleChat is enabled, use 'current_article'.
 * Otherwise default to 'kb'.
 */
function resolveChatMode() {
  const settings = currentSettings || {};
  const articleOpen = (currentUIState === UI_STATE.ARTICLE ||
                       currentUIState === UI_STATE.FULL_ARTICLE) &&
                      currentSelectedArticle !== null;

  if (articleOpen && settings.allowCurrentArticleChat !== false) {
    return 'current_article';
  }
  return 'kb';
}

/**
 * Update the context label and mode-switch button to reflect current chatMode.
 */
function updateChatContextUI() {
  if (!chatContextLabel || !chatModeSwitch) return;
  const settings = currentSettings || {};

  // Determine whether the alternative mode is available
  const articleOpen = (currentUIState === UI_STATE.ARTICLE ||
                       currentUIState === UI_STATE.FULL_ARTICLE) &&
                      currentSelectedArticle !== null;

  const canSwitchToArticle = articleOpen && settings.allowCurrentArticleChat !== false;
  const canSwitchToKb      = settings.allowKnowledgeBaseChat !== false;

  if (chatMode === 'current_article') {
    const articleTitle = currentSelectedArticle
      ? currentSelectedArticle.title || 'current guide'
      : 'current guide';
    chatContextLabel.textContent = `Asking about: ${articleTitle}`;
    if (canSwitchToKb) {
      chatModeSwitch.textContent = '→ Ask knowledge base';
      chatModeSwitch.style.display = 'inline-block';
    } else {
      chatModeSwitch.style.display = 'none';
    }
  } else {
    chatContextLabel.textContent = 'Asking Stepper knowledge base';
    if (canSwitchToArticle) {
      chatModeSwitch.textContent = '→ Ask about current guide';
      chatModeSwitch.style.display = 'inline-block';
    } else {
      chatModeSwitch.style.display = 'none';
    }
  }
}

// ── Drawer state helpers ────────────────────────────

function openChatDrawer() {
  if (!chatDrawerEl) return;
  chatMode = resolveChatMode();
  chatDrawerState = CHAT_DRAWER_STATE.OPEN_MEDIUM;
  chatDrawerEl.classList.remove('drawer-expanded');
  chatDrawerEl.classList.add('drawer-medium');
  chatDrawerEl.setAttribute('aria-hidden', 'false');
  updateChatContextUI();
  if (chatMessagesEl && chatMessagesEl.children.length === 0) {
    renderWelcomeMessage();
  }
  // Focus input
  setTimeout(() => chatInputEl && chatInputEl.focus(), CHAT_DRAWER_ANIMATION_MS);
}

function closeChatDrawer() {
  if (!chatDrawerEl) return;
  chatDrawerState = CHAT_DRAWER_STATE.CLOSED;
  chatDrawerEl.classList.remove('drawer-medium', 'drawer-expanded');
  chatDrawerEl.setAttribute('aria-hidden', 'true');
}

function toggleChatDrawer() {
  if (chatDrawerState === CHAT_DRAWER_STATE.CLOSED) {
    openChatDrawer();
  } else {
    closeChatDrawer();
  }
}

function cycleChatDrawerSize() {
  if (!chatDrawerEl) return;
  if (chatDrawerState === CHAT_DRAWER_STATE.OPEN_MEDIUM) {
    chatDrawerState = CHAT_DRAWER_STATE.OPEN_EXPANDED;
    chatDrawerEl.classList.remove('drawer-medium');
    chatDrawerEl.classList.add('drawer-expanded');
  } else {
    chatDrawerState = CHAT_DRAWER_STATE.OPEN_MEDIUM;
    chatDrawerEl.classList.remove('drawer-expanded');
    chatDrawerEl.classList.add('drawer-medium');
  }
}

function toggleChatMode() {
  chatMode = (chatMode === 'kb') ? 'current_article' : 'kb';
  updateChatContextUI();
}

function setChatContext(mode) {
  chatMode = (mode === 'current_article') ? 'current_article' : 'kb';
  updateChatContextUI();
}

// ── Rendering ────────────────────────────────────────

function renderWelcomeMessage() {
  if (!chatMessagesEl) return;
  const settings = currentSettings || {};
  if (!settings.chatBackendUrl) {
    appendChatMessage('system', '💬 Chat is not enabled yet. Configure a chat backend URL in Settings to get started.');
  } else {
    appendChatMessage('system', '👋 Hi! Ask me anything about the guides or the knowledge base.');
  }
}

/**
 * Append a message bubble to the chat messages area.
 * @param {'user'|'assistant'|'system'} role
 * @param {string} text - Plain text or simple HTML (assistant only)
 * @param {Array<{id:string, title:string}>} [sources]
 */
function appendChatMessage(role, text, sources) {
  if (!chatMessagesEl) return;
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;

  if (role === 'assistant') {
    msg.innerHTML = sanitizeHtml(text);
    if (sources && sources.length > 0) {
      const sourcesDiv = document.createElement('div');
      sourcesDiv.style.marginTop = '8px';
      sources.forEach(src => {
        const btn = document.createElement('button');
        btn.className = 'chat-source-btn';
        btn.textContent = '📄 ' + escapeHtml(src.title || src.id);
        btn.addEventListener('click', () => {
          closeChatDrawer();
          displayArticle(src.id);
        });
        sourcesDiv.appendChild(btn);
      });
      msg.appendChild(sourcesDiv);
    }
  } else {
    msg.textContent = text;
  }

  chatMessagesEl.appendChild(msg);
  chatHistory.push({ role, content: text });
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function showChatLoading() {
  if (!chatMessagesEl) return;
  const el = document.createElement('div');
  el.className = 'chat-loading';
  el.id = 'chatLoadingIndicator';
  el.textContent = 'Thinking';
  chatMessagesEl.appendChild(el);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function hideChatLoading() {
  const el = document.getElementById('chatLoadingIndicator');
  if (el) el.remove();
}

// ── Sending ──────────────────────────────────────────

async function handleChatSend() {
  if (!chatInputEl || chatIsLoading) return;
  const text = chatInputEl.value.trim();
  if (!text) return;

  chatInputEl.value = '';
  chatInputEl.style.height = 'auto';

  appendChatMessage('user', text);

  chatIsLoading = true;
  if (chatSendBtn) chatSendBtn.disabled = true;

  showChatLoading();
  try {
    const result = await sendChatMessage({
      message: text,
      mode: chatMode,
      currentArticleId: (chatMode === 'current_article' && currentSelectedArticle)
        ? currentSelectedArticle.id
        : null
    });
    hideChatLoading();
    appendChatMessage('assistant', result.answer || 'No response received.', result.sources);
  } catch (err) {
    hideChatLoading();
    appendChatMessage('system', '⚠️ ' + (err.message || 'Something went wrong. Please try again.'));
  } finally {
    chatIsLoading = false;
    if (chatSendBtn) chatSendBtn.disabled = false;
    chatInputEl.focus();
  }
}

/**
 * Send a chat message to the configured backend.
 * @param {{ message: string, mode: string, currentArticleId: string|null }} params
 * @returns {Promise<{ answer: string, sources?: Array<{id:string,title:string}> }>}
 */
async function sendChatMessage({ message, mode, currentArticleId }) {
  const settings = currentSettings || {};
  const backendUrl = settings.chatBackendUrl || '';

  if (!backendUrl) {
    throw new Error('Chat is not enabled yet. Configure a chat backend URL in Settings.');
  }

  const payload = { message, mode };
  if (currentArticleId) {
    payload.currentArticleId = currentArticleId;
  }
  // Include recent conversation history (last 10 turns)
  payload.history = chatHistory.slice(-MAX_CHAT_HISTORY_TURNS).map(h => ({ role: h.role, content: h.content }));

  const response = await fetch(backendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Chat backend returned ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}
