/**
 * Search and ranking functionality
 * Provides article search with relevance scoring
 */

const Search = {
  /**
   * Search articles by query
   * @param {string} query - Search query
   * @param {Array} articles - Articles to search
   * @returns {Array} Ranked search results
   */
  search(query, articles) {
    if (!query || !query.trim()) {
      return articles || [];
    }
    
    if (!Array.isArray(articles) || articles.length === 0) {
      return [];
    }
    
    const normalizedQuery = query.toLowerCase().trim();
    const results = [];
    
    articles.forEach(article => {
      const score = this.calculateRelevanceScore(normalizedQuery, article);
      if (score > 0) {
        results.push({
          article,
          score,
          highlights: this.getHighlights(normalizedQuery, article)
        });
      }
    });
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    return results.map(r => r.article);
  },

  /**
   * Calculate relevance score for an article
   * @param {string} query - Normalized query
   * @param {Object} article - Article object
   * @returns {number} Relevance score
   */
  calculateRelevanceScore(query, article) {
    let score = 0;
    
    if (!article) return score;
    
    // Title match (highest weight)
    const title = (article.title || '').toLowerCase();
    if (title.includes(query)) {
      score += 10;
      if (title.startsWith(query)) {
        score += 5; // Boost for starts-with
      }
    }
    
    // Summary match
    const summary = (article.summary || '').toLowerCase();
    if (summary.includes(query)) {
      score += 7;
    }
    
    // Tags match
    if (Array.isArray(article.tags)) {
      article.tags.forEach(tag => {
        if (tag.toLowerCase().includes(query)) {
          score += 3;
        }
      });
    }
    
    // Step titles and content match
    if (Array.isArray(article.steps)) {
      article.steps.forEach(step => {
        const stepTitle = (step.title || '').toLowerCase();
        if (stepTitle.includes(query)) {
          score += 2;
        }
        
        const stepBody = (step.bodyHtml || '').toLowerCase();
        if (stepBody.includes(query)) {
          score += 1;
          // Count occurrences
          const occurrences = (stepBody.match(new RegExp(query, 'g')) || []).length;
          score += Math.min(occurrences * 0.5, 3); // Cap bonus at 3
        }
      });
    }
    
    // Tokenized query matching
    const queryTokens = query.split(/\s+/);
    if (queryTokens.length > 1) {
      queryTokens.forEach(token => {
        if (token.length > 2) { // Ignore very short tokens
          if (title.includes(token)) score += 1;
          if (summary.includes(token)) score += 0.5;
        }
      });
    }
    
    return score;
  },

  /**
   * Get highlighted snippets from article
   * @param {string} query - Normalized query
   * @param {Object} article - Article object
   * @returns {Array} Array of highlight snippets
   */
  getHighlights(query, article) {
    const highlights = [];
    
    if (!article) return highlights;
    
    // Title highlight
    const title = article.title || '';
    if (title.toLowerCase().includes(query)) {
      highlights.push({ field: 'title', text: title });
    }
    
    // Content highlights (first 3 matches)
    const content = article.content || '';
    const lowerContent = content.toLowerCase();
    const index = lowerContent.indexOf(query);
    
    if (index !== -1) {
      const start = Math.max(0, index - 40);
      const end = Math.min(content.length, index + query.length + 40);
      let snippet = content.substring(start, end);
      
      if (start > 0) snippet = '...' + snippet;
      if (end < content.length) snippet = snippet + '...';
      
      highlights.push({ field: 'content', text: snippet });
    }
    
    return highlights;
  },

  /**
   * Filter articles by category
   * @param {Array} articles - Articles to filter
   * @param {string} category - Category to filter by
   * @returns {Array} Filtered articles
   */
  filterByCategory(articles, category) {
    if (!category || !Array.isArray(articles)) {
      return articles || [];
    }
    
    return articles.filter(article => 
      article.category && article.category.toLowerCase() === category.toLowerCase()
    );
  },

  /**
   * Filter articles by tags
   * @param {Array} articles - Articles to filter
   * @param {Array} tags - Tags to filter by
   * @returns {Array} Filtered articles
   */
  filterByTags(articles, tags) {
    if (!Array.isArray(tags) || tags.length === 0 || !Array.isArray(articles)) {
      return articles || [];
    }
    
    return articles.filter(article => {
      if (!Array.isArray(article.tags)) return false;
      return tags.some(tag => 
        article.tags.some(articleTag => 
          articleTag.toLowerCase() === tag.toLowerCase()
        )
      );
    });
  },

  /**
   * Get unique categories from articles
   * @param {Array} articles - Articles to analyze
   * @returns {Array} Unique categories
   */
  getCategories(articles) {
    if (!Array.isArray(articles)) return [];
    
    const categories = new Set();
    articles.forEach(article => {
      if (article.category) {
        categories.add(article.category);
      }
    });
    
    return Array.from(categories).sort();
  },

  /**
   * Get unique tags from articles
   * @param {Array} articles - Articles to analyze
   * @returns {Array} Unique tags
   */
  getTags(articles) {
    if (!Array.isArray(articles)) return [];
    
    const tags = new Set();
    articles.forEach(article => {
      if (Array.isArray(article.tags)) {
        article.tags.forEach(tag => tags.add(tag));
      }
    });
    
    return Array.from(tags).sort();
  }
};

// Make it available globally
if (typeof window !== 'undefined') {
  window.Search = Search;
}
