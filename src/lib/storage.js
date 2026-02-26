/**
 * Storage wrapper around chrome.storage.local
 * Provides defensive access to extension storage
 */

const Storage = {
  /**
   * Get settings from storage
   * @returns {Promise<Object>} Settings object
   */
  async getSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return settings || {
        repoSourceType: 'url',
        repoUrl: '',
        azureApiBaseUrl: '',
        azurePat: '',
        enableDummyArticles: true,
        enableLLMSearch: false,
        llmEndpoint: '',
        llmApiKey: ''
      };
    } catch (error) {
      console.error('Error getting settings:', error);
      return {
        repoSourceType: 'url',
        repoUrl: '',
        azureApiBaseUrl: '',
        azurePat: '',
        enableDummyArticles: true,
        enableLLMSearch: false,
        llmEndpoint: '',
        llmApiKey: ''
      };
    }
  },

  /**
   * Save settings to storage
   * @param {Object} settings - Settings object to save
   * @returns {Promise<boolean>} Success status
   */
  async setSettings(settings) {
    try {
      await chrome.storage.local.set({ settings });
      return true;
    } catch (error) {
      console.error('Error saving settings:', error);
      return false;
    }
  },

  /**
   * Get articles from storage
   * @returns {Promise<Array>} Array of article objects
   */
  async getArticles() {
    try {
      const { articles } = await chrome.storage.local.get('articles');
      return Array.isArray(articles) ? articles : [];
    } catch (error) {
      console.error('Error getting articles:', error);
      return [];
    }
  },

  /**
   * Save articles to storage
   * @param {Array} articles - Array of article objects
   * @returns {Promise<boolean>} Success status
   */
  async setArticles(articles) {
    try {
      if (!Array.isArray(articles)) {
        console.error('Articles must be an array');
        return false;
      }
      await chrome.storage.local.set({ articles });
      return true;
    } catch (error) {
      console.error('Error saving articles:', error);
      return false;
    }
  },

  /**
   * Clear all storage (for testing/reset)
   * @returns {Promise<boolean>} Success status
   */
  async clearAll() {
    try {
      await chrome.storage.local.clear();
      return true;
    } catch (error) {
      console.error('Error clearing storage:', error);
      return false;
    }
  },

  /**
   * Get storage usage
   * @returns {Promise<Object>} Usage information
   */
  async getUsage() {
    try {
      const bytesInUse = await chrome.storage.local.getBytesInUse();
      return {
        bytesInUse,
        quotaBytes: chrome.storage.local.QUOTA_BYTES
      };
    } catch (error) {
      console.error('Error getting storage usage:', error);
      return { bytesInUse: 0, quotaBytes: 0 };
    }
  }
};

// Make it available globally for use in popup and options pages
if (typeof window !== 'undefined') {
  window.Storage = Storage;
}
