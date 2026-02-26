/**
 * Options Page Controller
 * Manages settings UI and persistence
 */

// DOM Elements
const settingsForm = document.getElementById('settingsForm');
const sourceTypeUrl = document.getElementById('sourceTypeUrl');
const sourceTypeAzure = document.getElementById('sourceTypeAzure');
const urlGroup = document.getElementById('urlGroup');
const azureGroup = document.getElementById('azureGroup');
const azurePatGroup = document.getElementById('azurePatGroup');
const llmSection = document.getElementById('llmSection');
const statusMessage = document.getElementById('statusMessage');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');
const clearStorageBtn = document.getElementById('clearStorageBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');

// Form field IDs
const formFields = {
  repoUrl: document.getElementById('repoUrl'),
  azureApiBaseUrl: document.getElementById('azureApiBaseUrl'),
  azurePat: document.getElementById('azurePat'),
  enableDummyArticles: document.getElementById('enableDummyArticles'),
  enableLLMSearch: document.getElementById('enableLLMSearch'),
  llmEndpoint: document.getElementById('llmEndpoint'),
  llmApiKey: document.getElementById('llmApiKey')
};

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Options page loaded');
  await loadSettings();
  setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
  // Source type toggle
  sourceTypeUrl.addEventListener('change', toggleSourceType);
  sourceTypeAzure.addEventListener('change', toggleSourceType);
  
  // LLM toggle
  formFields.enableLLMSearch.addEventListener('change', toggleLLMSection);
  
  // Form submission
  settingsForm.addEventListener('submit', handleSaveSettings);
  
  // Cancel button
  cancelBtn.addEventListener('click', () => {
    window.close();
  });
  
  // Advanced actions
  clearStorageBtn.addEventListener('click', handleClearStorage);
  exportBtn.addEventListener('click', handleExport);
  importBtn.addEventListener('click', handleImport);
}

// Load settings from storage
async function loadSettings() {
  try {
    const settings = await Storage.getSettings();
    console.log('Loaded settings:', settings);
    
    // Set source type
    if (settings.repoSourceType === 'azure') {
      sourceTypeAzure.checked = true;
    } else {
      sourceTypeUrl.checked = true;
    }
    toggleSourceType();
    
    // Set form values
    formFields.repoUrl.value = settings.repoUrl || '';
    formFields.azureApiBaseUrl.value = settings.azureApiBaseUrl || '';
    formFields.azurePat.value = settings.azurePat || '';
    formFields.enableDummyArticles.checked = settings.enableDummyArticles !== false;
    formFields.enableLLMSearch.checked = settings.enableLLMSearch === true;
    formFields.llmEndpoint.value = settings.llmEndpoint || '';
    formFields.llmApiKey.value = settings.llmApiKey || '';
    
    toggleLLMSection();
    
  } catch (error) {
    console.error('Error loading settings:', error);
    showStatus('Failed to load settings', 'error');
  }
}

// Toggle source type fields
function toggleSourceType() {
  const isAzure = sourceTypeAzure.checked;
  
  if (isAzure) {
    urlGroup.style.display = 'none';
    azureGroup.style.display = 'block';
    azurePatGroup.style.display = 'block';
  } else {
    urlGroup.style.display = 'block';
    azureGroup.style.display = 'none';
    azurePatGroup.style.display = 'none';
  }
}

// Toggle LLM section
function toggleLLMSection() {
  if (formFields.enableLLMSearch.checked) {
    llmSection.style.display = 'block';
  } else {
    llmSection.style.display = 'none';
  }
}

// Handle save settings
async function handleSaveSettings(event) {
  event.preventDefault();
  
  try {
    saveBtn.disabled = true;
    saveBtn.textContent = '💾 Saving...';
    
    const settings = {
      repoSourceType: sourceTypeAzure.checked ? 'azure' : 'url',
      repoUrl: formFields.repoUrl.value.trim(),
      azureApiBaseUrl: formFields.azureApiBaseUrl.value.trim(),
      azurePat: formFields.azurePat.value.trim(),
      enableDummyArticles: formFields.enableDummyArticles.checked,
      enableLLMSearch: formFields.enableLLMSearch.checked,
      llmEndpoint: formFields.llmEndpoint.value.trim(),
      llmApiKey: formFields.llmApiKey.value.trim()
    };
    
    // Validate settings
    if (!validateSettings(settings)) {
      return;
    }
    
    const success = await Storage.setSettings(settings);
    
    if (success) {
      console.log('Settings saved successfully');
      showStatus('Settings saved successfully! ✓', 'success');
      
      // Notify service worker of changes
      chrome.runtime.sendMessage({ type: 'settingsUpdated' });
      
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Settings';
      }, 2000);
    } else {
      throw new Error('Failed to save settings');
    }
    
  } catch (error) {
    console.error('Error saving settings:', error);
    showStatus('Failed to save settings: ' + error.message, 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save Settings';
  }
}

// Validate settings
function validateSettings(settings) {
  // Check required fields based on source type
  if (settings.repoSourceType === 'url') {
    if (!settings.repoUrl) {
      showStatus('Please enter a repository URL', 'error');
      return false;
    }
    
    // Basic URL validation
    try {
      new URL(settings.repoUrl);
    } catch {
      showStatus('Please enter a valid URL', 'error');
      return false;
    }
  } else if (settings.repoSourceType === 'azure') {
    if (!settings.azureApiBaseUrl) {
      showStatus('Please enter Azure API base URL', 'error');
      return false;
    }
    if (!settings.azurePat) {
      showStatus('Please enter Azure PAT', 'error');
      return false;
    }
  }
  
  // Validate LLM settings if enabled
  if (settings.enableLLMSearch) {
    if (!settings.llmEndpoint) {
      showStatus('Please enter LLM endpoint', 'error');
      return false;
    }
    if (!settings.llmApiKey) {
      showStatus('Please enter LLM API key', 'error');
      return false;
    }
  }
  
  return true;
}

// Handle clear storage
async function handleClearStorage() {
  const confirmed = confirm(
    'This will delete all settings and articles. This cannot be undone. Continue?'
  );
  
  if (!confirmed) return;
  
  try {
    await Storage.clearAll();
    showStatus('All data cleared successfully', 'success');
    
    // Reload to show empty state
    setTimeout(() => {
      location.reload();
    }, 1500);
    
  } catch (error) {
    console.error('Error clearing storage:', error);
    showStatus('Failed to clear storage', 'error');
  }
}

// Handle export settings
async function handleExport() {
  try {
    const settings = await Storage.getSettings();
    const articles = await Storage.getArticles();
    
    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      settings,
      articles
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `stepper-backup-${Date.now()}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
    showStatus('Settings exported successfully', 'success');
    
  } catch (error) {
    console.error('Error exporting settings:', error);
    showStatus('Failed to export settings', 'error');
  }
}

// Handle import settings
function handleImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  
  input.onchange = async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      
      const text = await file.text();
      const importData = JSON.parse(text);
      
      // Validate import data
      if (!importData.settings || !importData.articles) {
        throw new Error('Invalid backup file format');
      }
      
      const confirmed = confirm(
        'This will replace all current settings and articles. Continue?'
      );
      
      if (!confirmed) return;
      
      // Import settings and articles
      await Storage.setSettings(importData.settings);
      await Storage.setArticles(importData.articles);
      
      showStatus('Settings imported successfully', 'success');
      
      // Reload to show imported data
      setTimeout(() => {
        location.reload();
      }, 1500);
      
    } catch (error) {
      console.error('Error importing settings:', error);
      showStatus('Failed to import settings: ' + error.message, 'error');
    }
  };
  
  input.click();
}

// Show status message
function showStatus(message, type = 'info') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type} fade-in`;
  statusMessage.style.display = 'block';
  
  // Auto-hide after 5 seconds
  setTimeout(() => {
    statusMessage.style.display = 'none';
  }, 5000);
}
