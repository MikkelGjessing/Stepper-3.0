/**
 * Popup UI Controller
 * Manages the popup interface and user interactions
 */

// State management
let currentArticles = [];
let currentSelectedArticle = null;

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
const addDummyBtn = document.getElementById('addDummyBtn');

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Popup loaded');
  await loadArticles();
  setupEventListeners();
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
  
  addDummyBtn.addEventListener('click', async () => {
    await addDummyArticles();
  });
}

// Load articles from storage
async function loadArticles() {
  try {
    currentArticles = await Storage.getArticles();
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
  const results = Search.search(query, currentArticles);
  displayResults(results);
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
  
  resultsList.innerHTML = articles.map(article => `
    <div class="result-item" data-article-id="${article.id}">
      <div class="result-item-title">${escapeHtml(article.title)}</div>
      <div class="result-item-category">${escapeHtml(article.category || 'General')}</div>
      ${article.tags && article.tags.length > 0 ? `
        <div class="result-item-tags">
          ${article.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
  
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
  
  // Parse steps if not already parsed
  const steps = article.steps && article.steps.length > 0 
    ? article.steps 
    : Articles.parseSteps(article.content);
  
  viewerContent.innerHTML = `
    <div class="article-meta">
      <span class="article-category">${escapeHtml(article.category || 'General')}</span>
      ${article.metadata ? `
        <span>Updated: ${new Date(article.metadata.updatedAt).toLocaleDateString()}</span>
      ` : ''}
    </div>
    
    ${steps.length > 0 ? `
      <div class="article-steps">
        ${steps.map(step => `
          <div class="step-item">
            <div class="step-number">Step ${step.number}: ${escapeHtml(step.title)}</div>
            ${step.details && step.details.length > 0 ? `
              <div class="step-details">
                ${step.details.map(detail => `<p>${escapeHtml(detail)}</p>`).join('')}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="article-content">
        ${escapeHtml(article.content).split('\n').map(line => `<p>${line}</p>`).join('')}
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

// Add dummy articles
async function addDummyArticles() {
  try {
    const settings = await Storage.getSettings();
    
    if (!settings.enableDummyArticles) {
      showNotification('Dummy articles are disabled in settings');
      return;
    }
    
    const created = await Articles.createDummyArticles();
    console.log('Created dummy articles:', created.length);
    
    await loadArticles();
    showNotification(`Added ${created.length} demo articles`);
  } catch (error) {
    console.error('Error adding dummy articles:', error);
    showError('Failed to add demo articles');
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
