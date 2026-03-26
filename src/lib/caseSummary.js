/**
 * Case Summary Helper
 * Generates a CRM-ready text summary from a list of completed instructions.
 */

/**
 * Generate a readable CRM log summary from completed instructions.
 *
 * @param {Array<{articleId: string, articleTitle: string, completedAt: string, order: number}>} completedInstructions
 * @returns {string} Plain-text summary suitable for pasting into a CRM case log
 */
function generateCaseSummary(completedInstructions) {
  if (!completedInstructions || completedInstructions.length === 0) {
    return 'Case completed. No instructions were completed during this case.';
  }

  const sorted = [...completedInstructions].sort((a, b) => a.order - b.order);

  const lines = sorted.map((item, index) => {
    const num = index + 1;
    const title = (item.articleTitle || 'Untitled').trim();
    return `${num}. ${title}`;
  });

  return (
    'Case completed. The following instructions were completed in order:\n' +
    lines.join('\n')
  );
}

// Export for use as a module or inline script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateCaseSummary };
}
