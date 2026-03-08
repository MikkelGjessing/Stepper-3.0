/**
 * Article CRUD operations and parsing
 * Manages article data structure and operations
 *
 * Depends on:
 *   ArticleNormalizer  (normalizer.js   – loaded before this file)
 *   Ingestion          (ingestion.js    – loaded after this file; only
 *                        referenced inside method bodies, not at load time)
 *   ParserRegistry     (parser_strategies.js – same lazy-reference rule)
 *
 * Article Schema:
 * {
 *   id: string (UUID),
 *   title: string,                  ← resolved best-available title (see resolveArticleTitle)
 *   originalTitle: string,          ← raw title exactly as found in source (may be empty)
 *   originalTitleCandidate: string, ← first raw candidate found before filtering (debug)
 *   titleSource: string,            ← which field/heuristic produced title
 *                                      ("short_description"|"title"|"name"|"h1"|"topHeading"|
 *                                       "strong"|"first_line"|"filename"|"fallback")
 *   titleCandidates: string[],      ← all candidates considered, for debugging (optional)
 *   summary: string,
 *   introHtml: string (optional, general info / intro section HTML),
 *   relatedInfoHtml: string (optional, related information section HTML),
 *   searchText: string (pre-computed normalised text for full-text search),
 *   tags: string[],
 *   estimatedMinutes: number (optional),
 *   steps: Step[],
 *   parserMeta: {              ← added by the parser-strategy pipeline
 *     parserName:            string,
 *     parserScore:           number,
 *     stepCount:             number,
 *     sectionHeadings:       string[],
 *     procedureSectionFound: boolean,
 *     hasNotes:              boolean,
 *     hasImages:             boolean,
 *     hasTables:             boolean,
 *     parsingWarnings:       string[],
 *     selectionReasons:      string[]
 *   },
 *   source: "dummy" | "uploaded" | "repo" | "servicenow",
 *   createdAt: string (ISO),
 *   updatedAt: string (ISO)
 * }
 *
 * Step Schema:
 * {
 *   index: number,
 *   title: string,
 *   chapterTitle?: string (optional, for chaptered procedures),
 *   bodyHtml: string,
 *   images: Array<{ alt: string, dataUrlOrRemoteUrl: string }>
 * }
 */

const Articles = {
  // Constants
  MAX_TITLE_LENGTH_FROM_FIRST_LINE: 100,
  /** Minimum character length for a heuristic-derived title to be considered substantive. */
  MIN_SUBSTANTIVE_TITLE_LENGTH: 8,
  /** Maximum characters to include in debug candidate preview strings. */
  DEBUG_TITLE_PREVIEW_LENGTH: 80,
  /** Regex matching leading step-number tokens stripped before title comparison. */
  TITLE_STEP_TOKEN_RE: /^(?:step)\s+\d+\s*[:\-–]?\s*/i,
  /** Block-level element tags considered meaningful heading content for duplicate detection. */
  HEADING_BLOCK_TAGS: new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI']),
  
  /**
   * Generate UUID v4 using crypto API for better randomness
   * @returns {string} UUID
   */
  generateUUID() {
    // Use crypto.randomUUID if available (modern browsers)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    
    // Fallback to crypto.getRandomValues
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      
      // Set version (4) and variant bits
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      
      const hexArray = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
      return `${hexArray.slice(0, 4).join('')}-${hexArray.slice(4, 6).join('')}-${hexArray.slice(6, 8).join('')}-${hexArray.slice(8, 10).join('')}-${hexArray.slice(10).join('')}`;
    }
    
    // Fallback for older environments (less secure)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  /**
   * Resolve the best available article title from raw source metadata and document content.
   *
   * Priority order:
   *   1. Explicit API/metadata fields: short_description, title, name, article_title, heading
   *   2. First valid <h1> in document (scans all h1s, skips template banners & section labels)
   *   3. First valid <h2>/<h3> in document (first heading-like element before section labels)
   *   4. First <strong>/<b> that IS the entire text of its parent paragraph (DOCX title pattern)
   *   5. First meaningful paragraph/heading in body (not a structural section heading)
   *   6. fallbackTitle (e.g. filename without extension)
   *   7. "Untitled article"
   *
   * Section labels ("Audience", "Skills", "Procedure", "General info", "Notes", etc.)
   * and template banners ("Standard template for…") are never used as article titles.
   *
   * @param {Object|null} rawSourceData - Raw source metadata (ServiceNow fields, etc.) or null
   * @param {Document|null} doc         - Parsed HTML document, or null
   * @param {string}  [fallbackTitle]   - Fallback title (e.g. filename without extension)
   * @returns {{ title: string, originalTitle: string, originalTitleCandidate: string,
   *             titleSource: string, titleCandidates: string[] }}
   */
  resolveArticleTitle(rawSourceData, doc, fallbackTitle) {
    const UI_NOISE_RE = /copy\s+permalink|leave\s+a\s+comment|top\s+of\s+form|bottom\s+of\s+form/i;

    // KB-article template banners that should never be used as article titles
    const TEMPLATE_BANNER_RE = /^standard\s+template\s+for\b|^template\s+for\s+|^kb\s+article\s+template\b/i;

    // Exact section-label blacklist — these values (case-insensitive) must NEVER be titles
    const BLACKLISTED_LABELS = new Set([
      'audience', 'skills', 'skills required',
      'general info', 'general information',
      'procedure', 'procedure (how to)',
      'instructions', 'work instructions',
      'related articles', 'related information', 'related links',
      'change log', 'change history', 'change',
      'date', 'id', 'step', 'action',
      'image & details', 'image and details',
      'notes', 'note', 'warning', 'important', 'caution',
      'overview', 'introduction', 'summary', 'background',
      'keywords', 'tags', 'appendix', 'revision history', 'prerequisites'
    ]);

    /** Decode HTML entities, collapse whitespace, and trim a candidate string.
     *  Uses innerHTML+textContent — a safe browser idiom for entity decoding since
     *  we never read back innerHTML, only the sanitised plain-text value. */
    const cleanCandidate = (t) => {
      if (!t || typeof t !== 'string') return '';
      const tmp = document.createElement('div');
      tmp.innerHTML = t;
      return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
    };

    /** Return true if the text must be rejected as an article title. */
    const isBadCandidate = (text) => {
      if (!text) return true;
      const t = text.trim();
      if (!t) return true;
      if (UI_NOISE_RE.test(t)) return true;
      if (TEMPLATE_BANNER_RE.test(t)) return true;
      if (BLACKLISTED_LABELS.has(t.toLowerCase())) return true;
      // Handle numbered section labels: "1. Procedure", "2. Audience", etc.
      const numberedMatch = t.match(/^\d+[.)]\s*(.+)$/);
      if (numberedMatch && BLACKLISTED_LABELS.has(numberedMatch[1].trim().toLowerCase())) return true;
      return false;
    };

    /** Return true if the title looks substantive enough to use as an article title. */
    const isSubstantialTitle = (text) => {
      if (!text) return false;
      return text.trim().length > this.MIN_SUBSTANTIVE_TITLE_LENGTH;
    };

    const titleCandidates = [];
    let resolvedTitle = '';
    let originalTitleCandidate = '';
    let titleSource = 'fallback';

    // ── Priority 1: Explicit source metadata fields ─────────────────────────
    if (rawSourceData) {
      const CANDIDATE_FIELDS = ['short_description', 'title', 'name', 'article_title', 'heading'];
      for (const field of CANDIDATE_FIELDS) {
        const raw = rawSourceData[field];
        if (!raw) continue;
        const cleaned = cleanCandidate(String(raw));
        if (cleaned) {
          titleCandidates.push(`[${field}] ${cleaned}`);
          if (!originalTitleCandidate) originalTitleCandidate = cleaned;
          if (!isBadCandidate(cleaned)) {
            resolvedTitle = cleaned;
            titleSource   = field;
            console.debug(`[Stepper] resolveArticleTitle: accepted metadata field "${field}" → "${cleaned}"`);
            break;
          }
          console.debug(`[Stepper] resolveArticleTitle: rejected metadata field "${field}" ("${cleaned}")`);
        }
      }
    }

    // ── Priority 2: First valid <h1> in document ────────────────────────────
    if (!resolvedTitle && doc) {
      for (const h1 of doc.querySelectorAll('h1')) {
        const cleaned = h1.textContent.trim();
        if (cleaned) {
          titleCandidates.push(`[h1] ${cleaned}`);
          if (!originalTitleCandidate) originalTitleCandidate = cleaned;
          if (!isBadCandidate(cleaned) && isSubstantialTitle(cleaned)) {
            resolvedTitle = cleaned;
            titleSource   = 'h1';
            console.debug(`[Stepper] resolveArticleTitle: accepted h1 → "${cleaned}"`);
            break;
          }
          console.debug(`[Stepper] resolveArticleTitle: rejected h1 ("${cleaned}")`);
        }
      }
    }

    // ── Priority 3: First valid <h2>/<h3> heading before a section label ────
    if (!resolvedTitle && doc) {
      for (const el of doc.querySelectorAll('h2, h3')) {
        const cleaned = el.textContent.trim();
        if (cleaned) {
          titleCandidates.push(`[${el.tagName.toLowerCase()}] ${cleaned}`);
          if (!originalTitleCandidate) originalTitleCandidate = cleaned;
          if (!isBadCandidate(cleaned) && isSubstantialTitle(cleaned)) {
            resolvedTitle = cleaned;
            titleSource   = 'topHeading';
            console.debug(`[Stepper] resolveArticleTitle: accepted ${el.tagName} → "${cleaned}"`);
            break;
          }
          // If we hit a known section label, stop scanning — the title must come before it
          if (isBadCandidate(cleaned) && !TEMPLATE_BANNER_RE.test(cleaned) && !UI_NOISE_RE.test(cleaned)) {
            console.debug(`[Stepper] resolveArticleTitle: stopped h2/h3 scan at section label "${cleaned}"`);
            break;
          }
          console.debug(`[Stepper] resolveArticleTitle: rejected ${el.tagName} ("${cleaned}")`);
        }
      }
    }

    // ── Priority 4: First <strong>/<b> that IS the entire parent paragraph ──
    if (!resolvedTitle && doc) {
      const boldEl = doc.querySelector('strong, b');
      if (boldEl) {
        const boldText   = boldEl.textContent.trim();
        const parentEl   = boldEl.parentElement;
        const parentText = parentEl ? parentEl.textContent.trim() : boldText;
        const inHeading  = parentEl && /^H[1-6]$/.test(parentEl.tagName);
        if (boldText) {
          titleCandidates.push(`[strong] ${boldText}`);
          if (!originalTitleCandidate) originalTitleCandidate = boldText;
          if (parentText === boldText && !inHeading &&
              !isBadCandidate(boldText) && isSubstantialTitle(boldText)) {
            resolvedTitle = boldText;
            titleSource   = 'strong';
            console.debug(`[Stepper] resolveArticleTitle: accepted strong/b → "${boldText}"`);
          } else {
            console.debug(`[Stepper] resolveArticleTitle: rejected strong/b ("${boldText}")`);
          }
        }
      }
    }

    // ── Priority 5: First meaningful line in body ───────────────────────────
    if (!resolvedTitle && doc) {
      const body = doc.body || doc.documentElement;
      if (body) {
        for (const el of body.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) {
          const text = el.textContent.trim();
          if (text) {
            titleCandidates.push(`[${el.tagName.toLowerCase()}:first_line] ${text.substring(0, this.DEBUG_TITLE_PREVIEW_LENGTH)}`);
            if (!originalTitleCandidate) originalTitleCandidate = text;
            if (!isBadCandidate(text) && isSubstantialTitle(text)) {
              resolvedTitle = text.length > this.MAX_TITLE_LENGTH_FROM_FIRST_LINE
                ? text.substring(0, this.MAX_TITLE_LENGTH_FROM_FIRST_LINE)
                : text;
              titleSource   = 'first_line';
              console.debug(`[Stepper] resolveArticleTitle: accepted first_line (${el.tagName}) → "${resolvedTitle}"`);
              break;
            }
          }
        }
      }
    }

    // ── Priority 6: Fallback title (e.g. filename without extension) ────────
    if (!resolvedTitle && fallbackTitle) {
      const cleaned = cleanCandidate(fallbackTitle);
      if (cleaned) {
        titleCandidates.push(`[filename] ${cleaned}`);
        if (!originalTitleCandidate) originalTitleCandidate = cleaned;
        resolvedTitle = cleaned;
        titleSource   = 'filename';
        console.debug(`[Stepper] resolveArticleTitle: using filename fallback → "${cleaned}"`);
      }
    }

    // ── Priority 7: Final fallback ───────────────────────────────────────────
    if (!resolvedTitle) {
      resolvedTitle = 'Untitled article';
      titleSource   = 'fallback';
      console.debug('[Stepper] resolveArticleTitle: using "Untitled article" fallback');
    }

    console.debug(
      `[Stepper] resolveArticleTitle: final title="${resolvedTitle}" | source=${titleSource} | candidates=${titleCandidates.length}`
    );

    return {
      title: resolvedTitle,
      originalTitle: originalTitleCandidate,
      originalTitleCandidate,
      titleSource,
      titleCandidates
    };
  },

  /**
   * Get all articles, optionally filtering by settings
   * @param {boolean} respectSettings - If true, filter out dummy articles based on settings
   * @returns {Promise<Array>} Array of articles
   */
  async getAllArticles(respectSettings = true) {
    try {
      const articles = await Storage.getArticles();
      
      if (!respectSettings) {
        return articles;
      }
      
      const settings = await Storage.getSettings();
      
      // Filter out dummy articles if disabled
      if (!settings.enableDummyArticles) {
        return articles.filter(article => article.source !== 'dummy');
      }
      
      return articles;
    } catch (error) {
      console.error('Error getting all articles:', error);
      return [];
    }
  },

  /**
   * Get article by ID
   * @param {string} id - Article ID
   * @returns {Promise<Object|null>} Article object or null
   */
  async getArticleById(id) {
    try {
      const articles = await Storage.getArticles();
      return articles.find(article => article.id === id) || null;
    } catch (error) {
      console.error('Error getting article:', error);
      return null;
    }
  },

  /**
   * Save articles array (replaces entire collection)
   * @param {Array} articles - Array of article objects
   * @returns {Promise<boolean>} Success status
   */
  async saveArticles(articles) {
    try {
      if (!Array.isArray(articles)) {
        console.error('Articles must be an array');
        return false;
      }
      return await Storage.setArticles(articles);
    } catch (error) {
      console.error('Error saving articles:', error);
      return false;
    }
  },

  /**
   * Upsert an article (insert or update)
   * @param {Object} article - Article object
   * @returns {Promise<Object|null>} Saved article or null
   */
  async upsertArticle(article) {
    try {
      const articles = await Storage.getArticles();
      
      // Validate required fields
      if (!article.title) {
        throw new Error('Article title is required');
      }
      
      // Check if article exists
      const existingIndex = articles.findIndex(a => a.id === article.id);
      
      if (existingIndex !== -1) {
        // Update existing article
        articles[existingIndex] = {
          ...article,
          updatedAt: new Date().toISOString()
        };
      } else {
        // Insert new article
        const newArticle = {
          id: article.id || this.generateUUID(),
          title: article.title,
          summary: article.summary || '',
          introHtml: article.introHtml || '',
          relatedInfoHtml: article.relatedInfoHtml || '',
          tags: Array.isArray(article.tags) ? article.tags : [],
          estimatedMinutes: article.estimatedMinutes || null,
          steps: Array.isArray(article.steps) ? article.steps : [],
          source: article.source || 'uploaded',
          searchText: article.searchText || '',
          createdAt: article.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        articles.push(newArticle);
      }
      
      await Storage.setArticles(articles);
      return existingIndex !== -1 ? articles[existingIndex] : articles[articles.length - 1];
    } catch (error) {
      console.error('Error upserting article:', error);
      return null;
    }
  },

  /**
   * Delete article by ID
   * @param {string} id - Article ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteArticle(id) {
    try {
      const articles = await Storage.getArticles();
      const filteredArticles = articles.filter(article => article.id !== id);
      
      if (filteredArticles.length === articles.length) {
        console.warn('Article not found for deletion:', id);
        return false;
      }
      
      await Storage.setArticles(filteredArticles);
      return true;
    } catch (error) {
      console.error('Error deleting article:', error);
      return false;
    }
  },

  /**
   * Load dummy articles if enabled in settings and not already loaded
   * @returns {Promise<Object>} Status object indicating what happened
   */
  async loadDummyArticlesIfNeeded() {
    try {
      const settings = await Storage.getSettings();
      
      if (!settings.enableDummyArticles) {
        console.log('Dummy articles disabled in settings');
        return { loaded: false, reason: 'disabled' };
      }
      
      const articles = await Storage.getArticles();
      const hasDummyArticles = articles.some(a => a.source === 'dummy');
      
      if (hasDummyArticles) {
        console.log('Dummy articles already loaded');
        return { loaded: false, reason: 'already-loaded' };
      }
      
      console.log('Loading dummy articles...');
      const dummyArticles = this.createDummyArticles();
      
      for (const article of dummyArticles) {
        await this.upsertArticle(article);
      }
      
      console.log(`Loaded ${dummyArticles.length} dummy articles`);
      return { loaded: true, count: dummyArticles.length };
    } catch (error) {
      console.error('Error loading dummy articles:', error);
      return { loaded: false, reason: 'error', error };
    }
  },

  /**
   * Create realistic IT helpdesk dummy articles
   * @returns {Array} Array of dummy article objects
   */
  createDummyArticles() {
    const placeholder = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    
    return [
      {
        id: this.generateUUID(),
        title: 'Password Reset Procedure',
        summary: 'Step-by-step guide to reset user passwords in Active Directory',
        tags: ['password', 'active-directory', 'user-management'],
        estimatedMinutes: 5,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Verify User Identity',
            bodyHtml: '<p>Before resetting a password, verify the user\'s identity by:</p><ul><li>Asking for their employee ID</li><li>Confirming their department and manager</li><li>Checking their email address matches our records</li></ul>',
            images: []
          },
          {
            index: 2,
            title: 'Open Active Directory Users and Computers',
            bodyHtml: '<p>Launch Active Directory Users and Computers from the Administrative Tools.</p><img src="' + placeholder + '" alt="Active Directory Console" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Active Directory Console', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Locate User Account',
            bodyHtml: '<p>Use the search function (Ctrl+F) to find the user by:</p><ul><li>Username</li><li>Email address</li><li>Full name</li></ul>',
            images: []
          },
          {
            index: 4,
            title: 'Right-click and Select Reset Password',
            bodyHtml: '<p>Right-click on the user account and select "Reset Password" from the context menu.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Set Temporary Password',
            bodyHtml: '<p>Enter a secure temporary password following company policy:</p><ul><li>Minimum 12 characters</li><li>Mix of uppercase, lowercase, numbers, and symbols</li><li>Check "User must change password at next logon"</li></ul>',
            images: []
          },
          {
            index: 6,
            title: 'Communicate Password Securely',
            bodyHtml: '<p>Send the temporary password via secure channel (phone call or encrypted email). Never send via regular email or instant message.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'VPN Connection Issues Troubleshooting',
        summary: 'Diagnose and resolve common VPN connectivity problems',
        tags: ['vpn', 'network', 'connectivity', 'troubleshooting'],
        estimatedMinutes: 15,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Verify User Credentials',
            bodyHtml: '<p>Confirm the user is using correct credentials:</p><ul><li>Username format: DOMAIN\\username</li><li>Password is not expired</li><li>Account is not locked</li></ul>',
            images: []
          },
          {
            index: 2,
            title: 'Check VPN Client Version',
            bodyHtml: '<p>Ensure the VPN client is up to date. Current version should be 2.5.0 or higher.</p><img src="' + placeholder + '" alt="VPN Client Version" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'VPN Client Version', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Test Internet Connectivity',
            bodyHtml: '<p>Before troubleshooting VPN, verify basic internet connectivity by pinging google.com or another external site.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Check Firewall Settings',
            bodyHtml: '<p>Verify that Windows Firewall or antivirus is not blocking VPN traffic on ports 443 and 1194.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Clear VPN Cache',
            bodyHtml: '<p>Delete cached VPN profiles:</p><ol><li>Close VPN client</li><li>Navigate to C:\\Users\\[username]\\AppData\\Roaming\\VPNClient</li><li>Delete cache folder</li><li>Restart VPN client</li></ol>',
            images: []
          },
          {
            index: 6,
            title: 'Reinstall VPN Client',
            bodyHtml: '<p>If issues persist, uninstall and reinstall the VPN client from the company portal.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Check Server Status',
            bodyHtml: '<p>Verify VPN server status on the network monitoring dashboard. Contact network team if servers are down.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Printer Offline Troubleshooting',
        summary: 'Resolve network printer offline issues',
        tags: ['printer', 'hardware', 'network'],
        estimatedMinutes: 10,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Check Physical Connections',
            bodyHtml: '<p>Verify:</p><ul><li>Printer is powered on</li><li>Network cable is securely connected (for wired printers)</li><li>No error lights on printer display</li></ul>',
            images: []
          },
          {
            index: 2,
            title: 'Ping Printer IP Address',
            bodyHtml: '<p>Open Command Prompt and ping the printer\'s IP address to verify network connectivity.</p><img src="' + placeholder + '" alt="Ping Printer" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Ping Printer', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Restart Print Spooler Service',
            bodyHtml: '<p>Open Services (services.msc), find "Print Spooler", right-click and select Restart.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Check Printer Queue',
            bodyHtml: '<p>Open Devices and Printers, right-click the printer, and check for stuck print jobs. Delete any stuck jobs.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Update Printer Drivers',
            bodyHtml: '<p>Check if printer drivers are up to date. Download latest drivers from manufacturer website if needed.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Remove and Re-add Printer',
            bodyHtml: '<p>If issue persists, remove the printer from Devices and Printers and add it again using the IP address.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Test Print',
            bodyHtml: '<p>Print a test page to confirm the issue is resolved.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Outlook Search Not Working',
        summary: 'Fix Outlook search functionality issues',
        tags: ['outlook', 'email', 'search', 'office365'],
        estimatedMinutes: 8,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Check Indexing Status',
            bodyHtml: '<p>In Outlook, go to File > Options > Search > Indexing Options to check if Outlook data files are being indexed.</p><img src="' + placeholder + '" alt="Indexing Options" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Indexing Options', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 2,
            title: 'Rebuild Search Index',
            bodyHtml: '<p>In Indexing Options, click "Advanced", then click "Rebuild" button. This may take several hours for large mailboxes.</p>',
            images: []
          },
          {
            index: 3,
            title: 'Run Outlook in Safe Mode',
            bodyHtml: '<p>Close Outlook and start it in Safe Mode by holding Ctrl while launching. Test search functionality.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Disable Add-ins',
            bodyHtml: '<p>Some add-ins can interfere with search. Go to File > Options > Add-ins and disable non-essential add-ins.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Repair Office Installation',
            bodyHtml: '<p>Use Control Panel > Programs > Microsoft Office > Change > Quick Repair to repair the Office installation.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Microsoft Teams Audio Issues',
        summary: 'Troubleshoot microphone and speaker problems in Teams',
        tags: ['teams', 'audio', 'microphone', 'troubleshooting'],
        estimatedMinutes: 12,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Check Device Selection',
            bodyHtml: '<p>In Teams, click your profile picture > Settings > Devices and verify correct microphone and speakers are selected.</p><img src="' + placeholder + '" alt="Teams Audio Settings" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Teams Audio Settings', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 2,
            title: 'Test Audio Devices',
            bodyHtml: '<p>Use the "Make a test call" feature in Teams to verify your microphone and speakers are working.</p>',
            images: []
          },
          {
            index: 3,
            title: 'Check Windows Sound Settings',
            bodyHtml: '<p>Verify that the correct audio devices are set as default in Windows Sound settings (right-click speaker icon in taskbar).</p>',
            images: []
          },
          {
            index: 4,
            title: 'Update Audio Drivers',
            bodyHtml: '<p>Check Device Manager for audio driver updates. Update to the latest version from manufacturer website.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Check Permissions',
            bodyHtml: '<p>Ensure Teams has permission to access microphone: Windows Settings > Privacy > Microphone > Allow apps to access microphone.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Disable Audio Enhancements',
            bodyHtml: '<p>In Windows Sound settings, disable audio enhancements which can cause issues with Teams.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Clear Teams Cache',
            bodyHtml: '<p>Close Teams completely, delete cache folder at %appdata%\\Microsoft\\Teams, then restart Teams.</p>',
            images: []
          },
          {
            index: 8,
            title: 'Reinstall Teams',
            bodyHtml: '<p>If issues persist, uninstall and reinstall Teams from the company portal.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Wi-Fi Connection Drops Frequently',
        summary: 'Diagnose and fix intermittent wireless connection issues',
        tags: ['wifi', 'network', 'wireless', 'connectivity'],
        estimatedMinutes: 20,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Check Signal Strength',
            bodyHtml: '<p>Verify Wi-Fi signal strength is adequate. Move closer to access point if signal is weak.</p>',
            images: []
          },
          {
            index: 2,
            title: 'Forget and Reconnect to Network',
            bodyHtml: '<p>In Windows Settings > Network & Internet > Wi-Fi, forget the network and reconnect using credentials.</p><img src="' + placeholder + '" alt="Wi-Fi Settings" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Wi-Fi Settings', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Update Wireless Adapter Driver',
            bodyHtml: '<p>Open Device Manager, find Network adapters, right-click wireless adapter and select "Update driver".</p>',
            images: []
          },
          {
            index: 4,
            title: 'Disable Power Saving Mode',
            bodyHtml: '<p>In Device Manager, open wireless adapter properties > Power Management and uncheck "Allow computer to turn off this device to save power".</p>',
            images: []
          },
          {
            index: 5,
            title: 'Change Wi-Fi Channel',
            bodyHtml: '<p>Access router settings and try changing to a less congested Wi-Fi channel (1, 6, or 11 for 2.4GHz).</p>',
            images: []
          },
          {
            index: 6,
            title: 'Reset Network Settings',
            bodyHtml: '<p>Run Command Prompt as administrator and execute: netsh winsock reset, netsh int ip reset, ipconfig /flushdns</p>',
            images: []
          },
          {
            index: 7,
            title: 'Check for Interference',
            bodyHtml: '<p>Move away from potential sources of interference like microwaves, cordless phones, or other electronic devices.</p>',
            images: []
          },
          {
            index: 8,
            title: 'Test with Different Access Point',
            bodyHtml: '<p>If possible, test connection with a different access point to isolate if issue is with the client or infrastructure.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'BitLocker Recovery Key Access',
        summary: 'Retrieve and use BitLocker recovery keys',
        tags: ['bitlocker', 'encryption', 'security', 'recovery'],
        estimatedMinutes: 7,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Identify Drive Needing Recovery',
            bodyHtml: '<p>Note the drive identifier shown on the BitLocker recovery screen (usually the first 8 characters).</p><img src="' + placeholder + '" alt="BitLocker Recovery Screen" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'BitLocker Recovery Screen', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 2,
            title: 'Access Active Directory',
            bodyHtml: '<p>Log into Active Directory Users and Computers with appropriate permissions.</p>',
            images: []
          },
          {
            index: 3,
            title: 'Locate Computer Object',
            bodyHtml: '<p>Search for the computer object in Active Directory by hostname or computer name.</p>',
            images: []
          },
          {
            index: 4,
            title: 'View BitLocker Recovery Information',
            bodyHtml: '<p>Right-click computer object > Properties > BitLocker Recovery tab to view recovery keys.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Provide Recovery Key to User',
            bodyHtml: '<p>Read out the 48-digit recovery key to the user. Have them enter it on the BitLocker recovery screen.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Verify Successful Boot',
            bodyHtml: '<p>After entering the key, the system should boot normally. Advise user to back up important data.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Document the Incident',
            bodyHtml: '<p>Log the recovery key access in the ticketing system for audit purposes.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Multi-Factor Authentication (MFA) Reset',
        summary: 'Reset MFA settings for users who lost their device',
        tags: ['mfa', 'authentication', 'security', 'azure'],
        estimatedMinutes: 6,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Verify User Identity',
            bodyHtml: '<p>Confirm identity through multiple verification methods before resetting MFA.</p>',
            images: []
          },
          {
            index: 2,
            title: 'Log into Azure AD Portal',
            bodyHtml: '<p>Navigate to portal.azure.com and sign in with admin credentials.</p><img src="' + placeholder + '" alt="Azure AD Portal" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Azure AD Portal', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Navigate to Users',
            bodyHtml: '<p>Go to Azure Active Directory > Users and search for the affected user.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Access Authentication Methods',
            bodyHtml: '<p>Click on the user, then select "Authentication methods" from the left menu.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Reset MFA',
            bodyHtml: '<p>Click "Require re-register multi-factor authentication" and confirm the action.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Notify User',
            bodyHtml: '<p>Inform the user they will be prompted to set up MFA on their next login. Provide instructions for MFA setup.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Shared Mailbox Access Configuration',
        summary: 'Grant and configure access to shared mailboxes in Outlook',
        tags: ['outlook', 'shared-mailbox', 'email', 'permissions'],
        estimatedMinutes: 8,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Verify Permission Requirements',
            bodyHtml: '<p>Confirm what level of access is needed: Full Access, Send As, or Send on Behalf.</p>',
            images: []
          },
          {
            index: 2,
            title: 'Access Exchange Admin Center',
            bodyHtml: '<p>Navigate to admin.exchange.microsoft.com and sign in with admin credentials.</p><img src="' + placeholder + '" alt="Exchange Admin Center" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Exchange Admin Center', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Navigate to Shared Mailboxes',
            bodyHtml: '<p>Go to Recipients > Mailboxes and filter for shared mailboxes.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Edit Mailbox Permissions',
            bodyHtml: '<p>Select the shared mailbox, click "Manage mailbox delegation" and add the user with appropriate permissions.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Wait for Replication',
            bodyHtml: '<p>Permission changes may take up to 30 minutes to replicate across Exchange servers.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Add Mailbox in Outlook',
            bodyHtml: '<p>Instruct user to add the shared mailbox in Outlook: File > Account Settings > Account Settings > Change > More Settings > Advanced > Add</p>',
            images: []
          },
          {
            index: 7,
            title: 'Verify Access',
            bodyHtml: '<p>Confirm the user can see and access the shared mailbox in their Outlook client.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Slow Computer Performance Troubleshooting',
        summary: 'Diagnose and resolve slow PC performance issues',
        tags: ['performance', 'windows', 'troubleshooting', 'optimization'],
        estimatedMinutes: 25,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Check Task Manager',
            bodyHtml: '<p>Open Task Manager (Ctrl+Shift+Esc) and check CPU, Memory, and Disk usage to identify bottlenecks.</p><img src="' + placeholder + '" alt="Task Manager" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Task Manager', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 2,
            title: 'Identify Resource-Heavy Processes',
            bodyHtml: '<p>Sort processes by CPU and Memory usage to identify applications consuming excessive resources.</p>',
            images: []
          },
          {
            index: 3,
            title: 'Check for Malware',
            bodyHtml: '<p>Run a full system scan using Windows Defender or corporate antivirus software.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Disable Startup Programs',
            bodyHtml: '<p>In Task Manager > Startup tab, disable unnecessary programs from starting automatically.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Check Disk Space',
            bodyHtml: '<p>Verify the system drive has at least 10% free space. Use Disk Cleanup to free up space if needed.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Run Disk Defragmentation',
            bodyHtml: '<p>For HDD drives, run defragmentation. For SSD drives, run TRIM optimization.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Update Windows',
            bodyHtml: '<p>Check for and install Windows updates: Settings > Update & Security > Windows Update.</p>',
            images: []
          },
          {
            index: 8,
            title: 'Update Drivers',
            bodyHtml: '<p>Check Device Manager for any devices with outdated or missing drivers.</p>',
            images: []
          },
          {
            index: 9,
            title: 'Adjust Visual Effects',
            bodyHtml: '<p>System Properties > Advanced > Performance Settings > Adjust for best performance (or custom).</p>',
            images: []
          },
          {
            index: 10,
            title: 'Check for Hardware Issues',
            bodyHtml: '<p>Run hardware diagnostics to check for failing RAM, hard drive, or other hardware issues.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Mapped Network Drive Missing',
        summary: 'Restore missing mapped network drives',
        tags: ['network', 'mapped-drive', 'file-sharing', 'windows'],
        estimatedMinutes: 10,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Verify Network Connectivity',
            bodyHtml: '<p>Ensure the computer is connected to the corporate network (on-site or via VPN).</p>',
            images: []
          },
          {
            index: 2,
            title: 'Check If Drive Is Disconnected',
            bodyHtml: '<p>Open File Explorer and check if the drive shows with a red X (disconnected).</p><img src="' + placeholder + '" alt="Disconnected Network Drive" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Disconnected Network Drive', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Try to Reconnect',
            bodyHtml: '<p>Double-click the disconnected drive in File Explorer to attempt automatic reconnection.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Verify UNC Path Accessibility',
            bodyHtml: '<p>Open Run (Win+R) and try accessing the UNC path directly (e.g., \\\\server\\share).</p>',
            images: []
          },
          {
            index: 5,
            title: 'Check Credentials',
            bodyHtml: '<p>If prompted, enter network credentials. Ensure using correct domain\\username format.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Remap the Drive',
            bodyHtml: '<p>If drive is missing entirely, remap it: File Explorer > This PC > Map network drive, enter drive letter and UNC path.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Enable Reconnect at Logon',
            bodyHtml: '<p>When mapping, ensure "Reconnect at sign-in" checkbox is enabled.</p>',
            images: []
          },
          {
            index: 8,
            title: 'Use Group Policy If Available',
            bodyHtml: '<p>Contact IT Admin to check if drive mapping via Group Policy is configured for the user.</p>',
            images: []
          },
          {
            index: 9,
            title: 'Verify Permissions',
            bodyHtml: '<p>Ensure the user has appropriate permissions to access the network share.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Microsoft Edge Browser Issues',
        summary: 'Troubleshoot common Microsoft Edge problems',
        tags: ['edge', 'browser', 'web', 'troubleshooting'],
        estimatedMinutes: 12,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Clear Browser Cache and Cookies',
            bodyHtml: '<p>Press Ctrl+Shift+Delete, select "All time" and clear browsing data including cached images and cookies.</p><img src="' + placeholder + '" alt="Clear Browsing Data" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Clear Browsing Data', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 2,
            title: 'Disable Extensions',
            bodyHtml: '<p>Navigate to edge://extensions/ and disable all extensions to test if one is causing issues.</p>',
            images: []
          },
          {
            index: 3,
            title: 'Reset Browser Settings',
            bodyHtml: '<p>Go to Settings > Reset settings > Restore settings to their default values.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Update Edge',
            bodyHtml: '<p>Navigate to edge://settings/help to check for and install updates.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Run as Administrator',
            bodyHtml: '<p>Right-click Edge shortcut and select "Run as administrator" to test if it\'s a permissions issue.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Check for Conflicting Software',
            bodyHtml: '<p>Some antivirus or security software can interfere with browsers. Temporarily disable to test.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Create New User Profile',
            bodyHtml: '<p>Create a new browser profile: Settings > Profiles > Add profile to test if profile is corrupted.</p>',
            images: []
          },
          {
            index: 8,
            title: 'Repair or Reinstall Edge',
            bodyHtml: '<p>Use Settings > Apps > Microsoft Edge > Modify > Repair. If that fails, reinstall Edge.</p>',
            images: []
          }
        ]
      },
      {
        id: this.generateUUID(),
        title: 'Mobile Device Not Receiving Work Email',
        summary: 'Troubleshoot mobile email sync issues for Exchange/Office 365',
        tags: ['mobile', 'email', 'exchange', 'activesync'],
        estimatedMinutes: 15,
        source: 'dummy',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [
          {
            index: 1,
            title: 'Verify Mobile Data/Wi-Fi Connection',
            bodyHtml: '<p>Ensure the device has active internet connectivity via Wi-Fi or mobile data.</p>',
            images: []
          },
          {
            index: 2,
            title: 'Check Account Settings',
            bodyHtml: '<p>Verify email account settings are correct: server address, username, and password.</p><img src="' + placeholder + '" alt="Mobile Email Settings" style="max-width: 100%; margin: 10px 0;" />',
            images: [{ alt: 'Mobile Email Settings', dataUrlOrRemoteUrl: placeholder }]
          },
          {
            index: 3,
            title: 'Check ActiveSync Status',
            bodyHtml: '<p>Log into Exchange Admin Center and verify the user\'s device is listed under ActiveSync devices.</p>',
            images: []
          },
          {
            index: 4,
            title: 'Remove and Re-add Account',
            bodyHtml: '<p>Remove the email account from the mobile device and add it again using the correct settings.</p>',
            images: []
          },
          {
            index: 5,
            title: 'Check for Device Blocks',
            bodyHtml: '<p>In Exchange Admin Center, check if the device is blocked or quarantined by ActiveSync policies.</p>',
            images: []
          },
          {
            index: 6,
            title: 'Verify Mailbox Access',
            bodyHtml: '<p>Ensure the user mailbox is active and not disabled or locked.</p>',
            images: []
          },
          {
            index: 7,
            title: 'Check Storage Space',
            bodyHtml: '<p>Verify the mobile device has sufficient storage space for email data.</p>',
            images: []
          },
          {
            index: 8,
            title: 'Update Mobile OS and Email App',
            bodyHtml: '<p>Ensure the device OS and email app are updated to the latest versions.</p>',
            images: []
          },
          {
            index: 9,
            title: 'Test with Outlook Mobile App',
            bodyHtml: '<p>If using native mail app, try installing and configuring Microsoft Outlook mobile app.</p>',
            images: []
          }
        ]
      }
    ];
  },

  /**
   * Import article from file
   * @param {File} file - File object (.md, .html, .htm, .txt, .json, .docx, .doc)
   * @returns {Promise<Object>} Result object with ok status and message or error details
   */
  async importArticleFile(file) {
    const fileName = file.name;
    const fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
    
    try {
      const fileType = fileName.split('.').pop().toLowerCase();
      
      let parseResult;
      
      // Handle DOCX files differently (need ArrayBuffer)
      if (fileType === 'docx' || fileType === 'doc') {
        parseResult = await this.parseDocxArticle(file, fileNameWithoutExt);
      } else {
        let content;
        try {
          content = await file.text();
        } catch (readError) {
          return {
            ok: false,
            errorCode: 'FILE_READ_ERROR',
            message: `Failed to read file: ${fileName}`,
            details: readError.message,
            fileName: fileName
          };
        }
        
        switch (fileType) {
          case 'json':
            parseResult = this.parseJsonArticle(content, fileNameWithoutExt);
            break;
          case 'md':
            parseResult = this.parseMarkdownArticle(content, fileNameWithoutExt);
            break;
          case 'txt':
            // NOTE: .txt files are now treated as plain text (not markdown)
            // This is a change from previous behavior where .txt was parsed as markdown
            parseResult = this.parseTxtArticle(content, fileNameWithoutExt);
            break;
          case 'html':
          case 'htm':
            parseResult = this.parseHtmlArticle(content, fileNameWithoutExt);
            break;
          default:
            return {
              ok: false,
              errorCode: 'UNSUPPORTED_FILE_TYPE',
              message: `Unsupported file type: .${fileType}`,
              details: `Supported formats: .json, .md, .html, .htm, .txt, .docx, .doc`,
              fileName: fileName
            };
        }
      }
      
      // Check parse result
      if (!parseResult.ok) {
        return {
          ...parseResult,
          fileName: fileName
        };
      }
      
      const article = parseResult.article;
      
      // Ensure source is 'uploaded'
      article.source = 'uploaded';
      
      // Upsert the article
      let savedArticle;
      try {
        savedArticle = await this.upsertArticle(article);
      } catch (saveError) {
        console.error('Error saving article:', saveError);
        return {
          ok: false,
          errorCode: 'SAVE_ERROR',
          message: 'Failed to save article to storage',
          details: saveError.message,
          fileName: fileName
        };
      }
      
      if (savedArticle) {
        return {
          ok: true,
          message: `Successfully imported: ${article.title}`,
          article: savedArticle,
          fileName: fileName
        };
      } else {
        return {
          ok: false,
          errorCode: 'SAVE_ERROR',
          message: 'Failed to save article to storage',
          details: 'upsertArticle returned null',
          fileName: fileName
        };
      }
      
    } catch (error) {
      console.error('Error importing article:', error);
      return {
        ok: false,
        errorCode: 'UNEXPECTED_ERROR',
        message: `Unexpected error importing ${fileName}`,
        details: error.message,
        stack: error.stack,
        fileName: fileName
      };
    }
  },

  /**
   * Parse JSON article
   * @param {string} content - JSON content
   * @param {string} fallbackTitle - Fallback title if parsing fails
   * @returns {Object} Result with ok status and article or error details
   */
  parseJsonArticle(content, fallbackTitle) {
    try {
      let data;
      try {
        data = JSON.parse(content);
      } catch (jsonError) {
        return {
          ok: false,
          errorCode: 'JSON_PARSE_ERROR',
          message: 'Invalid JSON format',
          details: jsonError.message
        };
      }
      
      // Validate required fields
      if (!data.title) {
        return {
          ok: false,
          errorCode: 'MISSING_REQUIRED_FIELD',
          message: 'JSON must contain a "title" field',
          details: 'Required field: title'
        };
      }
      
      // Validate steps if present
      let steps = [];
      if (Array.isArray(data.steps)) {
        steps = data.steps;
        // If steps array is empty, create fallback
        if (steps.length === 0) {
          steps = [{
            index: 1,
            title: 'Procedure',
            bodyHtml: '<p>No steps provided in JSON.</p>',
            images: []
          }];
        }
      } else {
        // No steps provided, create fallback
        steps = [{
          index: 1,
          title: 'Procedure',
          bodyHtml: '<p>No steps provided in JSON.</p>',
          images: []
        }];
      }
      
      return {
        ok: true,
        article: {
          id: data.id || this.generateUUID(),
          title: data.title,
          summary: data.summary || '',
          tags: Array.isArray(data.tags) ? data.tags : [],
          estimatedMinutes: data.estimatedMinutes || null,
          steps: steps,
          source: 'uploaded',
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error parsing JSON article:', error);
      return {
        ok: false,
        errorCode: 'JSON_PARSE_UNEXPECTED_ERROR',
        message: 'Unexpected error parsing JSON',
        details: error.message
      };
    }
  },

  /**
   * Parse Markdown article using the ingestion pipeline.
   * Conventions: First line # Title; the parser-strategy pipeline handles step extraction.
   * @param {string} content - Markdown content
   * @param {string} fallbackTitle - Fallback title if parsing fails
   * @returns {Object} Result with ok status and article or error details
   */
  parseMarkdownArticle(content, fallbackTitle) {
    try {
      const lines = content.split('\n');
      let title = '';
      let originalTitle = '';
      let titleSource = 'fallback';

      // Parse title from first # heading, remove it from body lines
      const h1Idx = lines.findIndex(l => /^#\s+/.test(l.trim()));
      let bodyLines;
      if (h1Idx >= 0) {
        title = lines[h1Idx].trim().replace(/^#+\s*/, '');
        originalTitle = title;
        titleSource = 'h1';
        bodyLines = lines.filter((_, i) => i !== h1Idx);
      } else {
        title = fallbackTitle || 'Untitled article';
        titleSource = fallbackTitle ? 'filename' : 'fallback';
        bodyLines = lines;
      }

      // Convert body to HTML and parse into DOM for the ingestion pipeline
      const bodyHtml = this.markdownToHtml(bodyLines.join('\n'));
      const parser = new DOMParser();
      const doc = parser.parseFromString(bodyHtml, 'text/html');

      // Run the shared ingestion pipeline (normalise → strategy-select → parse)
      const { steps, parserMeta, normalizedArticle } = Ingestion.ingest(doc, 'uploaded', title);

      // Derive summary: prefer intro section text, fall back to first paragraph
      let summary = '';
      if (normalizedArticle.introHtml) {
        summary = this.stripHtmlTags(normalizedArticle.introHtml).substring(0, 300).trim();
      }
      if (!summary) {
        const firstP = doc.querySelector('p');
        if (firstP) summary = firstP.textContent.trim();
      }

      console.log(`[Stepper] Article imported (markdown): title="${title}" | titleSource=${titleSource} | steps=${steps.length}`);

      const articleData = {
        id: this.generateUUID(),
        title,
        originalTitle,
        titleSource,
        summary,
        introHtml:       normalizedArticle.introHtml       || '',
        relatedInfoHtml: normalizedArticle.relatedInfoHtml || '',
        tags:            normalizedArticle.tags.length > 0  ? normalizedArticle.tags : [],
        estimatedMinutes: null,
        steps,
        parserMeta,
        source: 'uploaded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      articleData.searchText = this.buildSearchText(articleData);

      return { ok: true, article: articleData };
    } catch (error) {
      console.error('Error parsing Markdown article:', error);
      return {
        ok: false,
        errorCode: 'MARKDOWN_PARSE_ERROR',
        message: 'Failed to parse Markdown content',
        details: error.message
      };
    }
  },

  /**
   * Parse plain text article
   * Treats entire content as a single step, escapes HTML, converts newlines to <br>
   * @param {string} content - Plain text content
   * @param {string} fallbackTitle - Fallback title (filename without extension)
   * @returns {Object} Result with ok status and article or error details
   */
  parseTxtArticle(content, fallbackTitle) {
    try {
      // Use first line as title if it's short, otherwise use fallback
      const lines = content.split('\n');
      let title = fallbackTitle || 'Untitled article';
      let originalTitle = '';
      let titleSource = fallbackTitle ? 'filename' : 'fallback';
      let bodyContent = content;
      
      // If first line is short (< MAX_TITLE_LENGTH_FROM_FIRST_LINE chars), use it as title
      if (lines.length > 0) {
        const firstLineTrimmed = lines[0].trim();
        if (firstLineTrimmed.length > 0 && 
            firstLineTrimmed.length < this.MAX_TITLE_LENGTH_FROM_FIRST_LINE) {
          title = firstLineTrimmed;
          originalTitle = firstLineTrimmed;
          titleSource = 'first_line';
          bodyContent = lines.slice(1).join('\n').trim();
        }
      }
      
      // Escape HTML and convert newlines to <br>
      const escapedContent = this.escapeHtml(bodyContent || content);
      const bodyHtml = escapedContent.replace(/\n/g, '<br>');

      console.log(`[Stepper] Article imported (txt): title="${title}" | titleSource=${titleSource}`);
      
      return {
        ok: true,
        article: {
          id: this.generateUUID(),
          title: title,
          originalTitle,
          titleSource,
          summary: '',
          tags: [],
          estimatedMinutes: null,
          steps: [{
            index: 1,
            title: 'Procedure',
            bodyHtml: bodyHtml,
            images: []
          }],
          source: 'uploaded',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error parsing text article:', error);
      return {
        ok: false,
        errorCode: 'TEXT_PARSE_ERROR',
        message: 'Failed to parse text content',
        details: error.message
      };
    }
  },

  /**
   * Parse HTML article using the ingestion pipeline.
   * Conventions: <h1> as title; the parser-strategy pipeline handles step extraction.
   * @param {string} content - HTML content
   * @param {string} fallbackTitle - Fallback title if parsing fails
   * @returns {Object} Result with ok status and article or error details
   */
  parseHtmlArticle(content, fallbackTitle) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/html');
      
      // Resolve title using shared helper (finds h1, then strong, then first line)
      const { title, originalTitle, originalTitleCandidate, titleSource, titleCandidates } =
        this.resolveArticleTitle(null, doc, fallbackTitle);

      // Remove the element that was used as the title to avoid including it in step content
      if (titleSource === 'h1') {
        const h1 = doc.querySelector('h1');
        if (h1 && h1.textContent.trim() === title) h1.remove();
      } else if (titleSource === 'topHeading') {
        const body = doc.body || doc.documentElement;
        if (body) {
          for (const el of body.querySelectorAll('h2, h3')) {
            if (el.textContent.trim() === title) { el.remove(); break; }
          }
        }
      }

      // Run the shared ingestion pipeline (normalise → strategy-select → parse)
      const { steps, parserMeta, normalizedArticle } = Ingestion.ingest(doc, 'uploaded', title);

      // Derive summary: prefer intro section text, fall back to first paragraph
      let summary = '';
      if (normalizedArticle.introHtml) {
        summary = this.stripHtmlTags(normalizedArticle.introHtml).substring(0, 300).trim();
      }
      if (!summary) {
        const firstP = doc.querySelector('p');
        if (firstP) {
          const firstH2 = doc.querySelector('h2');
          if (!firstH2 || this.isBefore(firstP, firstH2)) {
            summary = firstP.textContent.trim();
          }
        }
      }

      console.log(`[Stepper] Article imported (html): title="${title}" | titleSource=${titleSource} | steps=${steps.length}`);

      const articleData = {
        id: this.generateUUID(),
        title,
        originalTitle,
        originalTitleCandidate,
        titleSource,
        titleCandidates,
        summary,
        introHtml:       normalizedArticle.introHtml       || '',
        relatedInfoHtml: normalizedArticle.relatedInfoHtml || '',
        tags:            normalizedArticle.tags.length > 0  ? normalizedArticle.tags : [],
        estimatedMinutes: null,
        steps,
        parserMeta,
        source: 'uploaded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      articleData.searchText = this.buildSearchText(articleData);

      return { ok: true, article: articleData };
    } catch (error) {
      console.error('Error parsing HTML article:', error);
      return {
        ok: false,
        errorCode: 'HTML_PARSE_ERROR',
        message: 'Failed to parse HTML content',
        details: error.message
      };
    }
  },

  /**
   * Parse DOCX article using Mammoth
   * @param {File} file - DOCX file
   * @param {string} fallbackTitle - Fallback title (filename without extension)
   * @returns {Promise<Object>} Result with ok status and article or error details
   */
  async parseDocxArticle(file, fallbackTitle) {
    try {
      // Check if mammoth is available
      if (typeof mammoth === 'undefined') {
        console.error('Mammoth library not loaded');
        return {
          ok: false,
          errorCode: 'DOCX_LIBRARY_NOT_AVAILABLE',
          message: 'DOCX parsing library not available',
          details: 'Mammoth.js library is not loaded. Please check that the vendor file is properly included.'
        };
      }

      // Read file as ArrayBuffer
      let arrayBuffer;
      try {
        arrayBuffer = await file.arrayBuffer();
      } catch (readError) {
        return {
          ok: false,
          errorCode: 'DOCX_READ_ERROR',
          message: 'Failed to read DOCX file',
          details: readError.message
        };
      }

      // Convert DOCX to HTML using Mammoth
      let result;
      try {
        result = await mammoth.convertToHtml(
          { arrayBuffer: arrayBuffer },
          {
            convertImage: mammoth.images.imgElement(function(image) {
              return image.read("base64").then(function(imageBuffer) {
                return {
                  src: "data:" + image.contentType + ";base64," + imageBuffer
                };
              });
            })
          }
        );
      } catch (convertError) {
        return {
          ok: false,
          errorCode: 'DOCX_CONVERSION_ERROR',
          message: 'Failed to convert DOCX to HTML',
          details: convertError.message
        };
      }

      const htmlContent = result.value;
      
      // Parse the HTML content
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, 'text/html');

      // Resolve title using shared helper — prevents section headings (e.g. "Procedure",
      // "General info", "Audience") from being mistaken for the article title.
      const { title, originalTitle, originalTitleCandidate, titleSource, titleCandidates } =
        this.resolveArticleTitle(null, doc, fallbackTitle);

      // Remove the element that was used as the title from the document to avoid
      // it appearing again inside step content.
      if (titleSource === 'h1') {
        const h1 = doc.querySelector('h1');
        if (h1) h1.remove();
      } else if (titleSource === 'topHeading') {
        // Scan h2/h3 elements for the one matching the resolved title and remove it
        const body = doc.body || doc.documentElement;
        if (body) {
          for (const el of body.querySelectorAll('h2, h3')) {
            if (el.textContent.trim() === title) {
              el.remove();
              break;
            }
          }
        }
      } else if (titleSource === 'strong') {
        const boldEl = doc.querySelector('strong, b');
        if (boldEl && boldEl.textContent.trim() === title) {
          const parent = boldEl.parentElement;
          // Remove the whole parent paragraph if it is just the bold title
          if (parent && parent.textContent.trim() === title) {
            parent.remove();
          } else {
            boldEl.remove();
          }
        }
      } else if (titleSource === 'first_line') {
        const body = doc.body || doc.documentElement;
        if (body) {
          for (const el of body.querySelectorAll('p, h2, h3, h4, h5, h6')) {
            const text = el.textContent.trim();
            // Match exact title text, or handle the case where title was truncated
            // to MAX_TITLE_LENGTH_FROM_FIRST_LINE chars and text starts with it.
            if (text === title || (title.length === this.MAX_TITLE_LENGTH_FROM_FIRST_LINE && text.startsWith(title))) {
              el.remove();
              break;
            }
          }
        }
      }

      // Run the shared ingestion pipeline (normalise → strategy-select → parse)
      const { steps, parserMeta, normalizedArticle } = Ingestion.ingest(doc, 'uploaded', title);

      // Derive summary: prefer intro section text, fall back to first paragraph
      let summary = '';
      if (normalizedArticle.introHtml) {
        summary = this.stripHtmlTags(normalizedArticle.introHtml).substring(0, 300).trim();
      }
      if (!summary) {
        const summaryParagraph = doc.querySelector('p');
        if (summaryParagraph) {
          const firstH2 = doc.querySelector('h2');
          if (!firstH2 || this.isBefore(summaryParagraph, firstH2)) {
            summary = summaryParagraph.textContent.trim();
          }
        }
      }

      console.log(`[Stepper] Article imported (docx): title="${title}" | titleSource=${titleSource} | steps=${steps.length}`);

      const articleData = {
        id: this.generateUUID(),
        title,
        originalTitle,
        originalTitleCandidate,
        titleSource,
        titleCandidates,
        summary,
        introHtml:       normalizedArticle.introHtml       || '',
        relatedInfoHtml: normalizedArticle.relatedInfoHtml || '',
        tags:            normalizedArticle.tags.length > 0  ? normalizedArticle.tags : [],
        estimatedMinutes: null,
        steps,
        parserMeta,
        source: 'uploaded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      articleData.searchText = this.buildSearchText(articleData);

      return { ok: true, article: articleData };
    } catch (error) {
      console.error('Error parsing DOCX article:', error);
      return {
        ok: false,
        errorCode: 'DOCX_PARSE_ERROR',
        message: 'Unexpected error parsing DOCX',
        details: error.message
      };
    }
  },

  /**
   * Normalize a ServiceNow article Document by removing UI chrome and noise.
   * Delegates to ArticleNormalizer.normalizeServiceNowDoc() (canonical impl in normalizer.js).
   * @param {Document} doc - Parsed HTML document (mutated in-place)
   * @returns {Document} The same document, normalised
   */
  normalizeServiceNowDoc(doc) {
    return ArticleNormalizer.normalizeServiceNowDoc(doc);
  },

  /**
   * Sanitize HTML content to remove dangerous elements and attributes.
   * Delegates to ArticleNormalizer.sanitizeHtmlContent() (canonical impl in normalizer.js).
   * @param {Element} element - DOM element to sanitize
   * @returns {Element} Sanitized element
   */
  sanitizeHtmlContent(element) {
    return ArticleNormalizer.sanitizeHtmlContent(element);
  },

  /**
   * Escape HTML entities to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Validate and sanitize image URL.
   * Delegates to ArticleNormalizer.sanitizeImageUrl() (canonical impl in normalizer.js).
   * @param {string} url - Image URL
   * @returns {string|null} Sanitized URL or null if invalid
   */
  sanitizeImageUrl(url) {
    return ArticleNormalizer.sanitizeImageUrl(url);
  },

  /**
   * Normalize a title string for fuzzy duplicate comparison.
   *
   * Transformations applied (in order):
   *   1. Lowercase
   *   2. Strip leading step-number tokens: "STEP 1:", "Step 2 –", "STEP 1"
   *   3. Replace colons and dashes with a single space
   *   4. Collapse repeated whitespace
   *   5. Trim
   *
   * @param {string} str - Raw title or body text
   * @returns {string} Normalised string ready for comparison
   */
  normalizeTitleForComparison(str) {
    return String(str || '')
      .toLowerCase()
      .replace(this.TITLE_STEP_TOKEN_RE, '') // strip leading step-number tokens
      .replace(/[:\-–]/g, ' ')               // punctuation → space
      .replace(/\s+/g, ' ')                  // collapse whitespace
      .trim();
  },

  /**
   * Strip the promoted step title from the beginning of a body container element.
   *
   * When a title has been extracted ("promoted") from the first bold / heading
   * lines of a step body and stored as step.title, those same lines must be
   * removed from the body so they do not render twice.
   *
   * The comparison is intentionally fuzzy to handle common document patterns:
   *   - Exact duplicate          → "Delete delivery" vs <p><strong>Delete delivery</strong></p>
   *   - Multi-paragraph heading  → title spans two consecutive <p> elements
   *   - Trailing artifact digit  → "…VAT1" (title) vs "…VAT" (body), where the "1"
   *                                was an artifact of the extraction step
   *
   * Only the FIRST 1–3 consecutive meaningful block elements are inspected.
   * Content further into the body is never touched.
   *
   * @param {string}  stepTitle  - The resolved step title (may include "Step N:" prefix)
   * @param {Element} container  - The DOM element whose leading children will be stripped
   */
  stripPromotedTitleFromBody(stepTitle, container) {
    if (!stepTitle || !container) return;

    const normTitle = this.normalizeTitleForComparison(stepTitle);
    if (!normTitle) return;

    // Meaningful block element tags (inline elements, <br>, etc. are skipped)
    const blockTags = this.HEADING_BLOCK_TAGS;

    // Collect the first up to 3 consecutive meaningful block elements
    const leadingEls = [];
    for (const el of Array.from(container.children)) {
      if (leadingEls.length >= 3) break;
      if (blockTags.has(el.tagName)) {
        leadingEls.push(el);
      } else {
        break; // non-block element interrupts the heading run
      }
    }

    if (leadingEls.length === 0) return;

    // Pre-compute the title with trailing artifact digits stripped.
    // "…VAT1" becomes "…VAT" so it can match "…VAT" in the body.
    const normTitleStripped = normTitle.replace(/\s*\d+\s*$/, '').trim();

    // Try subsets of increasing size: [1 element], [2 elements], [3 elements]
    for (let count = 1; count <= leadingEls.length; count++) {
      const subset = leadingEls.slice(0, count);
      const combinedText = subset.map(el => el.textContent).join(' ');
      const normCombined = this.normalizeTitleForComparison(combinedText);

      if (!normCombined) continue;

      // Primary: exact match after normalization
      if (normCombined === normTitle) {
        subset.forEach(el => el.remove());
        return;
      }

      // Fuzzy: also strip trailing artifact digits from the combined text
      const normCombinedStripped = normCombined.replace(/\s*\d+\s*$/, '').trim();
      if (normTitleStripped && normCombinedStripped &&
          normTitleStripped === normCombinedStripped) {
        subset.forEach(el => el.remove());
        return;
      }
    }
  },

  /**
   * Convert markdown to HTML (simple implementation)
   * @param {string} markdown - Markdown content
   * @returns {string} HTML content
   */
  markdownToHtml(markdown) {
    const lines = markdown.split('\n');
    let listType = null; // 'ul' or 'ol'
    const processedLines = [];
    
    for (let line of lines) {
      const trimmed = line.trim();
      
      // Handle headings
      if (trimmed.startsWith('### ')) {
        if (listType) { processedLines.push(`</${listType}>`); listType = null; }
        processedLines.push(`<h3>${this.processInlineMarkdown(trimmed.substring(4))}</h3>`);
        continue;
      }
      if (trimmed.startsWith('## ')) {
        if (listType) { processedLines.push(`</${listType}>`); listType = null; }
        processedLines.push(`<h2>${this.processInlineMarkdown(trimmed.substring(3))}</h2>`);
        continue;
      }
      if (trimmed.startsWith('# ')) {
        if (listType) { processedLines.push(`</${listType}>`); listType = null; }
        processedLines.push(`<h1>${this.processInlineMarkdown(trimmed.substring(2))}</h1>`);
        continue;
      }
      
      // Handle unordered list items (- or *)
      if (trimmed.match(/^[-*]\s+/)) {
        if (listType !== 'ul') {
          if (listType) processedLines.push(`</${listType}>`);
          processedLines.push('<ul>');
          listType = 'ul';
        }
        const content = this.processInlineMarkdown(trimmed.substring(2));
        processedLines.push(`<li>${content}</li>`);
        continue;
      }
      
      // Handle ordered list items (1. 2. etc.)
      const orderedMatch = trimmed.match(/^\d+\.\s+(.+)/);
      if (orderedMatch) {
        if (listType !== 'ol') {
          if (listType) processedLines.push(`</${listType}>`);
          processedLines.push('<ol>');
          listType = 'ol';
        }
        const content = this.processInlineMarkdown(orderedMatch[1]);
        processedLines.push(`<li>${content}</li>`);
        continue;
      }
      
      // Close list if needed
      if (listType) {
        processedLines.push(`</${listType}>`);
        listType = null;
      }
      
      // Process line
      if (trimmed) {
        const processed = this.processInlineMarkdown(trimmed);
        processedLines.push(`<p>${processed}</p>`);
      }
    }
    
    // Close list if still open
    if (listType) {
      processedLines.push(`</${listType}>`);
    }
    
    return processedLines.join('\n');
  },

  /**
   * Process inline markdown (bold, italic, code, images)
   * Processes in order and escapes remaining text
   * @param {string} text - Text to process
   * @returns {string} Processed HTML
   */
  processInlineMarkdown(text) {
    let result = text;
    
    // Handle images: ![alt](url)
    result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
      const sanitizedUrl = this.sanitizeImageUrl(url);
      if (sanitizedUrl) {
        const escapedAlt = this.escapeHtml(alt);
        const escapedUrl = this.escapeHtml(sanitizedUrl);
        return `<img src="${escapedUrl}" alt="${escapedAlt}" style="max-width: 100%; margin: 10px 0;" />`;
      } else {
        console.warn(`Local image file cannot be imported: ${url}`);
        const escapedUrl = this.escapeHtml(url);
        return `<em>[Image: ${escapedUrl} - must be data URL]</em>`;
      }
    });
    
    // Bold: **text** or __text__
    result = result.replace(/\*\*([^\*]+)\*\*/g, (match, text) => {
      return `<strong>${this.escapeHtml(text)}</strong>`;
    });
    result = result.replace(/__([^_]+)__/g, (match, text) => {
      return `<strong>${this.escapeHtml(text)}</strong>`;
    });
    
    // Italic: *text* or _text_
    result = result.replace(/\*([^\*]+)\*/g, (match, text) => {
      return `<em>${this.escapeHtml(text)}</em>`;
    });
    result = result.replace(/_([^_]+)_/g, (match, text) => {
      return `<em>${this.escapeHtml(text)}</em>`;
    });
    
    // Code: `code`
    result = result.replace(/`([^`]+)`/g, (match, code) => {
      return `<code>${this.escapeHtml(code)}</code>`;
    });
    
    // Now escape any remaining text that's not in HTML tags
    // Split by HTML tags and escape text portions
    const parts = result.split(/(<[^>]+>)/);
    result = parts.map(part => {
      // If it's an HTML tag, keep it
      if (part.startsWith('<') && part.endsWith('>')) {
        return part;
      }
      // Otherwise, escape it
      return this.escapeHtml(part);
    }).join('');
    
    return result;
  },

  /**
   * Check if element1 appears before element2 in DOM
   * @param {Element} el1 - First element
   * @param {Element} el2 - Second element
   * @returns {boolean} True if el1 comes before el2
   */
  isBefore(el1, el2) {
    return !!(el2.compareDocumentPosition(el1) & Node.DOCUMENT_POSITION_PRECEDING);
  },

  /**
   * Segment HTML content into steps based on "Step N:" markers and substeps
   * Implements ServiceNow-style KB step segmentation
   * @param {Document} doc - Parsed HTML document
   * @returns {Array<Object>} Array of step objects with title, bodyHtml, images
   */
  segmentIntoSteps(doc) {
    const steps = [];
    const body = doc.body;
    if (!body) return steps;
    
    // Constants
    const MAX_LABEL_LENGTH = 50;
    const LABEL_TRUNCATE_LENGTH = MAX_LABEL_LENGTH - 3; // Account for "..."
    
    // Action verbs for detecting action-oriented paragraphs
    const ACTION_VERBS = [
      'Open', 'Click', 'Select', 'Scroll', 'Paste', 'Type', 'Ensure', 
      'Highlight', 'Enter', 'Press', 'Navigate', 'Access', 'Create', 
      'Delete', 'Edit', 'Update', 'Choose', 'Pick', 'Set', 'Configure', 
      'Enable', 'Disable', 'Install', 'Uninstall', 'Download', 'Upload', 
      'Import', 'Export', 'Copy', 'Move', 'Drag', 'Drop', 'Check', 
      'Uncheck', 'Mark', 'Unmark', 'Fill', 'Complete', 'Submit', 'Save', 
      'Cancel', 'Close', 'Expand', 'Collapse', 'View', 'Review', 'Verify', 
      'Confirm', 'Approve', 'Reject'
    ];
    
    // Helper: Truncate text for label display
    const truncateLabel = (text) => {
      return text.length > MAX_LABEL_LENGTH ? text.substring(0, LABEL_TRUNCATE_LENGTH) + '...' : text;
    };
    
    // Helper: Check if text matches a step marker pattern:
    // "Step N: Title", "Step N – Title", "Step N - Title", "STEP N" (standalone), "Step N" (standalone)
    const isStepMarker = (text) => {
      return /^(?:Step|STEP)\s+\d+\s*(?:[:\-–].+|$)/i.test(text);
    };
    
    // Helper: Extract step number and title from step marker text.
    // Returns { number, title } where title may be null when the marker is standalone
    // (e.g. "STEP 1" without a descriptive title — title is then extracted from body).
    const parseStepMarker = (text) => {
      // Full format: "Step N: Title", "Step N – Title", "Step N - Title"
      const fullMatch = text.match(/^(?:Step|STEP)\s+(\d+)\s*[:\-–]\s*(.+)$/i);
      if (fullMatch) {
        return { number: parseInt(fullMatch[1]), title: fullMatch[2].trim() };
      }
      // Standalone format: "STEP N" or "Step N" with no trailing title text
      const standaloneMatch = text.match(/^(?:STEP|Step)\s+(\d+)\s*$/i);
      if (standaloneMatch) {
        return { number: parseInt(standaloneMatch[1]), title: null };
      }
      return null;
    };

    // Helper: Return true if text is a generic step label with no meaningful title
    // (e.g. "STEP", "Step", "STEP 1", "Step 2") that should be stripped from body content.
    const isGenericStepLabel = (text) => {
      return /^(?:STEP|Step)\s*\d*\s*$/.test(text.trim());
    };
    
    // Helper: Check if element is a chapter/section heading (not a step)
    // Only applied to actual heading elements (H1-H6), not to paragraphs,
    // to avoid false-positives on numbered action items like "1. Open the page..."
    const isChapterHeading = (node, text) => {
      if (!/^H[1-6]$/.test(node.tagName)) return false;
      return /^Chapter\s+\d+(\s*:|$)/i.test(text) ||
             /^\d+\.\s/.test(text); // "1. Section title" style numbered headings
    };
    
    // Helper: Check if element or text starts with action verbs
    const isActionParagraph = (text) => {
      const trimmed = text.trim();
      // Build regex from action verbs list
      const singleWordVerbs = new RegExp(`^(${ACTION_VERBS.join('|')})\\s+`, 'i');
      // Multi-word action phrases
      const multiWordPhrases = /^(Go\s+to)\s+/i;
      return singleWordVerbs.test(trimmed) || multiWordPhrases.test(trimmed);
    };
    
    // Helper: Check if text starts with "Note:"
    const isNote = (text) => {
      return /^Note:\s*/i.test(text.trim());
    };
    
    // Helper: Check if text is a numbered/lettered list item (e.g. "1. xxx", "1) xxx", "a) xxx")
    // These should become individual substeps rather than being attached to a previous substep
    const isNumberedItem = (text) => {
      return /^\d+[.)]\s+\S/.test(text.trim()) || /^[a-z][)]\s+\S/i.test(text.trim());
    };
    
    // Helper: Extract images from an element — delegates to the shared helper
    // in ArticleNormalizer so all sources use the same universal extraction logic.
    const extractImages = (element) => ArticleNormalizer.extractImages(element);
    
    // Helper: Create step object
    const createStep = (stepNumber, primaryTitle, substepLabel, content, images) => {
      let title;
      if (substepLabel) {
        // Substep: "Step N – Primary / Substep" or "Step N.k ..."
        title = `Step ${stepNumber} – ${primaryTitle} / ${substepLabel}`;
      } else {
        // Primary step without substeps
        title = `Step ${stepNumber}: ${primaryTitle}`;
      }
      
      return {
        title: title,
        bodyHtml: content,
        images: images
      };
    };
    
    // Collect all nodes in order
    const nodes = Array.from(body.childNodes);
    let primarySteps = [];
    let currentPrimary = null;
    
    // Phase 1: Group nodes into primary step blocks
    for (let node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      
      const text = node.textContent.trim();
      
      // Check for "Step N:" marker in paragraph or heading
      let stepInfo = null;
      if (node.tagName === 'P' || node.tagName.match(/^H[1-6]$/)) {
        stepInfo = parseStepMarker(text);
      }
      
      if (stepInfo) {
        // Start new primary step
        if (currentPrimary) {
          primarySteps.push(currentPrimary);
        }
        currentPrimary = {
          number: stepInfo.number,
          title: stepInfo.title,
          nodes: []
        };
      } else if (isChapterHeading(node, text)) {
        // Chapter/section heading (e.g. "3. Related information") ends the current
        // step block so that content from subsequent sections (Related info, etc.)
        // is not appended to the last procedure step.
        if (currentPrimary) {
          primarySteps.push(currentPrimary);
          currentPrimary = null;
        }
      } else if (currentPrimary) {
        // Add node content to current primary step
        currentPrimary.nodes.push(node);
      }
    }
    
    // Add last primary step
    if (currentPrimary) {
      primarySteps.push(currentPrimary);
    }
    
    // Phase 2: Combine all nodes for each primary step into a single Step object.
    // Substeps (lists, action paragraphs, numbered items) are preserved as-is inside
    // bodyHtml so they render as bullets/paragraphs within the step — not split into
    // separate Step objects.
    for (let primary of primarySteps) {
      const allContent = document.createElement('div');
      primary.nodes.forEach(node => allContent.appendChild(node.cloneNode(true)));

      // ── Normalise title and deduplicate body ────────────────────────────────
      let effectiveTitle = primary.title;

      // Strip any leading generic step-label elements from body
      // (e.g. "<p>STEP</p>", "<p>STEP 1</p>" that duplicate the step-label indicator).
      let firstChild = allContent.firstElementChild;
      while (firstChild && isGenericStepLabel(firstChild.textContent.trim())) {
        firstChild.remove();
        firstChild = allContent.firstElementChild;
      }

      // When the marker had no inline title (standalone "STEP N"), extract the
      // title from the first body element, then remove it from the body so it
      // does not appear twice in the rendered output.
      if (!effectiveTitle) {
        firstChild = allContent.firstElementChild;
        if (firstChild) {
          const firstText = firstChild.textContent.trim();
          if (firstText && firstText.length <= MAX_LABEL_LENGTH) {
            effectiveTitle = firstText;
            firstChild.remove();
          }
        }
      }

      // When the inline title is just the generic word "STEP" / "Step" (no number,
      // no description), it is a placeholder label rather than a meaningful title.
      // Promote the first body element as the real title so that documents structured
      // as "Step 1: STEP / Create the order / Instructions" produce the title
      // "Create the order" rather than the unhelpful "STEP".
      // Use the first sentence (split on sentence-ending punctuation) to keep the title concise.
      if (effectiveTitle && /^(?:STEP|Step)\s*$/.test(effectiveTitle)) {
        firstChild = allContent.firstElementChild;
        if (firstChild) {
          const fullText = firstChild.textContent.trim();
          const firstSentence = fullText.replace(/\s+/g, ' ')
            .split(/[.!?](?:\s|$)/)[0].trim();
          const titleCandidate = firstSentence.length > MAX_LABEL_LENGTH
            ? firstSentence.substring(0, MAX_LABEL_LENGTH)
            : firstSentence;
          if (titleCandidate && !isGenericStepLabel(titleCandidate)) {
            effectiveTitle = titleCandidate;
            firstChild.remove();
          }
        }
      }

      // Strip leading body elements that duplicate the effective title.
      // Uses fuzzy normalization to handle multi-paragraph headings, colon
      // variants, and trailing artifact digits (e.g. "VAT1" vs "VAT").
      if (effectiveTitle) {
        this.stripPromotedTitleFromBody(effectiveTitle, allContent);
      }

      // Safety fallback: use generic step label when no title could be resolved.
      if (!effectiveTitle) {
        effectiveTitle = `Step ${primary.number}`;
      }

      const images = extractImages(allContent);
      const sanitized = this.sanitizeHtmlContent(allContent);

      steps.push({
        title: `Step ${primary.number}: ${effectiveTitle}`,
        displayNumber: primary.number,
        bodyHtml: sanitized.innerHTML,
        images: images
      });
    }

    // Phase 1.5: No "Step N:" markers found — try section-aware extraction.
    // Handles: numbered paragraphs, ordered lists, procedural tables, and
    // articles with explicit Procedure/Instructions section headings.
    if (steps.length === 0) {
      const altSteps = this._extractSectionAwareSteps(body, nodes);
      altSteps.forEach(s => steps.push(s));
    }

    return steps;
  },

  /**
   * Get content between current heading and next heading
   * @param {Element} heading - Heading element
   * @returns {Element} Div containing content
   */
  getContentUntilNextHeading(heading) {
    const container = document.createElement('div');
    let sibling = heading.nextElementSibling;
    
    while (sibling && !sibling.matches('h1, h2, h3, h4, h5, h6')) {
      container.appendChild(sibling.cloneNode(true));
      sibling = sibling.nextElementSibling;
    }
    
    return container;
  },

  // ─── Universal section-heading classifiers ────────────────────────────────
  // These detect recurring structural traits common across large KB collections
  // so that parsers can decide which sections produce steps, which are intro
  // content, and which should be ignored entirely.
  //
  // The canonical implementations live in ArticleNormalizer (normalizer.js).
  // These methods are kept here as convenience delegates for backward
  // compatibility with any code that calls this.isSkipSectionHeading() etc.

  /**
   * Return true when the heading text identifies a section that must NOT
   * produce procedure steps: Related Information, Change Log, Revision History,
   * Appendix, etc.
   * @param {string} text - Section heading text (trimmed)
   * @returns {boolean}
   */
  isSkipSectionHeading(text) {
    return ArticleNormalizer.isSkipSectionHeading(text);
  },

  /**
   * Return true when the heading text identifies a procedure/instructions section.
   * @param {string} text - Section heading text (trimmed)
   * @returns {boolean}
   */
  isProcedureSectionHeading(text) {
    return ArticleNormalizer.isProcedureSectionHeading(text);
  },

  /**
   * Return true when the heading text identifies an intro/general-info section.
   * @param {string} text - Section heading text (trimmed)
   * @returns {boolean}
   */
  isIntroSectionHeading(text) {
    return ArticleNormalizer.isIntroSectionHeading(text);
  },

  /**
   * Return true when the heading text identifies a keywords/tags section.
   * @param {string} text - Section heading text (trimmed)
   * @returns {boolean}
   */
  isTagsSectionHeading(text) {
    return ArticleNormalizer.isTagsSectionHeading(text);
  },

  // ─── Universal step extraction helpers ───────────────────────────────────

  /**
   * Extract steps from a procedural HTML table.
   * Detects tables with column headers like Step / Action / Description / Details
   * and converts data rows into step objects.
   * @param {Element} table - HTML table element
   * @param {number} startIndex - Starting step number (1-based)
   * @returns {Array<Object>} Step objects {title, bodyHtml, images}; empty if not procedural
   */
  extractTableSteps(table, startIndex) {
    const steps = [];
    if (!table || table.tagName !== 'TABLE') return steps;

    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) return steps;

    // Prefer thead row; fall back to first tr
    const headerRow = table.querySelector('thead tr') || rows[0];
    const headers = Array.from(headerRow.querySelectorAll('th, td'))
      .map(cell => cell.textContent.trim().toLowerCase());

    const STEP_COL  = /^(?:step|no\.?|#|nr\.?|step\s*#)$/i;
    const ACTION_COL = /^(?:action|instruction|task|description|details?|procedure|what\s+to\s+do|activity)$/i;
    const NOTE_COL   = /^(?:note|notes|warning|tip|important|remark|comment)$/i;
    const IMAGE_COL  = /^(?:image|screenshot|figure|visual|img|illustration)$/i;

    const actionColIdx = headers.findIndex(h => ACTION_COL.test(h));
    const stepColIdx   = headers.findIndex(h => STEP_COL.test(h));

    // Table is procedural only if it has an action column or a step number column
    if (actionColIdx < 0 && stepColIdx < 0) return steps;

    const noteColIdx = headers.findIndex(h => NOTE_COL.test(h));
    const mainColIdx = actionColIdx >= 0 ? actionColIdx : 0;

    // Data rows: skip thead rows
    const dataRows = table.querySelector('thead')
      ? Array.from(table.querySelectorAll('tbody tr'))
      : rows.slice(1);

    let stepNum = startIndex || 1;
    let lastStep = null;

    for (const row of dataRows) {
      const cells = Array.from(row.querySelectorAll('td, th'));
      if (cells.length === 0) continue;
      if (cells.every(c => c.tagName === 'TH')) continue;

      const mainCell = cells[mainColIdx];
      if (!mainCell) continue;

      const mainText = mainCell.textContent.trim();
      if (!mainText) continue;

      // Note/warning rows: attach to the previous step body
      if (/^(?:Note|Warning|Important|Tip)[!:]/i.test(mainText) && lastStep) {
        lastStep.bodyHtml += `<p class="step-note">${mainCell.innerHTML}</p>`;
        continue;
      }

      // Extract images from all cells in the row (modifies cell DOM in-place)
      // so that bodyParts built below captures the sanitized src values.
      const images = [];
      cells.forEach(cell => {
        ArticleNormalizer.extractImages(cell).forEach(img => images.push(img));
      });

      // Build body HTML: main cell + any additional detail/note columns
      // (captured after image extraction so src values are already sanitized)
      const bodyParts = [mainCell.innerHTML];
      cells.forEach((cell, idx) => {
        if (idx === mainColIdx || idx === stepColIdx) return;
        const cellText = cell.textContent.trim();
        if (!cellText) return;
        const header = headers[idx] || '';
        if (NOTE_COL.test(header)) {
          bodyParts.push(`<p class="step-note"><strong>Note:</strong> ${cell.innerHTML}</p>`);
        } else if (!IMAGE_COL.test(header)) {
          bodyParts.push(cell.innerHTML);
        }
      });

      // Determine step title
      let stepTitle;
      if (stepColIdx >= 0 && cells[stepColIdx]) {
        const stepCellText = cells[stepColIdx].textContent.trim();
        if (/^\d+$/.test(stepCellText)) {
          // Step column has only a number — derive a meaningful title from the
          // action column content instead of using the generic "Step N" label.
          const firstSentence = mainText.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/)[0].trim();
          stepTitle = firstSentence.length > 80 ? firstSentence.substring(0, 80) : firstSentence;
          stepNum = parseInt(stepCellText, 10) + 1;
        } else if (stepCellText) {
          stepTitle = stepCellText;
          stepNum++;
        } else {
          stepTitle = `Step ${stepNum++}`;
        }
      } else {
        const firstSentence = mainText.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/)[0].trim();
        stepTitle = firstSentence.length > 80 ? firstSentence.substring(0, 80) : firstSentence;
        stepNum++;
      }

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = bodyParts.join('\n');
      const sanitized = this.sanitizeHtmlContent(contentDiv);

      const step = { title: stepTitle, bodyHtml: sanitized.innerHTML, images };
      lastStep = step;
      steps.push(step);
    }

    return steps;
  },

  /**
   * Section-aware step extraction used when no "Step N:" markers are found.
   * Handles articles structured with:
   * - explicit Procedure/Instructions section headings
   * - numbered paragraphs  (1. Do this  /  1) Do this)
   * - ordered lists         (<ol><li>…</li></ol>)
   * - procedural tables     (Step / Action / Description columns)
   * - chapter headings that group steps (Chapter 1, Chapter 2 …)
   *
   * Search priority for step boundaries:
   *   1. Procedural tables inside the procedure section
   *   2. Ordered lists inside the procedure section
   *   3. Numbered paragraphs inside the procedure section
   *
   * @param {Element} body  - document.body element
   * @param {Array}   nodes - Array.from(body.childNodes)
   * @returns {Array<Object>} Steps {title, bodyHtml, images}
   */
  _extractSectionAwareSteps(body, nodes) {
    const steps = [];

    /** Maximum characters for a step title extracted from body content. */
    const MAX_STEP_TITLE_LENGTH = 80;

    // Pre-scan: does the document have an explicit Procedure-section heading?
    let hasProcedureSection = false;
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName.match(/^H[1-6]$/) && this.isProcedureSectionHeading(node.textContent.trim())) {
        hasProcedureSection = true;
        break;
      }
    }

    // If there is an explicit Procedure section, start NOT collecting and wait
    // for that heading.  If there is no such heading, collect from the start
    // (the whole document is treated as the procedure).
    let collecting = !hasProcedureSection;
    let globalStepNum = 1;
    let currentTitle = null;
    let currentDiv   = null;

    const flushCurrentStep = () => {
      if (!currentDiv) return;
      // Resolve title when it was deferred (standalone "STEP N" marker with no inline title).
      // Extract from the first non-generic body element, stripping generic labels first.
      if (!currentTitle) {
        // Strip leading generic "STEP" / "STEP N" labels
        let firstEl = currentDiv.firstElementChild;
        while (firstEl && /^(?:STEP|Step)\s*\d*\s*$/.test(firstEl.textContent.trim())) {
          firstEl.remove();
          firstEl = currentDiv.firstElementChild;
        }
        if (firstEl) {
          const firstText = firstEl.textContent.trim();
          if (firstText && firstText.length <= MAX_STEP_TITLE_LENGTH) {
            currentTitle = firstText;
            firstEl.remove();
          }
        }
        // Fallback: use step number stored on the container element
        if (!currentTitle) {
          const stepNum = currentDiv.dataset.stepNum || globalStepNum;
          currentTitle = `Step ${stepNum}`;
        }
      }
      if (!currentTitle) return;
      const images = ArticleNormalizer.extractImages(currentDiv);
      // Strip leading body elements that duplicate the resolved title.
      // Uses fuzzy normalization to handle multi-paragraph headings, colon
      // variants, and trailing artifact digits (e.g. "VAT1" vs "VAT").
      this.stripPromotedTitleFromBody(currentTitle, currentDiv);
      const sanitized = this.sanitizeHtmlContent(currentDiv);
      steps.push({ title: currentTitle, bodyHtml: sanitized.innerHTML, images });
      currentTitle = null;
      currentDiv   = null;
    };

    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const text = node.textContent.trim();

      // ── Section heading transitions ────────────────────────────────────────
      if (node.tagName.match(/^H[1-6]$/)) {
        if (this.isProcedureSectionHeading(text)) {
          flushCurrentStep();
          collecting = true;
          continue;
        }
        if (this.isSkipSectionHeading(text) || this.isTagsSectionHeading(text)) {
          flushCurrentStep();
          collecting = false;
          continue;
        }
        if (this.isIntroSectionHeading(text)) {
          flushCurrentStep();
          if (hasProcedureSection) collecting = false;
          continue;
        }
        // Chapter heading inside a collecting section: flush but keep collecting
        if (collecting && /^Chapter\s+\d+/i.test(text)) {
          flushCurrentStep();
          continue;
        }
      }

      if (!collecting) continue;

      // ── Procedural table ───────────────────────────────────────────────────
      if (node.tagName === 'TABLE') {
        const tableSteps = this.extractTableSteps(node, globalStepNum);
        if (tableSteps.length > 0) {
          flushCurrentStep();
          tableSteps.forEach(s => steps.push(s));
          globalStepNum += tableSteps.length;
          continue;
        }
        // Non-procedural table: keep as content inside current step (if any)
        if (currentDiv) currentDiv.appendChild(node.cloneNode(true));
        continue;
      }

      // ── Ordered list: each <li> becomes an individual step ─────────────────
      if (node.tagName === 'OL') {
        flushCurrentStep();
        Array.from(node.querySelectorAll('li')).forEach(li => {
          const liText = li.textContent.trim();
          const firstSentence = liText.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/)[0].trim();
          const liTitle = firstSentence.length > 80
            ? firstSentence.substring(0, 80)
            : firstSentence;
          const liDiv = document.createElement('div');
          liDiv.appendChild(li.cloneNode(true));
          const liImages = ArticleNormalizer.extractImages(liDiv);
          const sanitized = this.sanitizeHtmlContent(liDiv);
          steps.push({ title: liTitle, bodyHtml: sanitized.innerHTML, images: liImages });
          globalStepNum++;
        });
        continue;
      }

      // ── Standalone "STEP N" / "Step N" paragraph marker ─────────────────────
      // Handles documents where each step starts with a bare "STEP 1" / "Step 2"
      // line (no colon / no inline title). The title is extracted from the next
      // non-generic body element; generic "STEP"/"STEP N" labels are skipped.
      if (node.tagName === 'P' || node.tagName.match(/^H[1-6]$/)) {
        const stepNumMatch = text.match(/^(?:STEP|Step)\s+(\d+)\s*$/i);
        if (stepNumMatch) {
          flushCurrentStep();
          currentTitle = null; // will be set from the first following non-generic element
          currentDiv = document.createElement('div');
          // Store the extracted step number so the title placeholder can be resolved later.
          currentDiv.dataset.stepNum = stepNumMatch[1];
          globalStepNum = parseInt(stepNumMatch[1], 10);
          continue;
        }
      }

      // ── Numbered paragraph: "1. xxx" or "1) xxx" ──────────────────────────
      if (node.tagName === 'P') {
        const numberedMatch = text.match(/^(\d+)[.)]\s+(.+)/s);
        if (numberedMatch) {
          flushCurrentStep();
          const stepText = numberedMatch[2].trim();
          const firstLine = stepText.replace(/\s+/g, ' ').split(/[.!?](?:\s|$)/)[0].trim();
          currentTitle = firstLine.length > 80 ? firstLine.substring(0, 80) : firstLine;
          currentDiv = document.createElement('div');
          currentDiv.appendChild(node.cloneNode(true));
          globalStepNum++;
          continue;
        }
      }

      // ── Regular content: attach to the current step if one is open ─────────
      if (currentDiv) {
        currentDiv.appendChild(node.cloneNode(true));
      }
    }

    flushCurrentStep();
    return steps;
  },

  // ─── Search index helpers ─────────────────────────────────────────────────

  /**
   * Build a pre-computed, normalised search-text string for an article.
   * Aggregates title (double-weighted), step titles, step body text, summary,
   * intro HTML, and tags into a single lower-cased string for fast full-text
   * search without relying exclusively on tag matching.
   * @param {Object} articleData - Article data object
   * @returns {string} Normalised search text
   */
  buildSearchText(articleData) {
    const parts = [];

    // Title — double weight ensures strong title-match signal
    if (articleData.title) {
      parts.push(articleData.title);
      parts.push(articleData.title);
    }

    // Summary / intro
    if (articleData.summary) parts.push(articleData.summary);
    if (articleData.introHtml) parts.push(this.stripHtmlTags(articleData.introHtml));

    // Step titles and bodies
    if (Array.isArray(articleData.steps)) {
      articleData.steps.forEach(step => {
        if (step.title)       parts.push(step.title);
        if (step.bodyHtml)    parts.push(this.stripHtmlTags(step.bodyHtml));
        if (step.chapterTitle) parts.push(step.chapterTitle);
      });
    }

    // Tags — lowest weight, included once
    if (Array.isArray(articleData.tags)) {
      parts.push(articleData.tags.join(' '));
    }

    return parts
      .join(' ')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * Strip HTML tags and return plain text.
   * Delegates to ArticleNormalizer.stripHtmlTags() (canonical impl in normalizer.js).
   * @param {string} html
   * @returns {string} Plain text with collapsed whitespace
   */
  stripHtmlTags(html) {
    return ArticleNormalizer.stripHtmlTags(html);
  },

  /**
   * Clear all uploaded articles
   * @returns {Promise<Object>} Result with count of deleted articles
   */
  async clearUploadedArticles() {
    try {
      const articles = await Storage.getArticles();
      const uploadedArticles = articles.filter(a => a.source === 'uploaded');
      const otherArticles = articles.filter(a => a.source !== 'uploaded');
      
      await Storage.setArticles(otherArticles);
      
      return {
        success: true,
        count: uploadedArticles.length,
        message: `Deleted ${uploadedArticles.length} uploaded article(s)`
      };
    } catch (error) {
      console.error('Error clearing uploaded articles:', error);
      return {
        success: false,
        count: 0,
        message: `Error: ${error.message}`
      };
    }
  },

  /**
   * Get count of uploaded articles
   * @returns {Promise<number>} Count of uploaded articles
   */
  async getUploadedArticlesCount() {
    try {
      const articles = await Storage.getArticles();
      return articles.filter(a => a.source === 'uploaded').length;
    } catch (error) {
      console.error('Error getting uploaded articles count:', error);
      return 0;
    }
  },

  /**
   * Validate article object against schema
   * @param {Object} article - Article to validate
   * @returns {boolean} True if valid
   */
  validateArticle(article) {
    // Check required fields
    if (!article.title || typeof article.title !== 'string') {
      return false;
    }
    
    if (!Array.isArray(article.steps) || article.steps.length === 0) {
      return false;
    }
    
    // Validate each step
    for (const step of article.steps) {
      if (typeof step.index !== 'number' || 
          typeof step.title !== 'string' || 
          typeof step.bodyHtml !== 'string') {
        return false;
      }
      
      // Validate images array if present
      if (step.images && !Array.isArray(step.images)) {
        return false;
      }
    }
    
    return true;
  },

  /**
   * Sync articles from repository
   * @param {Object} settings - Settings object with repo configuration
   * @returns {Promise<Object>} Result object with success status and message
   */
  async syncFromRepo(settings) {
    try {
      let articles = [];
      
      // Fetch articles based on source type
      if (settings.repoSourceType === 'url' && settings.repoUrl) {
        articles = await this.fetchFromUrl(settings.repoUrl);
      } else if (settings.repoSourceType === 'azure' && settings.azureApiBaseUrl && settings.azurePat) {
        articles = await this.fetchFromAzure(settings.azureApiBaseUrl, settings.azurePat);
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
        
        if (!this.validateArticle(article)) {
          errors.push(`Article ${i + 1} failed validation`);
          continue;
        }
        
        // Ensure article has required metadata
        const processedArticle = {
          id: article.id || this.generateUUID(),
          title: article.title,
          summary: article.summary || '',
          introHtml: article.introHtml || '',
          relatedInfoHtml: article.relatedInfoHtml || '',
          tags: Array.isArray(article.tags) ? article.tags : [],
          estimatedMinutes: article.estimatedMinutes || null,
          steps: article.steps.map((step, index) => ({
            index: step.index !== undefined ? step.index : index + 1,
            title: step.title,
            bodyHtml: step.bodyHtml,
            images: Array.isArray(step.images) ? step.images.filter(img => {
              // Validate image URLs
              return img.dataUrlOrRemoteUrl && this.sanitizeImageUrl(img.dataUrlOrRemoteUrl);
            }) : []
          })),
          source: 'repo',
          createdAt: article.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        processedArticle.searchText = article.searchText || this.buildSearchText(processedArticle);
        
        validArticles.push(processedArticle);
      }
      
      if (validArticles.length === 0) {
        return {
          success: false,
          message: `Failed to sync: ${errors.length > 0 ? errors.join('; ') : 'No valid articles found'}`
        };
      }
      
      // Upsert articles (update existing or insert new based on ID)
      const existingArticles = await Storage.getArticles();
      const repoArticleIds = new Set(validArticles.map(a => a.id));
      
      // Remove old repo articles that are not in the new sync
      const nonRepoArticles = existingArticles.filter(a => a.source !== 'repo');
      
      // Combine non-repo articles with new repo articles
      const updatedArticles = [...nonRepoArticles, ...validArticles];
      
      await Storage.setArticles(updatedArticles);
      
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
  },

  /**
   * Fetch articles from URL repository
   * @param {string} url - Repository URL
   * @returns {Promise<Array>} Array of articles
   */
  async fetchFromUrl(url) {
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
      
      // Handle both direct array and wrapped responses
      return Array.isArray(data) ? data : (data.articles || []);
      
    } catch (error) {
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error('Network error: Unable to connect to repository. Please check your internet connection and URL.');
      }
      throw error;
    }
  },

  /**
   * Fetch articles from Azure DevOps
   * @param {string} baseUrl - Azure API base URL
   * @param {string} pat - Personal Access Token
   * @returns {Promise<Array>} Array of articles
   */
  async fetchFromAzure(baseUrl, pat) {
    try {
      // Create Basic auth header
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
      
      // Handle both direct array and wrapped responses
      return Array.isArray(data) ? data : (data.articles || []);
      
    } catch (error) {
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error('Network error: Unable to connect to Azure DevOps. Please check your internet connection and URL.');
      }
      throw error;
    }
  },

  /**
   * Import/upsert ServiceNow Knowledge articles into local storage.
   *
   * Each raw ServiceNow article is mapped into the extension Article schema
   * and run through the shared ingestion pipeline so it gets the same
   * step-by-step format as HTML/DOCX imports.
   *
   * Storage rules
   * • Upsert by remoteId (sys_id or kb_number) – repeated syncs update.
   * • Locally-uploaded articles are never touched.
   * • Articles present in the previous sync but absent now are marked stale=true
   *   rather than deleted (soft-delete; a hard-delete policy can be added later).
   *
   * @param {Array}  rawArticles  Array of raw ServiceNow article objects
   * @param {string} syncedAt     ISO timestamp of this sync run
   * @returns {Promise<{upserted:number, stale:number, errors:string[]}>}
   */
  async importServiceNowArticles(rawArticles, syncedAt) {
    const errors = [];
    const processed = [];
    const syncedRemoteIds = new Set();

    for (const raw of rawArticles) {
      try {
        // Resolve the best available identifier
        const remoteId = raw.sys_id || raw.kb_number || raw.number || null;

        // Build HTML body from available fields, prefer text_html / wiki / text
        const rawHtml =
          raw.text_html || raw.wiki || raw.text ||
          raw.description || raw.body || raw.content || '';

        // Parse into a DOM Document so resolveArticleTitle can inspect h1/content
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml || '', 'text/html');

        // Resolve the best available title using the priority chain.
        // raw fields take priority; doc content provides a fallback when all
        // API title fields are absent or contain only a section heading.
        const { title, originalTitle, originalTitleCandidate, titleSource, titleCandidates } =
          this.resolveArticleTitle(raw, doc, null);

        const { steps, parserMeta, normalizedArticle } = Ingestion.ingest(
          doc,
          'servicenow',
          title,
          (d) => this.normalizeServiceNowDoc(d)
        );

        // Merge tags: tags extracted by normalizer + explicit category/topic fields
        const snTags = raw.kb_category
          ? [raw.kb_category]
          : (raw.topic ? [raw.topic] : []);
        const tags = [
          ...new Set([...normalizedArticle.tags, ...snTags])
        ];

        // Determine parse status (best-effort; never blocks storage)
        const rawBodyLength = rawHtml.trim().length;
        const parseStatus =
          parserMeta && parserMeta.parserName !== 'fallbackSingleStepParser'
            ? 'parsed_structured'
            : rawBodyLength > 0
              ? 'parsed_fallback'
              : 'missing_content';

        console.log(`[Stepper] Article imported (servicenow): title="${title}" | titleSource=${titleSource} | steps=${steps.length} | parseStatus=${parseStatus}`);

        const article = {
          // Stable ID: reuse existing record if present, else create new UUID
          id: null,           // resolved below during upsert
          title,
          originalTitle,
          originalTitleCandidate,
          titleSource,
          titleCandidates,
          summary: raw.meta_description || raw.description || '',
          introHtml:       normalizedArticle.introHtml       || '',
          relatedInfoHtml: normalizedArticle.relatedInfoHtml || '',
          tags,
          estimatedMinutes: null,
          steps,
          parserMeta,
          parseStatus,
          source: 'servicenow',
          remoteId,
          syncedAt,
          stale: false,
          createdAt: raw.sys_created_on || syncedAt,
          updatedAt: syncedAt
        };
        article.searchText = this.buildSearchText(article);

        processed.push(article);
        if (remoteId) syncedRemoteIds.add(remoteId);
      } catch (err) {
        errors.push(`Failed to process article "${raw.short_description || raw.sys_id}": ${err.message}`);
      }
    }

    // Load existing articles from storage
    const allArticles = await Storage.getArticles();
    let upsertedCount = 0;

    // Build a map of remoteId → existing article for fast lookup
    const existingByRemoteId = new Map();
    for (const a of allArticles) {
      if (a.source === 'servicenow' && a.remoteId) {
        existingByRemoteId.set(a.remoteId, a);
      }
    }

    // Upsert processed articles
    const upsertedIds = new Set();
    for (const article of processed) {
      const existing = article.remoteId ? existingByRemoteId.get(article.remoteId) : null;
      if (existing) {
        // Update in-place
        article.id = existing.id;
        article.createdAt = existing.createdAt;
        const idx = allArticles.findIndex(a => a.id === existing.id);
        if (idx !== -1) allArticles[idx] = article;
      } else {
        article.id = this.generateUUID();
        allArticles.push(article);
      }
      upsertedIds.add(article.id);
      upsertedCount++;
    }

    // Mark previously-synced ServiceNow articles that are absent from this feed as stale
    let staleCount = 0;
    for (const a of allArticles) {
      if (
        a.source === 'servicenow' &&
        !upsertedIds.has(a.id) &&
        !a.stale
      ) {
        a.stale = true;
        staleCount++;
      }
    }

    await Storage.setArticles(allArticles);

    return { upserted: upsertedCount, stale: staleCount, errors };
  },

  /**
   * Return the count of ServiceNow articles in storage.
   * @returns {Promise<number>}
   */
  async getServiceNowArticlesCount() {
    try {
      const articles = await Storage.getArticles();
      return articles.filter(a => a.source === 'servicenow' && !a.stale).length;
    } catch {
      return 0;
    }
  },

  /**
   * Dev helper: Log step extraction info for debugging
   * Usage: Articles.logStepInfo(article)
   * @param {Object} article - Article object
   */
  logStepInfo(article) {
    console.group(`📄 Article: ${article.title}`);
    console.log(`Total Steps: ${article.steps.length}`);
    console.log(`Source: ${article.source}`);
    if (article.parserMeta) {
      console.log(`Parser: ${article.parserMeta.parserName} (score: ${article.parserMeta.parserScore})`);
      if (article.parserMeta.parsingWarnings && article.parserMeta.parsingWarnings.length > 0) {
        console.warn(`Warnings: ${article.parserMeta.parsingWarnings.join('; ')}`);
      }
    }
    console.log(`---`);
    
    article.steps.forEach((step, index) => {
      console.group(`Step ${index + 1}: ${step.title}`);
      console.log(`Index: ${step.index}`);
      console.log(`Images: ${step.images.length}`);
      console.log(`Body HTML length: ${step.bodyHtml.length} characters`);
      // For security reasons, we don't show HTML content previews in console
      // Use browser DevTools to inspect bodyHtml if needed
      console.log(`Body preview: [HTML content - ${step.bodyHtml.length} chars]`);
      console.groupEnd();
    });
    
    console.groupEnd();
  },

  /**
   * Internal debug helper for ServiceNow import (kept for backward compatibility).
   * New code should use Ingestion.logDebug() instead.
   * @param {string} title - Article title
   * @param {Document} doc - Normalised DOM document
   * @param {Array} steps - Segmented steps array
   */
  _logServiceNowImport(title, doc, steps) {
    // Detect whether a Procedure section heading was present in the document
    let procedureFound = false;
    if (doc && doc.querySelectorAll) {
      doc.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(el => {
        if (/procedure/i.test(el.textContent)) procedureFound = true;
      });
    }
    console.group(`🔄 ServiceNow Import: ${title}`);
    console.log(`Source: servicenow`);
    console.log(`Procedure section found: ${procedureFound}`);
    console.log(`Step count: ${steps.length}`);
    if (steps.length > 0) {
      console.log(`Step titles: ${steps.map(s => s.title).join(' | ')}`);
    }
    console.groupEnd();
  }
};

// Make it available globally
if (typeof window !== 'undefined') {
  window.Articles = Articles;
}
