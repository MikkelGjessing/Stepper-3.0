/**
 * Service Worker for Stepper 3.0
 * Handles background tasks and initialization
 */

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
      llmApiKey: ''
    };
    
    await chrome.storage.local.set({ settings: defaultSettings });
    console.log('Default settings initialized');
  }
  
  // Initialize articles array if not present
  const { articles } = await chrome.storage.local.get('articles');
  if (!articles) {
    await chrome.storage.local.set({ articles: [] });
    console.log('Articles array initialized');
  }
});

// Handle messages from popup/options
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Service worker received message:', message);
  
  switch (message.type) {
    case 'ping':
      sendResponse({ status: 'alive' });
      break;
    case 'refreshArticles':
      // TODO: Implement article refresh logic
      console.log('Article refresh requested');
      sendResponse({ status: 'success', message: 'Refresh initiated' });
      break;
    case 'SYNC_REPO':
      handleSyncRepo(message.settings)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ 
          success: false, 
          message: `Sync failed: ${error.message}` 
        }));
      return true; // Keep message channel open for async response
    default:
      sendResponse({ status: 'unknown', message: 'Unknown message type' });
  }
  
  return true; // Keep message channel open for async responses
});

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
