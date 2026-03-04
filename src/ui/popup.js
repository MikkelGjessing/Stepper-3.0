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
    return `
      <div class="result-item" data-article-id="${article.id}">
        <div class="result-item-title">${escapeHtml(article.title)}</div>
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
  
  // Render header: article title + progress bar only (no step counter text)
  articleHeader.innerHTML = `
    <h2 class="step-view-title">${escapeHtml(article.title)}</h2>
    <div class="progress-bar-container">
      <div class="progress-bar-fill" style="width: ${progressPercentage}%"></div>
    </div>
  `;
  
  // Extract pure title: strip "Step N:" prefix if present (added by the parser)
  let displayTitle = currentStep.title;
  const stepPrefixMatch = displayTitle.match(/^Step\s+\d+\s*:\s*/i);
  if (stepPrefixMatch) {
    displayTitle = displayTitle.slice(stepPrefixMatch[0].length);
  }

  // Render step content into the scrollable area
  articleContentScrollable.innerHTML = `
    <div class="step-view-content">
      <div class="step-label">STEP ${currentStepIndex + 1}</div>
      <h3 class="step-view-step-title">${escapeHtml(displayTitle)}</h3>
      <div class="step-view-step-body">
        ${sanitizeHtml(currentStep.bodyHtml)}
        
        ${currentStep.images && currentStep.images.length > 0 ? `
          <div class="step-images">
            ${currentStep.images.map(img => {
              const url = img.dataUrlOrRemoteUrl || '';
              const isValidUrl = url.startsWith('data:image/') || url.startsWith('https://') || url.startsWith('http://');
              
              if (!isValidUrl) {
                return `<div class="image-alt-text">📷 ${escapeHtml(img.alt || 'Invalid image URL')}</div>`;
              }
              
              return `
                <img 
                  src="${escapeHtml(url)}" 
                  alt="${escapeHtml(img.alt || 'Step image')}"
                  onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
                />
                <div class="image-alt-text" style="display: none;">
                  📷 ${escapeHtml(img.alt || 'Image not available')}
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
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
          
          ${step.images && step.images.length > 0 ? `
            <div class="step-images">
              ${step.images.map(img => {
                // Validate image URL - only allow data: URLs and https/http URLs
                const url = img.dataUrlOrRemoteUrl || '';
                const isValidUrl = url.startsWith('data:image/') || url.startsWith('https://') || url.startsWith('http://');
                
                if (!isValidUrl) {
                  return `<div class="image-alt-text">📷 ${escapeHtml(img.alt || 'Invalid image URL')}</div>`;
                }
                
                return `
                  <img 
                    src="${escapeHtml(url)}" 
                    alt="${escapeHtml(img.alt || 'Step image')}"
                    onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
                  />
                  <div class="image-alt-text" style="display: none;">
                    📷 ${escapeHtml(img.alt || 'Image not available')}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}
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
