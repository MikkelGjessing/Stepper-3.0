# Stepper 3.0 - Step-by-Step Guide Assistant

A Microsoft Edge/Chrome browser extension built with Manifest V3 that provides IT agents with a step-by-step guide assistant. Built with vanilla HTML/CSS/JavaScript (no frameworks) for simplicity and maintainability.

## 🚀 Quick Start

1. **Load the extension** in Chrome or Edge (see [INSTALLATION.md](INSTALLATION.md))
2. **Add demo articles** by clicking "➕ Add Demo Articles" in the popup
3. **Search for guides** using the search box
4. **Configure settings** by clicking the ⚙️ button

## 📚 Documentation

- **[INSTALLATION.md](INSTALLATION.md)** - Complete installation and testing guide
- **[EXTENSION_README.md](EXTENSION_README.md)** - Detailed technical documentation

## ✨ Features

- 🔍 **Smart Search** - Intelligent search with relevance ranking
- 📝 **Article Management** - Complete CRUD operations for step-by-step guides
- 💾 **Local Storage** - All data stored securely using chrome.storage.local
- ⚙️ **Flexible Configuration** - Support for URL or Azure DevOps repositories
- 🎨 **Clean UI** - Chat-style interface with dual-panel design
- 🤖 **LLM Ready** - Optional AI-powered search integration (placeholder)
- 🛡️ **Defensive Coding** - Handles missing/corrupt data gracefully

## 📸 Screenshots

**Popup Interface:**

![Popup UI](https://github.com/user-attachments/assets/024eea6b-5dd3-4d0f-ae50-108942b60e3c)

**Settings Page:**

![Options Page](https://github.com/user-attachments/assets/ab092cd8-edc2-4eef-a14c-9f05e22b7e5e)

## 🏗️ Project Structure

```
Stepper-3.0/
├── manifest.json              # Extension manifest (MV3)
├── src/
│   ├── background/
│   │   └── service_worker.js  # Background service worker
│   ├── ui/
│   │   ├── popup.*            # Main popup interface (800x600px)
│   │   └── options.*          # Settings page
│   ├── lib/
│   │   ├── storage.js         # Storage wrapper (chrome.storage.local)
│   │   ├── articles.js        # Article CRUD + parsing
│   │   └── search.js          # Search + ranking
│   └── assets/
│       └── icon*.png          # Extension icons (16/48/128)
└── docs/
    ├── INSTALLATION.md        # Installation guide
    └── EXTENSION_README.md    # Technical documentation
```

## 🔧 Technical Details

- **Manifest Version:** V3
- **Permissions:** `storage` (optional: `activeTab`)
- **Browser Support:** Chrome 88+, Edge 88+
- **Framework:** Vanilla JavaScript (no dependencies)
- **Storage:** chrome.storage.local (IndexedDB ready for future)

## 🎯 Use Cases

Perfect for IT support teams who need quick access to:
- Password reset procedures
- Software installation guides
- Troubleshooting workflows
- Network configuration steps
- Common issue resolutions

## 🛠️ Development

### Load Extension
1. Open `chrome://extensions/` or `edge://extensions/`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select this directory

### Debug
- **Service Worker:** Check logs in extension details
- **Popup:** Right-click popup → Inspect
- **Options:** Right-click options page → Inspect

## 📝 Data Model

**Settings:**
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

**Article:**
```javascript
{
  id: string,
  title: string,
  content: string,
  tags: string[],
  category: string,
  steps: [{number, title, details}],
  metadata: {createdAt, updatedAt, author, version}
}
```

## 🔒 Security

- ✅ No security vulnerabilities (CodeQL verified)
- ✅ XSS protection via HTML escaping
- ✅ No external API calls by default
- ✅ Local data storage only
- ✅ Minimal permissions

## 🚧 Future Enhancements

- [ ] Repository sync (URL/Azure DevOps)
- [ ] LLM-powered search implementation
- [ ] Markdown import/export
- [ ] Content injection into active tabs
- [ ] Article versioning
- [ ] IndexedDB for large articles
- [ ] Collaborative features

## 📄 License

Internal use only - IT Agent Assistant

## 🤝 Contributing

This is an internal tool. For issues or suggestions, please open an issue in the repository.

---

**Version:** 1.0.0  
**Last Updated:** February 2026

