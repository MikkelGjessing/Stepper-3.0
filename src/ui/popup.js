/**
 * Popup UI Controller
 * Manages the popup interface and user interactions
 */

// UI State Machine
const UI_STATE = {
  SEARCH: 'search',
  ARTICLE: 'article'
};

let currentUIState = UI_STATE.SEARCH;

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
  
  // Show the requested view
  switch (state) {
    case UI_STATE.SEARCH:
      searchView.style.display = 'flex';
      // Clear article state
      currentSelectedArticle = null;
      // Show/hide welcome message based on hasSearched
      updateSearchViewVisibility();
      break;
      
    case UI_STATE.ARTICLE:
      articleView.style.display = 'flex';
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
  
  // Switch to article view and render full article
  setView(UI_STATE.ARTICLE);
  renderFullArticleView();
}

/**
 * Helper function to check if all steps in an article are completed
 */
function areAllStepsCompleted(completionState, totalSteps) {
  return completionState.completedStepIndexes.length === totalSteps;
}

// Render the full article view with all steps
function renderFullArticleView() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const steps = article.steps;
  const totalSteps = steps.length;
  const completionState = getCompletionState(article.id);
  const isArticleCompleted = completionState.completedAt && areAllStepsCompleted(completionState, totalSteps);
  
  const articleContentScrollable = document.getElementById('articleContentScrollable');
  
  // Build the article header
  let headerHtml = `
    <div class="article-header">
      <h2>${escapeHtml(article.title)}</h2>
      ${article.summary ? `<p style="color: #666; margin-top: 8px;">${escapeHtml(article.summary)}</p>` : ''}
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
    <div class="article-navigation">
      <button class="secondary-btn" id="backToSearchBtn">← Back to Search</button>
      ${completionState.completedStepIndexes.length > 0 ? `
        <button class="warning-btn" id="resetProgressBtn">🔄 Reset Progress</button>
      ` : ''}
    </div>
  `;
  
  // Render all steps
  let stepsHtml = '<div class="article-steps-list">';
  
  steps.forEach((step, index) => {
    const isStepCompleted = completionState.completedStepIndexes.includes(index);
    
    stepsHtml += `
      <div class="full-article-step ${isStepCompleted ? 'completed' : ''}" data-step-index="${index}">
        <div class="full-article-step-header">
          <div class="full-article-step-title-row">
            <div class="full-article-step-number">${isStepCompleted ? '✓' : index + 1}</div>
            <h3 class="full-article-step-title">${escapeHtml(step.title)}</h3>
          </div>
          <input 
            type="checkbox" 
            class="step-complete-checkbox" 
            ${isStepCompleted ? 'checked' : ''}
            data-step-index="${index}"
            title="${isStepCompleted ? 'Mark as incomplete' : 'Mark as complete'}"
          />
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
  articleContentScrollable.innerHTML = headerHtml + stepsHtml;
  
  // Add event listeners for navigation buttons
  const backToSearchBtn = document.getElementById('backToSearchBtn');
  if (backToSearchBtn) {
    backToSearchBtn.addEventListener('click', () => {
      setView(UI_STATE.SEARCH);
      searchInput.focus();
    });
  }
  
  const resetProgressBtn = document.getElementById('resetProgressBtn');
  if (resetProgressBtn) {
    resetProgressBtn.addEventListener('click', handleResetProgress);
  }
  
  // Add event listeners for checkboxes
  document.querySelectorAll('.step-complete-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', async (e) => {
      const stepIndex = parseInt(e.target.getAttribute('data-step-index'), 10);
      await handleStepCheckboxChange(stepIndex, e.target.checked);
    });
  });
}

// Handle step checkbox change
async function handleStepCheckboxChange(stepIndex, isChecked) {
  const article = currentSelectedArticle;
  
  if (isChecked) {
    // Mark step as completed
    await markStepCompleted(article.id, stepIndex);
  } else {
    // Mark step as incomplete
    await markStepIncomplete(article.id, stepIndex);
  }
  
  // Check if all steps are completed
  const completionState = getCompletionState(article.id);
  const totalSteps = article.steps.length;
  
  if (areAllStepsCompleted(completionState, totalSteps) && !completionState.completedAt) {
    // Mark article as completed
    await markArticleCompleted(article.id);
  } else if (!areAllStepsCompleted(completionState, totalSteps) && completionState.completedAt) {
    // Remove article completion if user unchecks a step
    await removeArticleCompletion(article.id);
  }
  
  // Re-render the view to update UI
  renderFullArticleView();
}

// Mark a step as incomplete
async function markStepIncomplete(articleId, stepIndex) {
  if (!articleCompletionStates[articleId]) {
    return;
  }
  
  const state = articleCompletionStates[articleId];
  state.completedStepIndexes = state.completedStepIndexes.filter(idx => idx !== stepIndex);
  
  await saveCompletionStates();
}

// Remove article completion status
async function removeArticleCompletion(articleId) {
  if (!articleCompletionStates[articleId]) {
    return;
  }
  
  delete articleCompletionStates[articleId].completedAt;
  await saveCompletionStates();
}

// Handle reset progress
async function handleResetProgress() {
  if (!currentSelectedArticle) return;
  
  const confirmed = confirm('Are you sure you want to reset your progress for this article?');
  if (confirmed) {
    await resetArticleProgress(currentSelectedArticle.id);
    renderFullArticleView();
  }
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
