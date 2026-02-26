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
    default:
      sendResponse({ status: 'unknown', message: 'Unknown message type' });
  }
  
  return true; // Keep message channel open for async responses
});

// Log service worker lifecycle
console.log('Stepper 3.0 service worker loaded');
