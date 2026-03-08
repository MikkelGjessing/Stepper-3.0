/**
 * Article Normalizer
 *
 * Converts a raw HTML Document into a NormalizedArticle intermediate
 * representation consumed by the parser-strategy pipeline.
 *
 * NormalizedArticle {
 *   title:           string,
 *   introHtml:       string,
 *   procedureHtml:   string,
 *   relatedInfoHtml: string,
 *   sections:        Array<{ heading: string, headingType: string, html: string }>,
 *   dom:             Document,
 *   plainText:       string,
 *   tags:            string[],
 *   images:          Array<{ alt: string, src: string }>,
 *   source:          string
 * }
 *
 * headingType values: 'procedure' | 'intro' | 'skip' | 'tags' | 'generic'
 */

const ArticleNormalizer = {

  // ─── Section-heading classifiers ─────────────────────────────────────────
  // These are the single-source-of-truth classifiers used by both the normalizer
  // and the parser strategies.  Articles.js delegates to these methods.

  /**
   * Return true when the heading identifies a procedure/instructions section.
   * @param {string} text - Trimmed heading text
   * @returns {boolean}
   */
  isProcedureSectionHeading(text) {
    return /^(?:\d+\.\s*)?(?:procedure|instructions?|steps?\b|how\s+to\b|process\b|work\s+instructions?)/i
      .test(text.trim());
  },

  /**
   * Return true when the heading identifies a section that must NOT produce
   * procedure steps (Related Info, Change Log, Appendix, etc.).
   * @param {string} text - Trimmed heading text
   * @returns {boolean}
   */
  isSkipSectionHeading(text) {
    return /^(?:\d+\.\s*)?(?:related\s+(?:information|articles?|links?)|change\s+(?:log|histor(?:y|ies))|revision\s+histor(?:y|ies)|appendix)/i
      .test(text.trim());
  },

  /**
   * Return true when the heading identifies an intro/general-info section.
   * Includes audience, skills, and prerequisites headings which are KB-article
   * metadata blocks that must never be mistaken for the article title.
   * @param {string} text - Trimmed heading text
   * @returns {boolean}
   */
  isIntroSectionHeading(text) {
    return /^(?:\d+\.\s*)?(?:general\s+info(?:rmation)?|overview\b|introduction\b|summary\b|background\b|audience\b|skills?\b|skills?\s+required|prerequisites?\b)/i
      .test(text.trim());
  },

  /**
   * Return true when the heading identifies a keywords/tags section.
   * @param {string} text - Trimmed heading text
   * @returns {boolean}
   */
  isTagsSectionHeading(text) {
    return /^(?:keywords?|tags?)(?:\s*[:\-]|\s*$)/i.test(text.trim());
  },

  /**
   * Classify a heading text into one of the recognised section types.
   * @param {string} text - Trimmed heading text
   * @returns {'procedure'|'intro'|'skip'|'tags'|'generic'}
   */
  classifyHeading(text) {
    const t = (text || '').trim();
    if (this.isProcedureSectionHeading(t))  return 'procedure';
    if (this.isSkipSectionHeading(t))        return 'skip';
    if (this.isIntroSectionHeading(t))       return 'intro';
    if (this.isTagsSectionHeading(t))        return 'tags';
    return 'generic';
  },

  // ─── DOM utilities ────────────────────────────────────────────────────────

  /**
   * Validate and sanitize an image URL.
   * Accepts:
   *   - data: URIs with image MIME types
   *   - Absolute http / https URLs
   *   - Protocol-relative URLs (// prefix) — normalised to https:
   *   - Relative URLs (no URI scheme) — preserved as-is so images from
   *     page-relative sources (ServiceNow, HTML exports) are not discarded.
   *     Path-traversal sequences ("..") in relative URLs do not create
   *     security risks in this context because Chrome extensions run in a
   *     sandboxed chrome-extension:// origin; relative src values cannot
   *     read local files or bypass CSP.
   * Rejects any URL carrying an unrecognised URI scheme (e.g. javascript:,
   * vbscript:, ftp:) and blank / whitespace-only strings.
   * @param {string} url
   * @returns {string|null} Sanitized URL or null if disallowed
   */
  sanitizeImageUrl(url) {
    if (!url) return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('data:image/'))              return trimmed;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    // Protocol-relative: normalise to https
    if (trimmed.startsWith('//'))                       return 'https:' + trimmed;
    // Relative URL: allow only if no URI scheme is present.
    // RFC-3986 scheme is: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
    // Rejecting anything that looks like a scheme (e.g. javascript:, vbscript:)
    // while passing plain relative paths like /images/pic.png or ./img.png
    if (!/^[a-z][a-z0-9+\-.]*:/i.test(trimmed))        return trimmed;
    return null;
  },

  /**
   * Strip HTML tags and return plain text.
   * @param {string} html
   * @returns {string}
   */
  stripHtmlTags(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  },

  /**
   * Sanitize an HTML element: remove dangerous tags and attributes, demote
   * h1→h3 and h2→h4 to avoid document-hierarchy conflicts in step bodies.
   * Mutates the element in-place and returns it.
   * @param {Element} element
   * @returns {Element}
   */
  sanitizeHtmlContent(element) {
    // Remove dangerous structural tags
    element.querySelectorAll('script, iframe, object, embed').forEach(el => el.remove());

    // Demote h1 → h3
    element.querySelectorAll('h1').forEach(el => {
      const h3 = document.createElement('h3');
      h3.textContent = el.textContent;
      Array.from(el.attributes).forEach(attr => {
        if (!attr.name.startsWith('on') && attr.name !== 'href' && attr.name !== 'src') {
          h3.setAttribute(attr.name, attr.value);
        }
      });
      el.parentNode.replaceChild(h3, el);
    });

    // Demote h2 → h4
    element.querySelectorAll('h2').forEach(el => {
      const h4 = document.createElement('h4');
      h4.textContent = el.textContent;
      Array.from(el.attributes).forEach(attr => {
        if (!attr.name.startsWith('on') && attr.name !== 'href' && attr.name !== 'src') {
          h4.setAttribute(attr.name, attr.value);
        }
      });
      el.parentNode.replaceChild(h4, el);
    });

    // Remove event handlers and javascript: URLs from all elements
    element.querySelectorAll('*').forEach(el => {
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
        }
        if ((attr.name === 'href' || attr.name === 'src') &&
            attr.value.toLowerCase().includes('javascript:')) {
          el.removeAttribute(attr.name);
        }
      });
    });

    return element;
  },

  /**
   * Extract and sanitize all images from an element.
   * Returns an array of image descriptor objects and removes invalid images
   * from the element in-place.
   *
   * Handles:
   *   - Standard <img src="..."> elements
   *   - Lazy-loaded images using data-src (falls back when src is absent/invalid)
   *   - <figure> / <figcaption> — figcaption text used as alt when alt is empty
   * @param {Element} element
   * @returns {Array<{ alt: string, dataUrlOrRemoteUrl: string }>}
   */
  extractImages(element) {
    const images = [];
    element.querySelectorAll('img').forEach(img => {
      // Prefer src; fall back to data-src (lazy-loaded images common in CMS / ServiceNow)
      const rawSrc = img.getAttribute('src') || '';
      const dataSrc = img.getAttribute('data-src') || '';
      const src = rawSrc || dataSrc;

      // Build alt text: use alt attribute first, then title, then figcaption
      let alt = img.getAttribute('alt') || img.getAttribute('title') || '';
      if (!alt) {
        const figure = img.closest('figure');
        if (figure) {
          const caption = figure.querySelector('figcaption');
          if (caption) alt = caption.textContent.trim();
        }
      }

      const sanitizedSrc = this.sanitizeImageUrl(src);
      if (sanitizedSrc) {
        images.push({ alt, dataUrlOrRemoteUrl: sanitizedSrc });
        img.setAttribute('src', sanitizedSrc);
        // Remove data-src to prevent double-loading by the browser
        if (img.hasAttribute('data-src')) img.removeAttribute('data-src');
      } else {
        img.remove();
      }
    });
    return images;
  },

  /**
   * Collect sibling elements following a heading until the next heading.
   * @param {Element} heading
   * @returns {Element} A <div> containing the sibling content
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

  // ─── ServiceNow source cleanup ────────────────────────────────────────────

  /**
   * Remove ServiceNow UI chrome and noise from a parsed Document (in-place).
   * Strips form elements, "Leave a comment", "Copy Permalink", Top/Bottom of
   * Form markers, and converts non-breaking spaces to regular spaces.
   *
   * @param {Document} doc - Parsed HTML document (mutated in-place)
   * @returns {Document} The same document, normalised
   */
  normalizeServiceNowDoc(doc) {
    doc.querySelectorAll(
      'script, style, iframe, object, embed, form, input, button, textarea, select'
    ).forEach(el => el.remove());

    const SN_NOISE = [
      /^leave\s+a\s+comment/i,
      /^copy\s+permalink$/i,
      /^top\s+of\s+form$/i,
      /^bottom\s+of\s+form$/i
    ];

    doc.querySelectorAll('p, div, span, a, li, td, th').forEach(el => {
      const text = el.textContent.trim();
      if (text && SN_NOISE.some(pattern => pattern.test(text))) {
        el.remove();
      }
    });

    // Replace non-breaking spaces in all text nodes
    const walker = doc.createTreeWalker(
      doc.body || doc.documentElement,
      NodeFilter.SHOW_TEXT
    );
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.nodeValue.includes('\u00a0')) {
        textNode.nodeValue = textNode.nodeValue.replace(/\u00a0/g, ' ');
      }
    }

    return doc;
  },

  // ─── Core normalization ───────────────────────────────────────────────────

  /**
   * Normalize a parsed HTML Document into the shared NormalizedArticle shape.
   *
   * The algorithm groups top-level elements into sections based on H1–H6
   * headings, classifies each section, and fills the introHtml / procedureHtml
   * / relatedInfoHtml buckets accordingly.
   *
   * @param {Document} doc    - Parsed HTML document (should have h1 removed if
   *                            the title was already extracted)
   * @param {string}   source - Source identifier ('uploaded'|'servicenow'|etc.)
   * @param {string}   title  - Article title
   * @returns {Object} NormalizedArticle
   */
  normalize(doc, source, title) {
    const body = doc.body || doc.documentElement;
    if (!body) {
      return {
        title: title || '',
        introHtml: '',
        procedureHtml: '',
        relatedInfoHtml: '',
        sections: [],
        dom: doc,
        plainText: '',
        tags: [],
        images: [],
        source: source || 'uploaded'
      };
    }

    // Collect element nodes from the top level
    const nodes = Array.from(body.childNodes).filter(
      n => n.nodeType === Node.ELEMENT_NODE
    );

    // Build sections list by walking headings
    const sections = [];
    let currentSection = null;
    let beforeFirstHeading = '';

    for (const node of nodes) {
      const isHeading = node.tagName && /^H[1-6]$/.test(node.tagName);
      if (isHeading) {
        const headingText = node.textContent.trim();
        const headingType = this.classifyHeading(headingText);
        // Only treat this node as a section boundary if it is a major heading
        // (h1 or h2) or if its text matches a recognised section pattern.
        // Minor headings (h3–h6) with generic type are treated as content
        // within the current section so that sub-headings like "Chapter 1"
        // remain inside their parent Procedure section.
        const isMajorHeading    = /^H[1-2]$/.test(node.tagName);
        const isRecognizedType  = headingType !== 'generic';

        if (isMajorHeading || isRecognizedType) {
          if (currentSection) sections.push(currentSection);
          currentSection = {
            heading: headingText,
            headingType,
            // Include the heading element in section html so parser strategies
            // can query headings (e.g. h2/h3 as step titles) in procedureHtml.
            html: (node.outerHTML || '')
          };
        } else {
          // Minor generic heading → treat as content within current section
          if (currentSection) {
            currentSection.html += (node.outerHTML || '');
          } else {
            beforeFirstHeading += (node.outerHTML || '');
          }
        }
      } else if (currentSection) {
        currentSection.html += (node.outerHTML || '');
      } else {
        beforeFirstHeading += (node.outerHTML || '');
      }
    }
    if (currentSection) sections.push(currentSection);

    // Aggregate section HTML into semantic buckets
    const hasProcedureSection = sections.some(s => s.headingType === 'procedure');

    let introHtml        = '';
    let procedureHtml    = '';
    let relatedInfoHtml  = '';
    let tagsHtml         = '';

    for (const section of sections) {
      switch (section.headingType) {
        case 'procedure': procedureHtml   += section.html; break;
        case 'intro':     introHtml       += section.html; break;
        case 'skip':      relatedInfoHtml += section.html; break;
        case 'tags':      tagsHtml        += section.html; break;
        case 'generic':
          // Generic sections are procedure content when no explicit section exists
          if (!hasProcedureSection) procedureHtml += section.html;
          break;
      }
    }

    // Attach pre-heading content to the appropriate bucket
    if (beforeFirstHeading) {
      if (hasProcedureSection) {
        introHtml = beforeFirstHeading + introHtml;
      } else {
        procedureHtml = beforeFirstHeading + procedureHtml;
      }
    }

    // If still no procedure content found, use full body HTML as fallback
    if (!procedureHtml) {
      procedureHtml = body.innerHTML;
    }

    // Extract tags from the tags section HTML
    const tags = [];
    if (tagsHtml) {
      const tmp = document.createElement('div');
      tmp.innerHTML = tagsHtml;
      const tagText = tmp.textContent.trim();
      tagText.split(/[,;|]/).forEach(t => {
        const trimmed = t.trim();
        if (trimmed) tags.push(trimmed);
      });
    }

    // Collect all sanitised images from the full body
    const images = [];
    body.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      if (this.sanitizeImageUrl(src)) {
        images.push({ alt, src });
      }
    });

    return {
      title: title || '',
      introHtml,
      procedureHtml,
      relatedInfoHtml,
      sections,
      dom: doc,
      plainText: body.textContent.replace(/\s+/g, ' ').trim(),
      tags,
      images,
      source: source || 'uploaded'
    };
  }
};

// Make available globally in browser context
if (typeof window !== 'undefined') {
  window.ArticleNormalizer = ArticleNormalizer;
}
