# Installation & Testing Guide

## Quick Start

### Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **"Load unpacked"**
4. Select the root directory of this repository
5. The extension icon should appear in your toolbar!

### Load Extension in Microsoft Edge

1. Open Edge and navigate to `edge://extensions/`
2. Enable **Developer mode** (toggle in left sidebar)
3. Click **"Load unpacked"**
4. Select the root directory of this repository
5. The extension icon should appear in your toolbar!

## First Time Setup

### 1. Open the Extension
Click the extension icon in your browser toolbar to open the popup.

### 2. Add Demo Articles (Recommended for Testing)
- Click the **"➕ Add Demo Articles"** button at the bottom
- This will create 3 sample articles:
  - Password Reset Procedure
  - VPN Connection Setup
  - Email Configuration on Mobile

### 3. Configure Settings (Optional)
- Click the **⚙️ Settings** button in the top right of the popup
- Configure your preferences:
  - Repository source (URL or Azure DevOps)
  - Enable/disable features
  - LLM integration settings
- Click **"💾 Save Settings"** when done

## Testing the Extension

### Test Search Functionality
1. Open the popup
2. Type a search query (e.g., "password" or "vpn")
3. Results should appear in the left panel
4. Click any result to view its content

### Test Article Viewing
1. After searching, click on an article in the results list
2. The article content should display in the right panel
3. Steps should be formatted clearly
4. Click **"← Back"** to return to search

### Test Settings Page
1. Click the settings button (⚙️)
2. Toggle between URL Repository and Azure DevOps
3. Enable/disable features
4. Test export/import functionality
5. Save changes and reload the popup

## Extension Structure

```
/
├── manifest.json              # Extension configuration
├── src/
│   ├── background/
│   │   └── service_worker.js  # Background processes
│   ├── ui/
│   │   ├── popup.*            # Main popup interface
│   │   └── options.*          # Settings page
│   ├── lib/
│   │   ├── storage.js         # Storage wrapper
│   │   ├── articles.js        # Article management
│   │   └── search.js          # Search functionality
│   └── assets/
│       └── icon*.png          # Extension icons
```

## Debugging

### View Service Worker Logs
1. Go to `chrome://extensions/` or `edge://extensions/`
2. Find "Stepper 3.0" extension
3. Click "service worker" link to open DevTools

### Debug Popup
1. Open the popup
2. Right-click anywhere in the popup
3. Select "Inspect"
4. DevTools will open for the popup

### Debug Options Page
1. Click the settings button to open options
2. Right-click anywhere on the page
3. Select "Inspect"
4. DevTools will open for the options page

## Common Issues

### Extension Won't Load
- Make sure you're selecting the root directory (contains manifest.json)
- Check that all files are present
- Look for errors in the extensions page

### No Articles Showing
- Click "Add Demo Articles" to add sample data
- Check the console for errors
- Try refreshing the popup

### Settings Not Saving
- Check browser console for errors
- Ensure chrome.storage permission is granted
- Try clearing all data and starting fresh

## Data Storage

All data is stored locally using `chrome.storage.local`:
- Settings: Repository config, feature flags
- Articles: All article data with metadata
- No external connections by default

## Security

- No external API calls unless configured
- All data stored locally
- No sensitive data logged to console
- XSS protection via proper HTML escaping

## Next Steps

Once you've tested the basic functionality:
1. Configure your repository source
2. Add your own articles
3. Customize settings for your use case
4. Share with your IT team!

## Support

For issues or questions, please open an issue in the GitHub repository.
