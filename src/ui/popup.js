/**
 * Popup UI Controller
 * Manages the popup interface and user interactions
 */

// State management
let currentArticles = [];
let currentSelectedArticle = null;
let storageChangeUnsubscribe = null;
let currentSettings = null;
let currentStepIndex = 0;
let articleCompletionStates = {}; // { articleId: { completedStepIndexes: [], completedAt?: string } }

// DOM Elements
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const settingsBtn = document.getElementById('settingsBtn');
const resultsPanel = document.getElementById('resultsPanel');
const resultsList = document.getElementById('resultsList');
const resultCount = document.getElementById('resultCount');
const viewerPanel = document.getElementById('viewerPanel');
const viewerContent = document.getElementById('viewerContent');
const articleTitle = document.getElementById('articleTitle');
const backBtn = document.getElementById('backBtn');
const refreshBtn = document.getElementById('refreshBtn');

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
  
  backBtn.addEventListener('click', () => {
    clearArticleView();
  });
  
  refreshBtn.addEventListener('click', async () => {
    await loadArticles();
    showNotification('Articles refreshed');
  });
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
  
  if (!query) {
    displayResults(currentArticles);
    return;
  }
  
  console.log('Searching for:', query);
  
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
  currentStepIndex = 0;
  
  // Update active state in results
  document.querySelectorAll('.result-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-article-id') === articleId) {
      item.classList.add('active');
    }
  });
  
  // Display article content
  articleTitle.textContent = article.title;
  
  // Check if article has steps
  const steps = article.steps && Array.isArray(article.steps) && article.steps.length > 0 
    ? article.steps 
    : [];
  
  // Handle edge case: article with 0 steps
  if (steps.length === 0) {
    viewerContent.innerHTML = `
      <div class="error-message">
        <h3>⚠️ No Steps Available</h3>
        <p>This article does not contain any step-by-step instructions.</p>
        <button class="primary-btn" onclick="clearArticleView()">← Back to Search</button>
      </div>
    `;
    return;
  }
  
  // Render step-by-step view
  renderStepView();
}

// Render the current step view
function renderStepView() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const steps = article.steps;
  const totalSteps = steps.length;
  const completionState = getCompletionState(article.id);
  const isCompleted = completionState.completedAt;
  
  // If all steps completed, show summary
  if (isCompleted && currentStepIndex >= totalSteps - 1) {
    renderCompletionSummary();
    return;
  }
  
  const currentStep = steps[currentStepIndex];
  const isStepCompleted = completionState.completedStepIndexes.includes(currentStepIndex);
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === totalSteps - 1;
  
  viewerContent.innerHTML = `
    <!-- Progress Bar -->
    <div class="progress-container">
      <div class="progress-info">
        <span class="progress-text">Step ${currentStepIndex + 1} of ${totalSteps}</span>
        <span class="progress-percentage">${Math.round(((currentStepIndex + 1) / totalSteps) * 100)}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${((currentStepIndex + 1) / totalSteps) * 100}%"></div>
      </div>
    </div>
    
    <!-- Current Step -->
    <div class="current-step">
      <div class="step-header">
        <h3 class="step-title">
          ${isStepCompleted ? '✓ ' : ''}${escapeHtml(currentStep.title)}
        </h3>
        ${isStepCompleted ? '<span class="step-completed-badge">Completed</span>' : ''}
      </div>
      
      <div class="step-content">
        ${sanitizeHtml(currentStep.bodyHtml)}
        
        ${currentStep.images && currentStep.images.length > 0 ? `
          <div class="step-images">
            ${currentStep.images.map(img => `
              <img 
                src="${escapeHtml(img.dataUrlOrRemoteUrl)}" 
                alt="${escapeHtml(img.alt || 'Step image')}"
                onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
              />
              <div class="image-alt-text" style="display: none;">
                📷 ${escapeHtml(img.alt || 'Image not available')}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>
    
    <!-- Navigation Buttons -->
    <div class="step-navigation">
      <button 
        class="nav-btn secondary-btn" 
        id="stepBackBtn" 
        ${isFirstStep ? 'disabled' : ''}
      >
        ← Back
      </button>
      
      <button 
        class="nav-btn primary-btn" 
        id="stepContinueBtn"
      >
        ${isLastStep ? 'Complete' : 'Continue →'}
      </button>
    </div>
    
    <!-- Action Buttons -->
    <div class="step-actions">
      <button class="action-btn" id="previewAllStepsBtn">📋 Preview all steps</button>
      <button class="action-btn" id="searchNewArticleBtn">🔍 Search for new article</button>
      ${completionState.completedStepIndexes.length > 0 ? `
        <button class="action-btn warning-btn" id="resetProgressBtn">🔄 Reset progress</button>
      ` : ''}
    </div>
  `;
  
  // Add event listeners
  const stepBackBtn = document.getElementById('stepBackBtn');
  const stepContinueBtn = document.getElementById('stepContinueBtn');
  const previewAllStepsBtn = document.getElementById('previewAllStepsBtn');
  const searchNewArticleBtn = document.getElementById('searchNewArticleBtn');
  const resetProgressBtn = document.getElementById('resetProgressBtn');
  
  if (stepBackBtn) {
    stepBackBtn.addEventListener('click', handleStepBack);
  }
  
  if (stepContinueBtn) {
    stepContinueBtn.addEventListener('click', handleStepContinue);
  }
  
  if (previewAllStepsBtn) {
    previewAllStepsBtn.addEventListener('click', showPreviewAllSteps);
  }
  
  if (searchNewArticleBtn) {
    searchNewArticleBtn.addEventListener('click', () => {
      clearArticleView();
      searchInput.focus();
    });
  }
  
  if (resetProgressBtn) {
    resetProgressBtn.addEventListener('click', handleResetProgress);
  }
}

// Handle step back navigation
function handleStepBack() {
  if (currentStepIndex > 0) {
    currentStepIndex--;
    renderStepView();
  }
}

// Handle step continue navigation
async function handleStepContinue() {
  const article = currentSelectedArticle;
  const totalSteps = article.steps.length;
  const isLastStep = currentStepIndex === totalSteps - 1;
  
  // Mark current step as completed
  await markStepCompleted(article.id, currentStepIndex);
  
  if (isLastStep) {
    // Mark article as completed
    await markArticleCompleted(article.id);
    renderCompletionSummary();
  } else {
    // Move to next step
    currentStepIndex++;
    renderStepView();
  }
}

// Render completion summary
function renderCompletionSummary() {
  const article = currentSelectedArticle;
  const steps = article.steps;
  const completionState = getCompletionState(article.id);
  
  viewerContent.innerHTML = `
    <div class="completion-summary">
      <div class="completion-icon">✅</div>
      <h2>Congratulations!</h2>
      <p>You've completed all steps for:</p>
      <h3>${escapeHtml(article.title)}</h3>
      
      <div class="completion-stats">
        <div class="stat">
          <span class="stat-value">${steps.length}</span>
          <span class="stat-label">Steps Completed</span>
        </div>
        ${article.estimatedMinutes ? `
          <div class="stat">
            <span class="stat-value">${article.estimatedMinutes}</span>
            <span class="stat-label">Minutes</span>
          </div>
        ` : ''}
        <div class="stat">
          <span class="stat-value">${new Date(completionState.completedAt).toLocaleDateString()}</span>
          <span class="stat-label">Completed On</span>
        </div>
      </div>
      
      <div class="completed-steps-list">
        <h4>Completed Steps:</h4>
        <ul>
          ${steps.map((step, index) => `
            <li>
              <span class="completed-check">✓</span>
              ${escapeHtml(step.title)}
            </li>
          `).join('')}
        </ul>
      </div>
      
      <div class="completion-actions">
        <button class="primary-btn" id="reviewStepsBtn">📋 Review Steps</button>
        <button class="secondary-btn" id="searchNewArticleBtn2">🔍 Search for new article</button>
        <button class="warning-btn" id="resetProgressBtn2">🔄 Reset progress</button>
      </div>
    </div>
  `;
  
  // Add event listeners
  const reviewStepsBtn = document.getElementById('reviewStepsBtn');
  const searchNewArticleBtn2 = document.getElementById('searchNewArticleBtn2');
  const resetProgressBtn2 = document.getElementById('resetProgressBtn2');
  
  if (reviewStepsBtn) {
    reviewStepsBtn.addEventListener('click', () => {
      currentStepIndex = 0;
      renderStepView();
    });
  }
  
  if (searchNewArticleBtn2) {
    searchNewArticleBtn2.addEventListener('click', () => {
      clearArticleView();
      searchInput.focus();
    });
  }
  
  if (resetProgressBtn2) {
    resetProgressBtn2.addEventListener('click', handleResetProgress);
  }
}

// Show preview all steps modal
function showPreviewAllSteps() {
  if (!currentSelectedArticle) return;
  
  const article = currentSelectedArticle;
  const steps = article.steps;
  const completionState = getCompletionState(article.id);
  
  // Create modal
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>All Steps Preview</h3>
        <button class="modal-close" id="closeModalBtn">✕</button>
      </div>
      <div class="modal-body">
        <div class="steps-preview-list">
          ${steps.map((step, index) => {
            const isCompleted = completionState.completedStepIndexes.includes(index);
            const isCurrent = index === currentStepIndex;
            return `
              <div class="preview-step-item ${isCurrent ? 'current' : ''}" data-step-index="${index}">
                <div class="preview-step-number">
                  ${isCompleted ? '✓' : index + 1}
                </div>
                <div class="preview-step-content">
                  <div class="preview-step-title">${escapeHtml(step.title)}</div>
                  ${isCurrent ? '<span class="current-badge">Current</span>' : ''}
                  ${isCompleted && !isCurrent ? '<span class="completed-badge-small">Completed</span>' : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Add event listeners
  const closeModalBtn = document.getElementById('closeModalBtn');
  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
      modal.remove();
    });
  }
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
  
  // Add click handlers to step items
  document.querySelectorAll('.preview-step-item').forEach(item => {
    item.addEventListener('click', () => {
      const stepIndex = parseInt(item.getAttribute('data-step-index'));
      currentStepIndex = stepIndex;
      modal.remove();
      renderStepView();
    });
  });
}

// Handle reset progress
async function handleResetProgress() {
  if (!currentSelectedArticle) return;
  
  const confirmed = confirm('Are you sure you want to reset your progress for this article?');
  if (confirmed) {
    await resetArticleProgress(currentSelectedArticle.id);
    currentStepIndex = 0;
    renderStepView();
  }
}

// Clear article view
function clearArticleView() {
  currentSelectedArticle = null;
  articleTitle.textContent = 'Select an article';
  viewerContent.innerHTML = `
    <div class="empty-state">
      <p>Select an article from the results to view its content</p>
    </div>
  `;
  
  document.querySelectorAll('.result-item').forEach(item => {
    item.classList.remove('active');
  });
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
