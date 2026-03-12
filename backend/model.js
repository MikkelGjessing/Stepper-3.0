/**
 * Ask Stepper – Model call interface
 *
 * Wraps the LLM provider API. All secret keys live in environment variables
 * and are NEVER exposed to the Chrome extension.
 *
 * The `callModel(sources, question)` function:
 *  1. Builds a system prompt with strict grounding instructions.
 *  2. Injects the retrieved article excerpts as context.
 *  3. Calls the LLM.
 *  4. Returns the text answer.
 */

'use strict';

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args)).catch(() => {
    return global.fetch(...args);
  });

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o';

/** Maximum number of source snippets to include in the context window. */
const MAX_SOURCES = 5;

/**
 * System prompt injected before every user question.
 * The model is instructed to answer ONLY from the provided excerpts.
 */
const SYSTEM_PROMPT = `\
You are Ask Stepper, an assistant that helps IT agents follow step-by-step guides.

Rules:
1. Answer ONLY using the article excerpts provided in the context below.
2. Do NOT invent steps, procedures, or facts not present in the excerpts.
3. If the excerpts do not contain enough information, reply:
   "I couldn't find a reliable answer in the knowledge base."
4. Cite the article title in your answer when relevant (e.g. "According to <title>…").
5. Prefer concise and operational answers.
6. If a user asks for a procedure, recommend opening the guide in Stepper.
7. If a user asks about the current article, explain it in simple terms without altering
   the actual instructions.
`;

/**
 * Build the context block that is inserted into the user message.
 * @param {Array<{articleId:string, title:string, snippet:string}>} sources
 * @returns {string}
 */
function buildContext(sources) {
  if (!sources || sources.length === 0) {
    return '(No relevant articles found.)';
  }
  return sources
    .slice(0, MAX_SOURCES)
    .map(
      (s, i) =>
        `[${i + 1}] Article: "${s.title}" (ID: ${s.articleId})\n${s.snippet}`
    )
    .join('\n\n');
}

/**
 * Call the language model and return the answer text.
 *
 * @param {Array<{articleId:string, title:string, snippet:string, score:number}>} sources
 * @param {string} question
 * @returns {Promise<string>}
 */
async function callModel(sources, question) {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY is not configured on the backend.');
  }

  const context = buildContext(sources);
  const userMessage = `Context:\n${context}\n\nQuestion: ${question}`;

  const payload = {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage }
    ],
    temperature: 0.2,
    max_tokens: 512
  };

  const res = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM API returned ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const answer =
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;

  if (!answer) {
    throw new Error('LLM returned an empty response.');
  }

  return answer.trim();
}

module.exports = { callModel };
