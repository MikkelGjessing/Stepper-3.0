/**
 * Popup UI Controller
 * Manages the popup interface and user interactions
 */

// State management
let currentArticles = [];
let currentSelectedArticle = null;
let storageChangeUnsubscribe = null;
let currentSettings = null;

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
  
  // Update active state in results
  document.querySelectorAll('.result-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-article-id') === articleId) {
      item.classList.add('active');
    }
  });
  
  // Display article content
  articleTitle.textContent = article.title;
  
  // Use the structured steps from article
  const steps = article.steps && Array.isArray(article.steps) && article.steps.length > 0 
    ? article.steps 
    : [];
  
  viewerContent.innerHTML = `
    ${article.summary ? `
      <div class="article-summary">
        <p>${escapeHtml(article.summary)}</p>
      </div>
    ` : ''}
    
    <div class="article-meta">
      ${article.estimatedMinutes ? `
        <span>⏱ Estimated time: ${article.estimatedMinutes} minutes</span>
      ` : ''}
      <span>Steps: ${steps.length}</span>
      ${article.updatedAt ? `
        <span>Updated: ${new Date(article.updatedAt).toLocaleDateString()}</span>
      ` : ''}
    </div>
    
    ${steps.length > 0 ? `
      <div class="article-steps">
        ${steps.map(step => `
          <div class="step-item">
            <div class="step-number">Step ${step.index}: ${escapeHtml(step.title)}</div>
            <div class="step-body">
              ${sanitizeHtml(step.bodyHtml)}
            </div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="article-content">
        <p>This article does not contain step-by-step instructions.</p>
      </div>
    `}
  `;
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
