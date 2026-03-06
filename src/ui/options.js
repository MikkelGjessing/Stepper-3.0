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
const resetBtn = document.getElementById('resetBtn');
const cancelBtn = document.getElementById('cancelBtn');
const clearStorageBtn = document.getElementById('clearStorageBtn');
const addDemoArticlesBtn = document.getElementById('addDemoArticlesBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importArticleBtn = document.getElementById('importArticleBtn');
const clearUploadedArticlesBtn = document.getElementById('clearUploadedArticlesBtn');
const articleFileInput = document.getElementById('articleFile');
const uploadStatus = document.getElementById('uploadStatus');
const uploadedArticlesCount = document.getElementById('uploadedArticlesCount');
const syncRepoBtn = document.getElementById('syncRepoBtn');
const syncStatus = document.getElementById('syncStatus');
const repoArticlesCount = document.getElementById('repoArticlesCount');

// ServiceNow DOM elements
const snEnabled = document.getElementById('snEnabled');
const snFields = document.getElementById('snFields');
const snBaseUrl = document.getElementById('snBaseUrl');
const snFilter = document.getElementById('snFilter');
const snUsername = document.getElementById('snUsername');
const snPassword = document.getElementById('snPassword');
const snAutoSync = document.getElementById('snAutoSync');
const snTestBtn = document.getElementById('snTestBtn');
const snExtractBtn = document.getElementById('snExtractBtn');
const snStatus = document.getElementById('snStatus');
const snInfo = document.getElementById('snInfo');

// Form field IDs
const formFields = {
  repoUrl: document.getElementById('repoUrl'),
  azureApiBaseUrl: document.getElementById('azureApiBaseUrl'),
  azurePat: document.getElementById('azurePat'),
  enableDummyArticles: document.getElementById('enableDummyArticles'),
  enableLLMSearch: document.getElementById('enableLLMSearch'),
  enablePageScanning: document.getElementById('enablePageScanning'),
  llmEndpoint: document.getElementById('llmEndpoint'),
  llmApiKey: document.getElementById('llmApiKey'),
  llmModel: document.getElementById('llmModel')
};

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  console.log('Options page loaded');
  await loadSettings();
  await updateUploadedArticlesCount();
  await updateRepoArticlesCount();
  await updateSnInfo();
  setupEventListeners();
});

// Setup event listeners
function setupEventListeners() {
  // Source type toggle
  sourceTypeUrl.addEventListener('change', toggleSourceType);
  sourceTypeAzure.addEventListener('change', toggleSourceType);
  
  // LLM toggle
  formFields.enableLLMSearch.addEventListener('change', toggleLLMSection);

  // ServiceNow toggle
  snEnabled.addEventListener('change', toggleSnFields);
  snTestBtn.addEventListener('click', handleSnTest);
  snExtractBtn.addEventListener('click', handleSnExtract);
  
  // Form submission
  settingsForm.addEventListener('submit', handleSaveSettings);
  
  // Reset button
  resetBtn.addEventListener('click', handleResetToDefaults);
  
  // Cancel button
  cancelBtn.addEventListener('click', () => {
    window.close();
  });
  
  // Advanced actions
  addDemoArticlesBtn.addEventListener('click', handleAddDemoArticles);
  clearStorageBtn.addEventListener('click', handleClearStorage);
  exportBtn.addEventListener('click', handleExport);
  importBtn.addEventListener('click', handleImport);
  
  // Upload article actions
  importArticleBtn.addEventListener('click', handleImportArticle);
  clearUploadedArticlesBtn.addEventListener('click', handleClearUploadedArticles);
  
  // Sync repository
  syncRepoBtn.addEventListener('click', handleSyncRepo);
}

// Load settings from storage
async function loadSettings() {
  try {
    const settings = await Storage.getSettings();
    // Note: Not logging settings to avoid exposing secrets like PAT and API keys
    
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
    formFields.enablePageScanning.checked = settings.enablePageScanning === true;
    formFields.llmEndpoint.value = settings.llmEndpoint || '';
    formFields.llmApiKey.value = settings.llmApiKey || '';
    formFields.llmModel.value = settings.llmModel || 'gpt-3.5-turbo';

    // Load ServiceNow settings (use defaults if absent)
    const defaults = typeof defaultServiceNowSettings === 'function'
      ? defaultServiceNowSettings()
      : {};
    const sn = { ...defaults, ...(settings.serviceNow || {}) };
    snEnabled.checked = sn.enabled !== false;
    snBaseUrl.value = sn.baseUrl || '';
    snFilter.value = sn.filter || '';
    snUsername.value = sn.username || '';
    snPassword.value = sn.password || '';
    snAutoSync.checked = sn.autoSyncWeekly !== false;
    toggleSnFields();
    
    toggleLLMSection();
    
  } catch (error) {
    console.error('Error loading settings:', error);
    showStatus('Failed to load settings', 'error');
  }
}

// Toggle ServiceNow fields visibility based on enabled checkbox
function toggleSnFields() {
  snFields.style.display = snEnabled.checked ? 'block' : 'none';
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

    // Preserve existing serviceNow metadata fields that are not in the form
    const existingSettings = await Storage.getSettings();
    const existingSn = existingSettings.serviceNow || {};

    const settings = {
      repoSourceType: sourceTypeAzure.checked ? 'azure' : 'url',
      repoUrl: formFields.repoUrl.value.trim(),
      azureApiBaseUrl: formFields.azureApiBaseUrl.value.trim(),
      azurePat: formFields.azurePat.value.trim(),
      enableDummyArticles: formFields.enableDummyArticles.checked,
      enableLLMSearch: formFields.enableLLMSearch.checked,
      enablePageScanning: formFields.enablePageScanning.checked,
      llmEndpoint: formFields.llmEndpoint.value.trim(),
      llmApiKey: formFields.llmApiKey.value.trim(),
      llmModel: formFields.llmModel.value.trim() || 'gpt-3.5-turbo',
      serviceNow: {
        ...existingSn,
        enabled: snEnabled.checked,
        baseUrl: snBaseUrl.value.trim(),
        filter: snFilter.value.trim(),
        username: snUsername.value.trim(),
        // Keep existing password if field is empty (not changed)
        password: snPassword.value || existingSn.password || '',
        autoSyncWeekly: snAutoSync.checked
      }
    };
    
    // Optional format validation (only if values are provided)
    const validationError = validateFormats(settings);
    if (validationError) {
      showStatus(validationError, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Settings';
      return;
    }
    
    const success = await Storage.setSettings(settings);
    
    if (success) {
      // Note: Not logging settings to avoid exposing secrets
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

// Handle reset to defaults
async function handleResetToDefaults() {
  const confirmed = confirm(
    'This will reset all settings to their default values. Continue?'
  );
  
  if (!confirmed) return;
  
  try {
    resetBtn.disabled = true;
    resetBtn.textContent = '🔄 Resetting...';
    
    const defaultSettings = {
      repoSourceType: 'url',
      repoUrl: '',
      azureApiBaseUrl: '',
      azurePat: '',
      enableDummyArticles: true,
      enableLLMSearch: false,
      llmEndpoint: '',
      llmApiKey: '',
      llmModel: 'gpt-3.5-turbo',
      enablePageScanning: false,
      serviceNow: typeof defaultServiceNowSettings === 'function'
        ? defaultServiceNowSettings()
        : {}
    };
    
    const success = await Storage.setSettings(defaultSettings);
    
    if (success) {
      showStatus('Settings reset to defaults successfully! ✓', 'success');
      
      // Reload the form to show default values (brief delay for user to see success message)
      setTimeout(async () => {
        await loadSettings();
        resetBtn.disabled = false;
        resetBtn.textContent = '🔄 Reset to Defaults';
      }, 800);
    } else {
      throw new Error('Failed to reset settings');
    }
    
  } catch (error) {
    console.error('Error resetting settings:', error);
    showStatus('Failed to reset settings: ' + error.message, 'error');
    resetBtn.disabled = false;
    resetBtn.textContent = '🔄 Reset to Defaults';
  }
}

// Helper function to validate URL format
// Returns true if URL is empty (optional) or has valid format
// Returns false if URL is provided but has invalid format
function isValidUrl(url) {
  if (!url) return true; // Empty URLs are valid (field is optional)
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// Validate formats (only if values are provided) - does NOT block saving
function validateFormats(settings) {
  // Only validate URL format if repoUrl is provided
  if (settings.repoUrl && !isValidUrl(settings.repoUrl)) {
    return 'Invalid Repository URL format';
  }
  
  // Only validate Azure API URL format if provided
  if (settings.azureApiBaseUrl && !isValidUrl(settings.azureApiBaseUrl)) {
    return 'Invalid Azure API URL format';
  }
  
  // Only validate LLM endpoint format if provided
  if (settings.llmEndpoint && !isValidUrl(settings.llmEndpoint)) {
    return 'Invalid LLM endpoint URL format';
  }

  // Only validate ServiceNow Base URL format if provided
  if (settings.serviceNow && settings.serviceNow.baseUrl && !isValidUrl(settings.serviceNow.baseUrl)) {
    return 'Invalid ServiceNow Base URL format';
  }
  
  return null; // No validation errors
}

// Validate settings for specific actions (used by Sync, etc.)
function validateSettingsForAction(settings, action) {
  if (action === 'sync') {
    // Check required fields based on source type
    if (settings.repoSourceType === 'url') {
      if (!settings.repoUrl) {
        return 'Please configure and save Repository URL before syncing';
      }
      
      // Re-validate format in case settings were imported or modified outside normal flow
      if (!isValidUrl(settings.repoUrl)) {
        return 'Invalid Repository URL format. Please correct it before syncing';
      }
    } else if (settings.repoSourceType === 'azure') {
      if (!settings.azureApiBaseUrl) {
        return 'Please configure and save Azure API base URL before syncing';
      }
      if (!settings.azurePat) {
        return 'Please configure and save Azure PAT before syncing';
      }
      
      // Re-validate format in case settings were imported or modified outside normal flow
      if (!isValidUrl(settings.azureApiBaseUrl)) {
        return 'Invalid Azure API URL format. Please correct it before syncing';
      }
    }
  }
  
  return null; // No validation errors
}

// Handle add demo articles
async function handleAddDemoArticles() {
  try {
    const settings = await Storage.getSettings();
    
    if (!settings.enableDummyArticles) {
      showStatus('Demo articles are disabled. Please enable them in Features section first.', 'error');
      return;
    }
    
    addDemoArticlesBtn.disabled = true;
    addDemoArticlesBtn.textContent = '⏳ Adding...';
    
    await Articles.loadDummyArticlesIfNeeded();
    const articles = await Articles.getAllArticles(false);
    const dummyCount = articles.filter(a => a.source === 'dummy').length;
    
    console.log('Loaded demo articles:', dummyCount);
    
    showStatus(`✓ Successfully loaded ${dummyCount} demo articles`, 'success');
    
  } catch (error) {
    console.error('Error adding demo articles:', error);
    showStatus('Failed to add demo articles: ' + error.message, 'error');
  } finally {
    addDemoArticlesBtn.disabled = false;
    addDemoArticlesBtn.textContent = '➕ Add Demo Articles';
  }
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

// ── ServiceNow handlers ────────────────────────────────────────────────────

/**
 * Collect ServiceNow settings from the form (without saving to storage).
 * Used by Test Connection so the user can test unsaved values.
 */
function collectSnSettingsFromForm() {
  return {
    enabled: snEnabled.checked,
    baseUrl: snBaseUrl.value.trim(),
    filter: snFilter.value.trim(),
    username: snUsername.value.trim(),
    // Note: password value intentionally not logged anywhere
    password: snPassword.value,
    autoSyncWeekly: snAutoSync.checked
  };
}

/** Test connection using currently typed (unsaved) field values */
async function handleSnTest() {
  const snSettings = collectSnSettingsFromForm();

  if (!snSettings.baseUrl) {
    showSnStatus('Please enter a Base URL', 'error');
    return;
  }

  // Warn if credentials still contain placeholder values
  if (
    snSettings.username === '__SERVICENOW_USERNAME__' ||
    snSettings.password === '__SERVICENOW_PASSWORD__'
  ) {
    showSnStatus('⚠ Update username/password before testing – placeholder values are still set', 'error');
    return;
  }

  snTestBtn.disabled = true;
  snTestBtn.textContent = '⏳ Testing…';
  showSnStatus('Testing connection…', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_SERVICENOW',
      settings: snSettings
    });

    if (response && response.success) {
      showSnStatus('✓ ' + response.message, 'success');
    } else {
      showSnStatus('✗ ' + (response ? response.message : 'No response from service worker'), 'error');
    }
  } catch (err) {
    console.error('Error testing ServiceNow connection:', err);
    showSnStatus('Failed to test connection: ' + err.message, 'error');
  } finally {
    snTestBtn.disabled = false;
    snTestBtn.textContent = '🔌 Test Connection';
  }
}

/** Extract (sync) articles from ServiceNow using stored settings */
async function handleSnExtract() {
  // Check stored settings for placeholder credentials before starting
  const storedSettings = await Storage.getSettings();
  const storedSn = storedSettings.serviceNow || {};
  if (
    storedSn.username === '__SERVICENOW_USERNAME__' ||
    storedSn.password === '__SERVICENOW_PASSWORD__'
  ) {
    showSnStatus('⚠ Update and save real username/password before extracting – placeholder values are still set', 'error');
    return;
  }

  snExtractBtn.disabled = true;
  snExtractBtn.textContent = '⏳ Syncing…';
  showSnStatus('Syncing articles from ServiceNow…', 'info');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'SYNC_SERVICENOW' });

    if (response && response.success) {
      showSnStatus('✓ ' + response.message, 'success');
      await updateSnInfo();
    } else {
      showSnStatus('✗ ' + (response ? response.message : 'No response from service worker'), 'error');
    }
  } catch (err) {
    console.error('Error extracting ServiceNow articles:', err);
    showSnStatus('Failed to extract: ' + err.message, 'error');
  } finally {
    snExtractBtn.disabled = false;
    snExtractBtn.textContent = '⬇️ Extract Now';
  }
}

/** Show a status message in the ServiceNow status area */
let _snStatusTimer = null;
function showSnStatus(message, type = 'info') {
  // Clear any previously scheduled auto-clear
  if (_snStatusTimer !== null) {
    clearTimeout(_snStatusTimer);
    _snStatusTimer = null;
  }
  snStatus.textContent = message;
  snStatus.style.color =
    type === 'success' ? '#28a745' :
    type === 'error'   ? '#dc3545' :
    '#666';
  snStatus.style.fontWeight = '500';

  // Auto-clear after 10 s
  _snStatusTimer = setTimeout(() => {
    snStatus.textContent = '';
    _snStatusTimer = null;
  }, 10000);
}

/** Refresh the ServiceNow info area (last sync time, article count, last error) */
async function updateSnInfo() {
  try {
    const settings = await Storage.getSettings();
    const sn = settings.serviceNow || {};

    const allArticles = await Storage.getArticles();
    const count = allArticles.filter(a => a.source === 'servicenow' && !a.stale).length;

    const parts = [];
    if (sn.lastSyncAt) {
      const d = new Date(sn.lastSyncAt);
      parts.push(`Last sync: ${d.toLocaleString()}`);
    } else {
      parts.push('Last sync: never');
    }
    parts.push(`Articles stored: ${count}`);
    if (sn.lastError) {
      parts.push(`⚠ Last error: ${sn.lastError}`);
    }

    snInfo.textContent = parts.join(' · ');
  } catch (err) {
    console.error('Error updating ServiceNow info:', err);
    snInfo.textContent = '';
  }
}

// ── End ServiceNow handlers ────────────────────────────────────────────────

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

// Handle import article
async function handleImportArticle() {
  const file = articleFileInput.files[0];
  
  if (!file) {
    showUploadStatus('Please select a file to import', 'error');
    return;
  }
  
  try {
    importArticleBtn.disabled = true;
    importArticleBtn.textContent = '⏳ Importing...';
    
    const result = await Articles.importArticleFile(file);
    
    // Handle new response format with ok/success field
    const isSuccess = result.ok === true || result.success === true;
    
    if (isSuccess) {
      showUploadStatus(result.message, 'success');
      articleFileInput.value = ''; // Clear file input
      await updateUploadedArticlesCount();
    } else {
      // Display detailed error with file name
      const errorMessage = result.fileName 
        ? `Failed to import "${result.fileName}": ${result.message}`
        : result.message || 'Failed to import article';
      
      showUploadStatus(errorMessage, 'error');
      
      // console.error full stack trace (without secrets)
      console.error('Article import error details:', {
        fileName: result.fileName,
        errorCode: result.errorCode,
        message: result.message,
        details: result.details,
        stack: result.stack
      });
      
      // Show "Copy error details" button
      showCopyErrorButton(result);
    }
    
  } catch (error) {
    console.error('Error importing article:', error);
    showUploadStatus('Unexpected error: ' + error.message, 'error');
  } finally {
    importArticleBtn.disabled = false;
    importArticleBtn.textContent = '📥 Import';
  }
}

// Show copy error details button
function showCopyErrorButton(errorResult) {
  // Remove any existing error button
  const existingBtn = document.getElementById('copyErrorBtn');
  if (existingBtn) {
    existingBtn.remove();
  }
  
  // Create copy error button
  const copyBtn = document.createElement('button');
  copyBtn.id = 'copyErrorBtn';
  copyBtn.className = 'btn btn-secondary';
  copyBtn.textContent = '📋 Copy Error Details';
  copyBtn.style.marginTop = '10px';
  copyBtn.style.fontSize = '12px';
  copyBtn.setAttribute('aria-label', 'Copy error details to clipboard');
  
  // Create status message container with aria-live for screen readers
  const statusSpan = document.createElement('span');
  statusSpan.id = 'copyErrorStatus';
  statusSpan.setAttribute('aria-live', 'polite');
  statusSpan.style.marginLeft = '10px';
  statusSpan.style.fontSize = '12px';
  statusSpan.style.color = '#28a745';
  
  copyBtn.onclick = () => {
    const errorDetails = `
File: ${errorResult.fileName || 'unknown'}
Error Code: ${errorResult.errorCode || 'N/A'}
Message: ${errorResult.message || 'N/A'}
Details: ${errorResult.details || 'N/A'}
    `.trim();
    
    navigator.clipboard.writeText(errorDetails).then(() => {
      statusSpan.textContent = '✓ Copied!';
      setTimeout(() => {
        statusSpan.textContent = '';
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard');
    });
  };
  
  // Insert after uploadStatus
  uploadStatus.parentNode.insertBefore(copyBtn, uploadStatus.nextSibling);
  copyBtn.parentNode.insertBefore(statusSpan, copyBtn.nextSibling);
}

// Handle clear uploaded articles
async function handleClearUploadedArticles() {
  const confirmed = confirm(
    'This will delete all uploaded articles. This cannot be undone. Continue?'
  );
  
  if (!confirmed) return;
  
  try {
    clearUploadedArticlesBtn.disabled = true;
    clearUploadedArticlesBtn.textContent = '⏳ Clearing...';
    
    const result = await Articles.clearUploadedArticles();
    
    if (result.success) {
      showUploadStatus(result.message, 'success');
      await updateUploadedArticlesCount();
    } else {
      showUploadStatus(result.message, 'error');
    }
    
  } catch (error) {
    console.error('Error clearing uploaded articles:', error);
    showUploadStatus('Failed to clear uploaded articles: ' + error.message, 'error');
  } finally {
    clearUploadedArticlesBtn.disabled = false;
    clearUploadedArticlesBtn.textContent = '🗑️ Clear Uploaded Articles';
  }
}

// Show upload status message
function showUploadStatus(message, type = 'info') {
  uploadStatus.textContent = message;
  uploadStatus.className = `upload-status ${type}`;
  uploadStatus.style.color = type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#666';
  uploadStatus.style.fontWeight = '500';
  
  // Auto-hide after 5 seconds
  setTimeout(() => {
    uploadStatus.textContent = '';
  }, 5000);
}

// Update uploaded articles count
async function updateUploadedArticlesCount() {
  try {
    const count = await Articles.getUploadedArticlesCount();
    if (count > 0) {
      uploadedArticlesCount.textContent = `📊 ${count} uploaded article${count === 1 ? '' : 's'}`;
      uploadedArticlesCount.style.fontWeight = '500';
    } else {
      uploadedArticlesCount.textContent = 'No uploaded articles';
      uploadedArticlesCount.style.fontWeight = 'normal';
    }
  } catch (error) {
    console.error('Error updating uploaded articles count:', error);
    uploadedArticlesCount.textContent = '';
  }
}

// Update repo articles count
async function updateRepoArticlesCount() {
  try {
    const articles = await Storage.getArticles();
    const repoArticles = articles.filter(a => a.source === 'repo');
    const count = repoArticles.length;
    
    if (count > 0) {
      repoArticlesCount.textContent = `📊 ${count} repo article${count === 1 ? '' : 's'} synced`;
      repoArticlesCount.style.fontWeight = '500';
    } else {
      repoArticlesCount.textContent = 'No repo articles synced yet';
      repoArticlesCount.style.fontWeight = 'normal';
    }
  } catch (error) {
    console.error('Error updating repo articles count:', error);
    repoArticlesCount.textContent = '';
  }
}

// Handle sync repository
async function handleSyncRepo() {
  try {
    // Get current settings
    const settings = await Storage.getSettings();
    
    // Validate configuration for sync action
    const validationError = validateSettingsForAction(settings, 'sync');
    if (validationError) {
      showSyncStatus(validationError, 'error');
      return;
    }
    
    // Disable button and show progress
    syncRepoBtn.disabled = true;
    syncRepoBtn.textContent = '⏳ Syncing...';
    showSyncStatus('Syncing articles from repository...', 'info');
    
    // Send message to service worker to perform sync
    const response = await chrome.runtime.sendMessage({
      type: 'SYNC_REPO',
      settings: settings
    });
    
    if (response && response.success) {
      showSyncStatus(response.message, 'success');
      await updateRepoArticlesCount();
    } else {
      showSyncStatus(response.message || 'Sync failed', 'error');
    }
    
  } catch (error) {
    console.error('Error syncing repository:', error);
    showSyncStatus('Failed to sync: ' + error.message, 'error');
  } finally {
    syncRepoBtn.disabled = false;
    syncRepoBtn.textContent = '🔄 Sync Now';
  }
}

// Show sync status message
function showSyncStatus(message, type = 'info') {
  syncStatus.textContent = message;
  syncStatus.className = `sync-status ${type}`;
  syncStatus.style.color = type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#666';
  syncStatus.style.fontWeight = '500';
  
  // Auto-hide after 8 seconds (longer for sync messages)
  setTimeout(() => {
    syncStatus.textContent = '';
  }, 8000);
}
