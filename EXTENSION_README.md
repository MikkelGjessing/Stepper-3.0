# Stepper 3.0 - Step-by-Step Guide Assistant

A browser extension for Microsoft Edge and Chrome that provides IT agents with a step-by-step guide assistant. Built with Manifest V3 using vanilla HTML/CSS/JavaScript.

## Features

- 🔍 **Smart Search**: Find guides quickly with intelligent search and ranking
- 📚 **Article Management**: Create, read, update, and delete step-by-step guides
- 💾 **Persistent Storage**: All data saved locally using chrome.storage.local
- ⚙️ **Flexible Configuration**: Support for URL-based or Azure DevOps repositories
- 🤖 **LLM Integration**: Optional AI-powered search capabilities
- 🎨 **Clean UI**: Chat-style interface with article viewer panel

## Installation

### For Development/Testing

1. Clone this repository:
   ```bash
   git clone https://github.com/MikkelGjessing/Stepper-3.0.git
   cd Stepper-3.0
   ```

2. Load the extension in your browser:

   **Chrome:**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the extension directory

   **Microsoft Edge:**
   - Navigate to `edge://extensions/`
   - Enable "Developer mode" (toggle in left sidebar)
   - Click "Load unpacked"
   - Select the extension directory

3. The extension icon should appear in your browser toolbar!

## Usage

### First Time Setup

1. Click the extension icon to open the popup
2. Click the settings button (⚙️) in the top right
3. Configure your settings:
   - Choose repository source type (URL or Azure DevOps)
   - Enter repository details
   - Enable/disable features as needed
4. Save your settings

### Adding Demo Articles

To quickly test the extension:
1. Open the popup
2. Click "➕ Add Demo Articles" at the bottom
3. Three sample articles will be added

### Searching for Guides

1. Open the popup
2. Type your query in the search box
3. Results will appear in the left panel
4. Click any result to view its content in the right panel

### Managing Articles

Articles are stored locally and include:
- Title
- Content with step-by-step instructions
- Category
- Tags
- Metadata (created/updated timestamps, author, version)

## File Structure

```
Stepper-3.0/
├── manifest.json              # Extension manifest (MV3)
├── src/
│   ├── background/
│   │   └── service_worker.js  # Background service worker
│   ├── ui/
│   │   ├── popup.html         # Main popup interface
│   │   ├── popup.css          # Popup styles
│   │   ├── popup.js           # Popup controller
│   │   ├── options.html       # Settings page
│   │   ├── options.css        # Settings styles
│   │   └── options.js         # Settings controller
│   ├── lib/
│   │   ├── storage.js         # Storage wrapper for chrome.storage.local
│   │   ├── articles.js        # Article CRUD operations
│   │   └── search.js          # Search and ranking functionality
│   └── assets/
│       ├── icon16.png         # 16x16 icon
│       ├── icon48.png         # 48x48 icon
│       └── icon128.png        # 128x128 icon
└── README.md
```

## Technical Details

### Manifest V3

The extension uses Manifest V3 with:
- **Service Worker**: Background processing and initialization
- **Storage Permission**: For persistent data storage
- **Optional activeTab**: For future content injection features

### Data Model

#### Settings Object
```javascript
{
  repoSourceType: "url" | "azure",
  repoUrl: string,
  azureApiBaseUrl: string,
  azurePat: string,
  enableDummyArticles: boolean,
  enableLLMSearch: boolean,
  llmEndpoint: string,
  llmApiKey: string
}
```

#### Article Object
```javascript
{
  id: string,
  title: string,
  content: string,
  tags: string[],
  category: string,
  steps: Array<{
    number: number,
    title: string,
    details: string[]
  }>,
  metadata: {
    createdAt: string,
    updatedAt: string,
    author: string,
    version: string
  }
}
```

### Storage

- Uses `chrome.storage.local` for data persistence
- Defensive coding with fallbacks for missing/corrupt data
- Import/export functionality for backup and restore

### Search Algorithm

The search functionality uses a relevance scoring system:
- **Title matches**: Highest weight (10 points)
- **Category matches**: Medium weight (5 points)
- **Tag matches**: Medium weight (3 points per tag)
- **Content matches**: Lower weight (2 points + occurrence bonus)
- **Token matching**: Additional scoring for multi-word queries

## Development

### Prerequisites
- Modern browser (Chrome 88+ or Edge 88+)
- Basic understanding of JavaScript, HTML, CSS
- Knowledge of Chrome Extension APIs

### Making Changes

1. Edit the source files in the `src/` directory
2. Reload the extension in your browser:
   - Go to extensions page
   - Click the refresh icon on the extension card
3. Test your changes

### Debugging

- **Service Worker**: Check logs in the extension's service worker console
- **Popup**: Right-click the popup and select "Inspect"
- **Options Page**: Right-click and select "Inspect" when on the options page

## Future Enhancements

- [ ] Integrate with external repositories (URL/Azure DevOps)
- [ ] Implement LLM-powered search
- [ ] Add article import from various formats (Markdown, etc.)
- [ ] Content injection into active tabs
- [ ] Collaborative features
- [ ] Article versioning
- [ ] IndexedDB for large article bodies
- [ ] Offline sync support

## License

Internal use only - IT Agent Assistant

## Support

For issues or questions, please open an issue in the GitHub repository.

---

**Version**: 1.0.0  
**Last Updated**: February 2026
