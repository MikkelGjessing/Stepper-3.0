/**
 * Article CRUD operations and parsing
 * Manages article data structure and operations
 * 
 * Article Schema:
 * {
 *   id: string (UUID),
 *   title: string,
 *   summary: string,
 *   tags: string[],
 *   estimatedMinutes: number (optional),
 *   steps: Step[],
 *   source: "dummy" | "uploaded" | "repo",
 *   createdAt: string (ISO),
 *   updatedAt: string (ISO)
 * }
 * 
 * Step Schema:
 * {
 *   index: number,
 *   title: string,
 *   bodyHtml: string,
 *   images: Array<{ alt: string, dataUrlOrRemoteUrl: string }>
 * }
 */

const Articles = {
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
          tags: Array.isArray(article.tags) ? article.tags : [],
          estimatedMinutes: article.estimatedMinutes || null,
          steps: Array.isArray(article.steps) ? article.steps : [],
          source: article.source || 'uploaded',
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
   * @param {File} file - File object (.md, .html, .txt, .json)
   * @returns {Promise<Object>} Result object with success status and message
   */
  async importArticleFile(file) {
    try {
      const fileType = file.name.split('.').pop().toLowerCase();
      const content = await file.text();
      
      let article;
      
      switch (fileType) {
        case 'json':
          article = this.parseJsonArticle(content);
          break;
        case 'md':
        case 'txt':
          article = this.parseMarkdownArticle(content);
          break;
        case 'html':
          article = this.parseHtmlArticle(content);
          break;
        default:
          return {
            success: false,
            message: `Unsupported file type: .${fileType}`
          };
      }
      
      if (!article) {
        return {
          success: false,
          message: 'Failed to parse article content'
        };
      }
      
      // Ensure source is 'uploaded'
      article.source = 'uploaded';
      
      // Upsert the article
      const savedArticle = await this.upsertArticle(article);
      
      if (savedArticle) {
        return {
          success: true,
          message: `Successfully imported: ${article.title}`,
          article: savedArticle
        };
      } else {
        return {
          success: false,
          message: 'Failed to save article'
        };
      }
      
    } catch (error) {
      console.error('Error importing article:', error);
      return {
        success: false,
        message: `Import error: ${error.message}`
      };
    }
  },

  /**
   * Parse JSON article
   * @param {string} content - JSON content
   * @returns {Object|null} Parsed article
   */
  parseJsonArticle(content) {
    try {
      const data = JSON.parse(content);
      
      // Validate required fields
      if (!data.title) {
        throw new Error('JSON must contain a title field');
      }
      
      return {
        id: data.id || this.generateUUID(),
        title: data.title,
        summary: data.summary || '',
        tags: Array.isArray(data.tags) ? data.tags : [],
        estimatedMinutes: data.estimatedMinutes || null,
        steps: Array.isArray(data.steps) ? data.steps : [],
        source: 'uploaded',
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error parsing JSON article:', error);
      return null;
    }
  },

  /**
   * Parse Markdown article
   * Conventions: First line # Title, ## Step: ... creates steps
   * @param {string} content - Markdown content
   * @returns {Object|null} Parsed article
   */
  parseMarkdownArticle(content) {
    try {
      const lines = content.split('\n');
      let title = '';
      let summary = '';
      const steps = [];
      let currentStep = null;
      let currentStepContent = [];
      let inStepSection = false;
      let warnings = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Parse title (first # heading)
        if (!title && line.startsWith('# ')) {
          title = line.substring(2).trim();
          continue;
        }
        
        // Parse step headings (## Step: ...)
        if (line.match(/^##\s+Step:/i)) {
          // Save previous step if exists
          if (currentStep && currentStepContent.length > 0) {
            currentStep.bodyHtml = this.markdownToHtml(currentStepContent.join('\n'));
            steps.push(currentStep);
          }
          
          // Start new step
          const stepTitle = line.substring(2).replace(/^Step:\s*/i, '').trim();
          currentStep = {
            index: steps.length + 1,
            title: stepTitle,
            bodyHtml: '',
            images: []
          };
          currentStepContent = [];
          inStepSection = true;
          continue;
        }
        
        // Handle other ## headings as steps
        if (line.startsWith('## ')) {
          // Save previous step if exists
          if (currentStep && currentStepContent.length > 0) {
            currentStep.bodyHtml = this.markdownToHtml(currentStepContent.join('\n'));
            steps.push(currentStep);
          }
          
          // Start new step
          const stepTitle = line.substring(3).trim();
          currentStep = {
            index: steps.length + 1,
            title: stepTitle,
            bodyHtml: '',
            images: []
          };
          currentStepContent = [];
          inStepSection = true;
          continue;
        }
        
        // Collect content
        if (inStepSection && currentStep) {
          currentStepContent.push(line);
        } else if (!inStepSection && title && line) {
          // Content before first step becomes summary
          if (!summary) {
            summary = line;
          }
        }
      }
      
      // Save last step
      if (currentStep && currentStepContent.length > 0) {
        currentStep.bodyHtml = this.markdownToHtml(currentStepContent.join('\n'));
        steps.push(currentStep);
      }
      
      if (!title) {
        throw new Error('Markdown must contain a # Title heading');
      }
      
      return {
        id: this.generateUUID(),
        title: title,
        summary: summary,
        tags: [],
        estimatedMinutes: null,
        steps: steps,
        source: 'uploaded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error parsing Markdown article:', error);
      return null;
    }
  },

  /**
   * Parse HTML article
   * Conventions: <h1> as title, <h2> sections as steps
   * @param {string} content - HTML content
   * @returns {Object|null} Parsed article
   */
  parseHtmlArticle(content) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/html');
      
      // Get title from <h1>
      const h1 = doc.querySelector('h1');
      if (!h1) {
        throw new Error('HTML must contain an <h1> element for the title');
      }
      const title = h1.textContent.trim();
      
      // Get summary from first paragraph before first h2
      let summary = '';
      const firstP = doc.querySelector('p');
      if (firstP) {
        const firstH2 = doc.querySelector('h2');
        if (!firstH2 || this.isBefore(firstP, firstH2)) {
          summary = firstP.textContent.trim();
        }
      }
      
      // Parse steps from <h2> sections
      const h2Elements = doc.querySelectorAll('h2');
      const steps = [];
      
      h2Elements.forEach((h2, index) => {
        const stepTitle = h2.textContent.trim();
        const stepContent = this.getContentUntilNextHeading(h2);
        
        // Extract and sanitize images from step content
        const images = [];
        const imgElements = stepContent.querySelectorAll('img');
        imgElements.forEach(img => {
          const src = img.getAttribute('src') || '';
          const alt = img.getAttribute('alt') || '';
          const sanitizedSrc = this.sanitizeImageUrl(src);
          if (sanitizedSrc) {
            images.push({
              alt: alt,
              dataUrlOrRemoteUrl: sanitizedSrc
            });
            // Update the img tag with sanitized URL
            img.setAttribute('src', sanitizedSrc);
          } else {
            // Remove invalid image
            img.remove();
          }
        });
        
        // Sanitize the HTML content by removing scripts and dangerous attributes
        const sanitizedContent = this.sanitizeHtmlContent(stepContent);
        
        steps.push({
          index: index + 1,
          title: stepTitle,
          bodyHtml: sanitizedContent.innerHTML,
          images: images
        });
      });
      
      return {
        id: this.generateUUID(),
        title: title,
        summary: summary,
        tags: [],
        estimatedMinutes: null,
        steps: steps,
        source: 'uploaded',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error parsing HTML article:', error);
      return null;
    }
  },

  /**
   * Sanitize HTML content to remove dangerous elements and attributes
   * @param {Element} element - DOM element to sanitize
   * @returns {Element} Sanitized element
   */
  sanitizeHtmlContent(element) {
    // Remove script tags
    element.querySelectorAll('script').forEach(el => el.remove());
    
    // Remove event handler attributes and dangerous URLs
    element.querySelectorAll('*').forEach(el => {
      Array.from(el.attributes).forEach(attr => {
        // Remove event handlers
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
        }
        // Remove javascript: URLs
        if ((attr.name === 'href' || attr.name === 'src') && 
            attr.value.toLowerCase().includes('javascript:')) {
          el.removeAttribute(attr.name);
        }
      });
    });
    
    return element;
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
   * Validate and sanitize image URL
   * @param {string} url - Image URL
   * @returns {string|null} Sanitized URL or null if invalid
   */
  sanitizeImageUrl(url) {
    // Only allow data URLs with image MIME types, http, and https
    if (url.startsWith('data:image/')) {
      return url;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return null;
  },

  /**
   * Convert markdown to HTML (simple implementation)
   * @param {string} markdown - Markdown content
   * @returns {string} HTML content
   */
  markdownToHtml(markdown) {
    const lines = markdown.split('\n');
    let inList = false;
    const processedLines = [];
    
    for (let line of lines) {
      const trimmed = line.trim();
      
      // Handle list items
      if (trimmed.match(/^[-*]\s+/)) {
        if (!inList) {
          processedLines.push('<ul>');
          inList = true;
        }
        const content = this.processInlineMarkdown(trimmed.substring(2));
        processedLines.push(`<li>${content}</li>`);
        continue;
      }
      
      // Close list if needed
      if (inList) {
        processedLines.push('</ul>');
        inList = false;
      }
      
      // Process line
      if (trimmed) {
        const processed = this.processInlineMarkdown(trimmed);
        processedLines.push(`<p>${processed}</p>`);
      }
    }
    
    // Close list if still open
    if (inList) {
      processedLines.push('</ul>');
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
  }
};

// Make it available globally
if (typeof window !== 'undefined') {
  window.Articles = Articles;
}
