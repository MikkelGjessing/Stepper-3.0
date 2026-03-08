/**
 * Parser Strategy Registry
 *
 * Implements the pluggable parser-strategy architecture for article digestion.
 *
 * Each strategy exposes:
 *   name        - string identifier
 *   priority    - tie-breaking order (lower = higher priority)
 *   canParse(normalizedArticle) → { score: number, reasons: string[] }
 *   parse(normalizedArticle)    → { steps: Step[], parserMeta: Object }
 *
 * Strategy selection (ParserRegistry.select):
 *   - Run canParse() for all strategies
 *   - Choose highest-scoring strategy whose score >= MIN_SCORE_THRESHOLD
 *   - Ties broken by priority (lower number wins)
 *
 * Priority order (most → least structured):
 *   1. procedureTableParser       (priority 1)
 *   2. chapteredProcedureParser   (priority 2)
 *   3. explicitStepHeadingParser  (priority 3)
 *   4. numberedListProcedureParser (priority 4)
 *   5. fallbackSingleStepParser   (priority 5)
 *
 * Depends on:  ArticleNormalizer  (normalizer.js, loaded first)
 *              Articles            (articles.js,  loaded before parser_strategies.js)
 */

const MIN_SCORE_THRESHOLD = 10;

/** Maximum length for step titles extracted from text content. */
const MAX_TITLE_LENGTH = 80;

// ─── Shared internal helpers ──────────────────────────────────────────────────

/**
 * Extract a suitable step title from a plain-text string.
 * Takes the first sentence (split on .,!,?) and truncates to MAX_TITLE_LENGTH.
 * @param {string} text - Plain text
 * @returns {string}
 */
function _extractTitleFromText(text) {
  const firstSentence = (text || '').replace(/\s+/g, ' ')
    .split(/[.!?](?:\s|$)/)[0].trim();
  return firstSentence.length > MAX_TITLE_LENGTH
    ? firstSentence.substring(0, MAX_TITLE_LENGTH)
    : firstSentence;
}


/**
 * Create a temporary DIV element populated with the given HTML string.
 * This gives strategies a DOM fragment to query against without modifying
 * the original document.
 * @param {string} html
 * @returns {HTMLDivElement}
 */
function _tmpDiv(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return div;
}

/**
 * Build a step object from a title and body HTML.
 * Extracts and sanitizes images from the body element.
 * @param {string}  title
 * @param {Element} bodyEl  - Element whose innerHTML forms the body
 * @returns {{ title: string, bodyHtml: string, images: Array }}
 */
function _buildStep(title, bodyEl) {
  const images = ArticleNormalizer.extractImages(bodyEl);
  const sanitized = ArticleNormalizer.sanitizeHtmlContent(bodyEl);
  return { title, bodyHtml: sanitized.innerHTML, images };
}

/**
 * Attach sequential index numbers (1-based) to an array of step objects.
 * Returns a new array with `index` added/overwritten on each element.
 * @param {Array} steps
 * @returns {Array}
 */
function _indexSteps(steps) {
  return steps.map((step, i) => ({ index: i + 1, ...step }));
}

/**
 * Build parser metadata suitable for storage in article.parserMeta.
 * @param {string}   parserName
 * @param {number}   parserScore
 * @param {Array}    steps
 * @param {Object}   normalizedArticle
 * @param {string[]} [warnings]
 * @returns {Object}
 */
function _buildParserMeta(parserName, parserScore, steps, normalizedArticle, warnings) {
  const proc = normalizedArticle.procedureHtml || '';
  return {
    parserName,
    parserScore,
    stepCount:               steps.length,
    sectionHeadings:         (normalizedArticle.sections || []).map(s => s.heading),
    procedureSectionFound:   (normalizedArticle.sections || []).some(s => s.headingType === 'procedure'),
    hasNotes:                /(?:Note|Warning|Important|Tip)[!:]/i.test(proc),
    hasImages:               (normalizedArticle.images || []).length > 0,
    hasTables:               /<table/i.test(proc),
    parsingWarnings:         Array.isArray(warnings) ? warnings : []
  };
}

// ─── Strategy 1: procedureTableParser ─────────────────────────────────────────

/**
 * Use when the Procedure section contains a table with columns like
 * Step / Action / Description / Details / Image.
 *
 * Scoring:
 *   80  – table has both a step-number column AND an action column
 *   60  – table has an action column only
 *    0  – no procedural table found
 */
const procedureTableParser = {
  name:     'procedureTableParser',
  priority: 1,

  canParse(normalizedArticle) {
    const reasons = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const tables = Array.from(container.querySelectorAll('table'));
    if (tables.length === 0) {
      return { score: 0, reasons: ['no tables found in procedure section'] };
    }

    const STEP_COL   = /^(?:step|no\.?|#|nr\.?|step\s*#)$/i;
    const ACTION_COL = /^(?:action|instruction|task|description|details?|procedure|what\s+to\s+do|activity)$/i;

    let bestScore = 0;
    for (const table of tables) {
      const headerRow = table.querySelector('thead tr') ||
                        (table.querySelectorAll('tr')[0] || null);
      if (!headerRow) continue;

      const headers = Array.from(headerRow.querySelectorAll('th, td'))
        .map(cell => cell.textContent.trim().toLowerCase());

      const hasStepCol   = headers.some(h => STEP_COL.test(h));
      const hasActionCol = headers.some(h => ACTION_COL.test(h));

      if (hasStepCol && hasActionCol) {
        bestScore = Math.max(bestScore, 80);
        reasons.push('table with step and action columns found');
      } else if (hasActionCol) {
        bestScore = Math.max(bestScore, 60);
        reasons.push('table with action column found');
      }
    }

    return { score: bestScore, reasons };
  },

  parse(normalizedArticle) {
    const warnings = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const tables = Array.from(container.querySelectorAll('table'));

    // Use the Articles.extractTableSteps helper (defined in articles.js)
    let steps = [];
    let globalIdx = 1;
    for (const table of tables) {
      const tableSteps = Articles.extractTableSteps(table, globalIdx);
      if (tableSteps.length > 0) {
        steps = steps.concat(tableSteps);
        globalIdx += tableSteps.length;
      }
    }

    if (steps.length === 0) {
      warnings.push('procedureTableParser: no rows extracted; falling back');
      steps = [{ title: 'Procedure', bodyHtml: normalizedArticle.procedureHtml, images: [] }];
    }

    const { score } = this.canParse(normalizedArticle);
    const indexed = _indexSteps(steps);
    return {
      steps: indexed,
      parserMeta: _buildParserMeta(this.name, score, indexed, normalizedArticle, warnings)
    };
  }
};

// ─── Strategy 2: chapteredProcedureParser ────────────────────────────────────

/**
 * Use when the Procedure section contains chapter / section / phase headings
 * (e.g. "Chapter 1", "Phase 2", "Section A") that group steps inside them.
 *
 * Rules:
 *   - Chapter headings are containers, not steps.
 *   - Step numbering may restart per chapter; globally renumbered for the UI.
 *   - Each step carries a chapterTitle field.
 *
 * Scoring:
 *   70  – 2 or more chapter/section/phase headings found
 *   35  – exactly 1 chapter heading found
 *    0  – no chapter headings found
 */
const chapteredProcedureParser = {
  name:     'chapteredProcedureParser',
  priority: 2,

  /** @type {RegExp} Matches chapter/section/phase heading text */
  _CHAPTER_RE: /^(?:chapter|section|phase|part)\s+[\dA-Z]/i,

  canParse(normalizedArticle) {
    const reasons = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const headings = Array.from(container.querySelectorAll('h2, h3, h4'));

    const chapterHeadings = headings.filter(h =>
      this._CHAPTER_RE.test(h.textContent.trim())
    );

    if (chapterHeadings.length >= 2) {
      reasons.push(`${chapterHeadings.length} chapter/section headings found`);
      return { score: 70, reasons };
    }
    if (chapterHeadings.length === 1) {
      reasons.push('1 chapter/section heading found');
      return { score: 35, reasons };
    }
    return { score: 0, reasons: ['no chapter/section headings found'] };
  },

  parse(normalizedArticle) {
    const warnings = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const nodes = Array.from(container.childNodes).filter(
      n => n.nodeType === Node.ELEMENT_NODE
    );

    const steps = [];
    let currentChapter = null;
    let globalIdx = 1;

    const flushChapterSteps = (chapterTitle, chapterNodes) => {
      if (chapterNodes.length === 0) return;

      // Try to extract numbered items or OL items inside the chapter
      const chapterDiv = document.createElement('div');
      chapterNodes.forEach(n => chapterDiv.appendChild(n.cloneNode(true)));

      // Ordered list items → individual steps
      const ols = chapterDiv.querySelectorAll('ol');
      if (ols.length > 0) {
        ols.forEach(ol => {
          Array.from(ol.querySelectorAll('li')).forEach(li => {
            const liDiv = document.createElement('div');
            liDiv.appendChild(li.cloneNode(true));
            const liText = li.textContent.trim();
            const title = _extractTitleFromText(liText);
            const step = _buildStep(title, liDiv);
            if (chapterTitle) step.chapterTitle = chapterTitle;
            steps.push(step);
            globalIdx++;
          });
        });
        return;
      }

      // Numbered paragraphs → individual steps
      let foundNumbered = false;
      Array.from(chapterDiv.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE)
        .forEach(node => {
          if (node.tagName !== 'P') return;
          const text = node.textContent.trim();
          const numMatch = text.match(/^(\d+)[.)]\s+(.+)/s);
          if (!numMatch) return;
          foundNumbered = true;
          const stepText = numMatch[2].trim();
          const title = _extractTitleFromText(stepText);
          const el = document.createElement('div');
          el.appendChild(node.cloneNode(true));
          const step = _buildStep(title, el);
          if (chapterTitle) step.chapterTitle = chapterTitle;
          steps.push(step);
          globalIdx++;
        });
      if (foundNumbered) return;

      // Fallback: whole chapter content as one step
      const step = _buildStep(chapterTitle || 'Procedure', chapterDiv);
      if (chapterTitle) step.chapterTitle = chapterTitle;
      steps.push(step);
      globalIdx++;
    };

    let chapterNodes = [];
    for (const node of nodes) {
      const isHeading = /^H[1-6]$/.test(node.tagName);
      if (isHeading && this._CHAPTER_RE.test(node.textContent.trim())) {
        if (currentChapter !== null) {
          flushChapterSteps(currentChapter, chapterNodes);
          chapterNodes = [];
        }
        currentChapter = node.textContent.trim();
      } else if (currentChapter !== null) {
        chapterNodes.push(node);
      }
    }
    if (currentChapter !== null) {
      flushChapterSteps(currentChapter, chapterNodes);
    }

    if (steps.length === 0) {
      warnings.push('chapteredProcedureParser: no steps extracted; falling back');
      steps.push({ title: 'Procedure', bodyHtml: normalizedArticle.procedureHtml, images: [] });
    }

    const { score } = this.canParse(normalizedArticle);
    const indexed = _indexSteps(steps);
    return {
      steps: indexed,
      parserMeta: _buildParserMeta(this.name, score, indexed, normalizedArticle, warnings)
    };
  }
};

// ─── Strategy 3: explicitStepHeadingParser ────────────────────────────────────

/**
 * Use when the article contains explicit "Step N:" headings, numbered
 * paragraph markers ("1.", "1)"), or generic H2/H3 section headings that
 * act as step boundaries.
 *
 * Scoring:
 *   90  – "Step N:" pattern found in paragraph or heading text
 *   65  – numbered paragraphs ("1. xxx" / "1) xxx") found (≥ 2)
 *   55  – H2/H3 headings (non-section) present that serve as step titles (≥ 2)
 *    0  – no step markers found
 */
const explicitStepHeadingParser = {
  name:     'explicitStepHeadingParser',
  priority: 3,

  _STEP_MARKER_RE: /^(?:Step|STEP)\s+\d+(?:\s*[:\-–]|\s*$)/i,
  _NUMBERED_RE:    /^\d+[.)]\s+\S/,

  /** Return true if the heading text is a structural section name, not a step title. */
  _isSectionHeading(text) {
    return ArticleNormalizer.isProcedureSectionHeading(text)
        || ArticleNormalizer.isSkipSectionHeading(text)
        || ArticleNormalizer.isIntroSectionHeading(text)
        || ArticleNormalizer.isTagsSectionHeading(text);
  },

  canParse(normalizedArticle) {
    const reasons = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const blocks = Array.from(container.querySelectorAll('p, h1, h2, h3, h4, h5, h6'));

    // 1. "Step N:" markers in any block element
    const stepMarkers = blocks.filter(el =>
      this._STEP_MARKER_RE.test(el.textContent.trim())
    );
    if (stepMarkers.length > 0) {
      reasons.push(`${stepMarkers.length} "Step N:" marker(s) found`);
      return { score: 90, reasons };
    }

    // 2. Numbered paragraphs "1. xxx" / "1) xxx"
    const numberedParas = blocks.filter(
      el => el.tagName === 'P' && this._NUMBERED_RE.test(el.textContent.trim())
    );
    if (numberedParas.length >= 2) {
      reasons.push(`${numberedParas.length} numbered paragraphs found`);
      return { score: 65, reasons };
    }

    // 3. H2/H3 headings that serve as step titles (not structural section names)
    const stepHeadings = Array.from(container.querySelectorAll('h2, h3')).filter(
      h => !this._isSectionHeading(h.textContent.trim())
    );
    if (stepHeadings.length >= 2) {
      reasons.push(`${stepHeadings.length} H2/H3 headings usable as step titles`);
      return { score: 55, reasons };
    }

    return { score: 0, reasons: ['no explicit step headings or numbered paragraphs found'] };
  },

  parse(normalizedArticle) {
    const warnings = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const blocks = Array.from(container.querySelectorAll('p, h1, h2, h3, h4, h5, h6'));
    let steps = [];

    // ── Case 1: "Step N:" markers ────────────────────────────────────────────
    const stepMarkers = blocks.filter(el =>
      this._STEP_MARKER_RE.test(el.textContent.trim())
    );

    if (stepMarkers.length > 0) {
      // Use the shared segmentIntoSteps on a temporary document derived from
      // the procedure HTML so that the full procedure DOM is analysed.
      const tmpParser = new DOMParser();
      const tmpDoc = tmpParser.parseFromString(
        `<body>${normalizedArticle.procedureHtml}</body>`,
        'text/html'
      );

      // segmentIntoSteps is defined on Articles (articles.js loaded before this file)
      steps = Articles.segmentIntoSteps(tmpDoc);

      if (steps.length === 0) {
        warnings.push('explicitStepHeadingParser: segmentIntoSteps returned 0 steps, trying _extractSectionAwareSteps');
        const nodes = Array.from(tmpDoc.body.childNodes).filter(
          n => n.nodeType === Node.ELEMENT_NODE
        );
        steps = Articles._extractSectionAwareSteps(tmpDoc.body, nodes);
      }
    }

    // ── Case 2: H2/H3 headings as step boundaries (classic HTML article layout) ──
    if (steps.length === 0) {
      const stepHeadings = Array.from(container.querySelectorAll('h2, h3')).filter(
        h => !this._isSectionHeading(h.textContent.trim())
      );

      if (stepHeadings.length >= 2) {
        stepHeadings.forEach(heading => {
          let stepTitle = heading.textContent.trim();
          // Collect siblings until the next heading
          const stepContent = document.createElement('div');
          let sibling = heading.nextElementSibling;
          while (sibling && !sibling.matches('h2, h3, h4, h5, h6')) {
            stepContent.appendChild(sibling.cloneNode(true));
            sibling = sibling.nextElementSibling;
          }

          // ── Deduplicate body content ───────────────────────────────────────
          // Strip leading generic "STEP" / "STEP N" elements that duplicate
          // the step-label indicator (e.g. a bold "<p>STEP</p>" below an H2).
          let firstChild = stepContent.firstElementChild;
          while (firstChild && /^(?:STEP|Step)\s*\d*\s*$/.test(firstChild.textContent.trim())) {
            firstChild.remove();
            firstChild = stepContent.firstElementChild;
          }

          // If the heading itself is a bare numeric marker ("STEP N" / "Step N")
          // rather than a descriptive title, promote the first body element as
          // the real step title and remove it from the body.
          if (/^(?:STEP|Step)\s+\d+\s*$/.test(stepTitle)) {
            firstChild = stepContent.firstElementChild;
            if (firstChild) {
              const firstText = firstChild.textContent.trim();
              if (firstText && firstText.length <= MAX_TITLE_LENGTH) {
                stepTitle = firstText;
                firstChild.remove();
              }
            }
          } else if (/^(?:STEP|Step)\s*$/.test(stepTitle)) {
            // Heading is just the generic "STEP" / "Step" label (no number) —
            // promote the first body element as the real step title using first sentence.
            firstChild = stepContent.firstElementChild;
            if (firstChild) {
              const fullText = firstChild.textContent.trim();
              const firstSentence = fullText.replace(/\s+/g, ' ')
                .split(/[.!?](?:\s|$)/)[0].trim();
              const titleCandidate = firstSentence.length > MAX_TITLE_LENGTH
                ? firstSentence.substring(0, MAX_TITLE_LENGTH)
                : firstSentence;
              if (titleCandidate && !/^(?:STEP|Step)\s*\d*\s*$/.test(titleCandidate)) {
                stepTitle = titleCandidate;
                firstChild.remove();
              }
            }
          } else {
            // For descriptive headings, also strip a leading body element that
            // exactly repeats the heading text (documents that echo the title).
            firstChild = stepContent.firstElementChild;
            if (firstChild && firstChild.textContent.trim() === stepTitle) {
              firstChild.remove();
            }
          }

          steps.push(_buildStep(stepTitle, stepContent));
        });
      }
    }

    // ── Case 3: Numbered paragraphs ──────────────────────────────────────────
    if (steps.length === 0) {
      const nodes = Array.from(container.childNodes).filter(
        n => n.nodeType === Node.ELEMENT_NODE
      );
      for (const node of nodes) {
        if (node.tagName !== 'P') continue;
        const text = node.textContent.trim();
        const numMatch = text.match(/^(\d+)[.)]\s+(.+)/s);
        if (!numMatch) continue;
        const stepText = numMatch[2].trim();
        const title = _extractTitleFromText(stepText);
        const el = document.createElement('div');
        el.appendChild(node.cloneNode(true));
        steps.push(_buildStep(title, el));
      }
    }

    if (steps.length === 0) {
      warnings.push('explicitStepHeadingParser: all extractions failed; single-step fallback');
      steps = [{ title: 'Procedure', bodyHtml: normalizedArticle.procedureHtml, images: [] }];
    }

    const { score } = this.canParse(normalizedArticle);
    const indexed = _indexSteps(steps);
    return {
      steps: indexed,
      parserMeta: _buildParserMeta(this.name, score, indexed, normalizedArticle, warnings)
    };
  }
};

// ─── Strategy 4: numberedListProcedureParser ──────────────────────────────────

/**
 * Use when the Procedure section contains an ordered list (<ol>) or imperative
 * numbered paragraphs without explicit "Step N:" labels.
 *
 * Scoring:
 *   50  – <ol> element with 2+ items found
 *   40  – numbered paragraphs found (but fewer than 2)
 *    0  – no numbered structure found
 */
const numberedListProcedureParser = {
  name:     'numberedListProcedureParser',
  priority: 4,

  canParse(normalizedArticle) {
    const reasons = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);

    // Check for <ol> elements with multiple items
    const ols = Array.from(container.querySelectorAll('ol'));
    const listItems = ols.reduce((sum, ol) => sum + ol.querySelectorAll('li').length, 0);
    if (listItems >= 2) {
      reasons.push(`ordered list with ${listItems} items found`);
      return { score: 50, reasons };
    }

    // Check for numbered paragraphs "1. xxx" / "1) xxx"
    const paras = Array.from(container.querySelectorAll('p'));
    const numberedParas = paras.filter(p => /^\d+[.)]\s+\S/.test(p.textContent.trim()));
    if (numberedParas.length >= 2) {
      reasons.push(`${numberedParas.length} numbered paragraphs found`);
      return { score: 50, reasons };
    }
    if (numberedParas.length === 1 || listItems === 1) {
      reasons.push('single numbered item found');
      return { score: 40, reasons };
    }

    return { score: 0, reasons: ['no numbered list structure found'] };
  },

  parse(normalizedArticle) {
    const warnings = [];
    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const steps = [];
    let globalIdx = 1;

    // Extract from <ol> elements first
    const ols = Array.from(container.querySelectorAll('ol'));
    if (ols.length > 0) {
      ols.forEach(ol => {
        Array.from(ol.querySelectorAll('li')).forEach(li => {
          const liDiv = document.createElement('div');
          liDiv.appendChild(li.cloneNode(true));
          const liText = li.textContent.trim();
          const title = _extractTitleFromText(liText);
          steps.push(_buildStep(title, liDiv));
          globalIdx++;
        });
      });
    } else {
      // Fall back to numbered paragraphs
      const nodes = Array.from(container.childNodes)
        .filter(n => n.nodeType === Node.ELEMENT_NODE);

      for (const node of nodes) {
        if (node.tagName !== 'P') continue;
        const text = node.textContent.trim();
        const numMatch = text.match(/^(\d+)[.)]\s+(.+)/s);
        if (!numMatch) continue;
        const stepText = numMatch[2].trim();
        const title = _extractTitleFromText(stepText);
        const el = document.createElement('div');
        el.appendChild(node.cloneNode(true));
        steps.push(_buildStep(title, el));
        globalIdx++;
      }
    }

    if (steps.length === 0) {
      warnings.push('numberedListProcedureParser: no steps extracted; falling back');
      steps.push({ title: 'Procedure', bodyHtml: normalizedArticle.procedureHtml, images: [] });
    }

    const { score } = this.canParse(normalizedArticle);
    const indexed = _indexSteps(steps);
    return {
      steps: indexed,
      parserMeta: _buildParserMeta(this.name, score, indexed, normalizedArticle, warnings)
    };
  }
};

// ─── Strategy 5: fallbackSingleStepParser ────────────────────────────────────

/**
 * Last-resort strategy: always matches with a low score.
 * Wraps the entire procedure section (or full body) as a single step.
 *
 * Scoring: always 10 (above MIN_SCORE_THRESHOLD so it is always selectable
 * when no stronger strategy wins).
 */
const fallbackSingleStepParser = {
  name:     'fallbackSingleStepParser',
  priority: 5,

  canParse(normalizedArticle) {
    return {
      score:   10,
      reasons: ['fallback: always matches when no better strategy applies']
    };
  },

  parse(normalizedArticle) {
    const warnings = [
      'fallbackSingleStepParser selected — article has no detectable procedural structure'
    ];

    const container = _tmpDiv(normalizedArticle.procedureHtml);
    const images = ArticleNormalizer.extractImages(container);
    const sanitized = ArticleNormalizer.sanitizeHtmlContent(container);

    const steps = [{
      title:    'Procedure',
      bodyHtml: sanitized.innerHTML || normalizedArticle.procedureHtml || '',
      images
    }];

    const indexed = _indexSteps(steps);
    return {
      steps: indexed,
      parserMeta: _buildParserMeta(
        this.name, 10, indexed, normalizedArticle, warnings
      )
    };
  }
};

// ─── Parser Registry ──────────────────────────────────────────────────────────

/**
 * Registry of all available parser strategies and the selection / execution
 * logic that picks the best match for a given NormalizedArticle.
 */
const ParserRegistry = {

  /** Ordered array of all registered strategies (priority 1 first). */
  strategies: [
    procedureTableParser,
    chapteredProcedureParser,
    explicitStepHeadingParser,
    numberedListProcedureParser,
    fallbackSingleStepParser
  ],

  /**
   * Run canParse() on every strategy and return the one with the highest score.
   * Ties are broken by the strategy's priority (lower wins).
   *
   * @param {Object} normalizedArticle - NormalizedArticle from ArticleNormalizer
   * @returns {{ strategy: Object, score: number, reasons: string[] }}
   */
  select(normalizedArticle) {
    let best = null;
    let bestScore = -Infinity;

    // Strategies are ordered by priority; iterating in order means earlier
    // strategies win ties automatically.
    for (const strategy of this.strategies) {
      const result = strategy.canParse(normalizedArticle);
      if (result.score > bestScore) {
        bestScore = result.score;
        best = { strategy, score: result.score, reasons: result.reasons };
      }
    }

    // If nothing exceeded the threshold (shouldn't happen since fallback=10),
    // use the last strategy (fallbackSingleStepParser).
    if (!best || best.score < MIN_SCORE_THRESHOLD) {
      const fb = this.strategies[this.strategies.length - 1];
      const fbResult = fb.canParse(normalizedArticle);
      best = { strategy: fb, score: fbResult.score, reasons: fbResult.reasons };
    }

    return best;
  },

  /**
   * Select the best strategy and execute its parse() method.
   *
   * @param {Object} normalizedArticle - NormalizedArticle from ArticleNormalizer
   * @returns {{ steps: Step[], parserMeta: Object }}
   */
  run(normalizedArticle) {
    const { strategy, score, reasons } = this.select(normalizedArticle);
    const result = strategy.parse(normalizedArticle);

    // Attach selection reasoning to parserMeta
    result.parserMeta.selectionReasons = reasons;

    return result;
  }
};

// Expose as module-level array (matches problem-statement naming convention)
const parserStrategies = ParserRegistry.strategies;

// Make available globally in browser context
if (typeof window !== 'undefined') {
  window.parserStrategies = parserStrategies;
  window.ParserRegistry   = ParserRegistry;
}
