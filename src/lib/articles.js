/**
 * Article CRUD operations and parsing
 * Manages article data structure and operations
 */

const Articles = {
  /**
   * Create a new article
   * @param {Object} articleData - Article data
   * @returns {Promise<Object>} Created article with ID
   */
  async createArticle(articleData) {
    try {
      const articles = await Storage.getArticles();
      
      const newArticle = {
        id: this.generateId(),
        title: articleData.title || 'Untitled Article',
        content: articleData.content || '',
        tags: Array.isArray(articleData.tags) ? articleData.tags : [],
        category: articleData.category || 'General',
        steps: Array.isArray(articleData.steps) ? articleData.steps : [],
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          author: articleData.author || 'Unknown',
          version: '1.0'
        }
      };
      
      articles.push(newArticle);
      await Storage.setArticles(articles);
      
      return newArticle;
    } catch (error) {
      console.error('Error creating article:', error);
      throw error;
    }
  },

  /**
   * Read article by ID
   * @param {string} articleId - Article ID
   * @returns {Promise<Object|null>} Article object or null
   */
  async getArticleById(articleId) {
    try {
      const articles = await Storage.getArticles();
      return articles.find(article => article.id === articleId) || null;
    } catch (error) {
      console.error('Error getting article:', error);
      return null;
    }
  },

  /**
   * Get all articles
   * @returns {Promise<Array>} Array of articles
   */
  async getAllArticles() {
    try {
      return await Storage.getArticles();
    } catch (error) {
      console.error('Error getting all articles:', error);
      return [];
    }
  },

  /**
   * Update article by ID
   * @param {string} articleId - Article ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object|null>} Updated article or null
   */
  async updateArticle(articleId, updates) {
    try {
      const articles = await Storage.getArticles();
      const index = articles.findIndex(article => article.id === articleId);
      
      if (index === -1) {
        console.error('Article not found:', articleId);
        return null;
      }
      
      articles[index] = {
        ...articles[index],
        ...updates,
        id: articleId, // Preserve ID
        metadata: {
          ...articles[index].metadata,
          updatedAt: new Date().toISOString()
        }
      };
      
      await Storage.setArticles(articles);
      return articles[index];
    } catch (error) {
      console.error('Error updating article:', error);
      return null;
    }
  },

  /**
   * Delete article by ID
   * @param {string} articleId - Article ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteArticle(articleId) {
    try {
      const articles = await Storage.getArticles();
      const filteredArticles = articles.filter(article => article.id !== articleId);
      
      if (filteredArticles.length === articles.length) {
        console.warn('Article not found for deletion:', articleId);
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
   * Parse article content into structured steps
   * @param {string} content - Raw article content
   * @returns {Array} Array of step objects
   */
  parseSteps(content) {
    if (!content) return [];
    
    try {
      const lines = content.split('\n');
      const steps = [];
      let currentStep = null;
      
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        
        // Match numbered steps (1. or 1) format)
        const stepMatch = trimmed.match(/^(\d+)[\.\)]\s*(.+)/);
        
        if (stepMatch) {
          if (currentStep) {
            steps.push(currentStep);
          }
          currentStep = {
            number: parseInt(stepMatch[1]),
            title: stepMatch[2],
            details: []
          };
        } else if (currentStep && trimmed) {
          currentStep.details.push(trimmed);
        }
      });
      
      if (currentStep) {
        steps.push(currentStep);
      }
      
      return steps;
    } catch (error) {
      console.error('Error parsing steps:', error);
      return [];
    }
  },

  /**
   * Generate unique ID for articles
   * @returns {string} Unique ID
   */
  generateId() {
    return `article_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  },

  /**
   * Create dummy articles for testing
   * @returns {Promise<Array>} Created dummy articles
   */
  async createDummyArticles() {
    const dummies = [
      {
        title: 'Password Reset Procedure',
        content: '1. Verify user identity\n2. Navigate to admin panel\n3. Select user account\n4. Click "Reset Password"\n5. Send temporary password to user email',
        tags: ['password', 'reset', 'user-management'],
        category: 'Account Management',
        author: 'IT Admin'
      },
      {
        title: 'VPN Connection Setup',
        content: '1. Download VPN client from portal\n2. Install the client\n3. Enter company VPN address\n4. Use domain credentials to connect\n5. Verify connection status',
        tags: ['vpn', 'network', 'setup'],
        category: 'Network',
        author: 'Network Team'
      },
      {
        title: 'Email Configuration on Mobile',
        content: '1. Open email app\n2. Add new account\n3. Select Exchange/Office365\n4. Enter email address\n5. Enter password\n6. Accept security policies',
        tags: ['email', 'mobile', 'configuration'],
        category: 'Email Support',
        author: 'IT Support'
      }
    ];
    
    const created = [];
    for (const dummy of dummies) {
      const article = await this.createArticle(dummy);
      created.push(article);
    }
    
    return created;
  }
};

// Make it available globally
if (typeof window !== 'undefined') {
  window.Articles = Articles;
}
