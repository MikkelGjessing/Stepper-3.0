/**
 * Ask Stepper – Backend HTTP server
 *
 * Provides:
 *   GET  /health        – liveness probe
 *   POST /search        – KB article search (no LLM)
 *   POST /chat          – retrieval-augmented chat (LLM + KB)
 *
 * All LLM API keys are kept in environment variables.
 * The Chrome extension never holds secrets.
 *
 * Usage:
 *   cp .env.example .env   # fill in secrets
 *   npm install
 *   npm start
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { retrieveForKB, retrieveForCurrentArticle } = require('./retrieval');
const { callModel, NO_ANSWER_FALLBACK } = require('./model');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── CORS ──────────────────────────────────────────────────────────────────────
const rawOrigins = (process.env.ALLOWED_ORIGINS || '').trim();
const allowedOrigins = rawOrigins
  ? rawOrigins.split(',').map(o => o.trim()).filter(Boolean)
  : null; // null = allow all

app.use(
  cors({
    origin: allowedOrigins
      ? (origin, cb) => {
          // Allow requests with no origin header (e.g. server-to-server, health probes)
          if (!origin || allowedOrigins.includes(origin)) {
            cb(null, true);
          } else {
            cb(new Error(`CORS: origin "${origin}" is not allowed`));
          }
        }
      : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

app.use(express.json({ limit: '256kb' }));

// ── Health probe ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'stepper-chat-backend', ts: new Date().toISOString() });
});

// ── POST /search ──────────────────────────────────────────────────────────────
/**
 * Perform a KB search and return ranked article excerpts.
 * Does NOT call the LLM.
 *
 * Request body: { query: string }
 * Response:     { results: ChatSource[] }
 */
app.post('/search', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const results = await retrieveForKB(query.trim());
    return res.json({ results });
  } catch (err) {
    console.error('[/search] error:', err);
    return res.status(500).json({ error: 'Search failed. Please try again later.' });
  }
});

// ── POST /chat ────────────────────────────────────────────────────────────────
/**
 * Retrieval-augmented chat endpoint.
 *
 * Request body  (ChatRequest shape, see src/shared/types.js):
 *   {
 *     message: string,
 *     mode: 'kb' | 'current_article',
 *     currentArticleId?: string,
 *     currentArticleContent?: string,
 *     sessionId: string
 *   }
 *
 * Response (ChatResponse shape):
 *   {
 *     answer: string,
 *     sources: ChatSource[],
 *     suggestedActions: SuggestedAction[],
 *     sessionId: string
 *   }
 */
app.post('/chat', async (req, res) => {
  const {
    message,
    mode,
    currentArticleId,
    currentArticleContent,
    sessionId
  } = req.body || {};

  // ── Input validation ──────────────────────────────────────────────────────
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (mode && mode !== 'kb' && mode !== 'current_article') {
    return res.status(400).json({ error: 'mode must be "kb" or "current_article"' });
  }

  const resolvedMode = mode || 'kb';
  const trimmedMessage = message.trim();

  try {
    // ── Retrieval ─────────────────────────────────────────────────────────────
    let sources;
    if (resolvedMode === 'current_article') {
      sources = await retrieveForCurrentArticle(
        currentArticleId || '',
        currentArticleContent || '',
        trimmedMessage
      );
    } else {
      sources = await retrieveForKB(trimmedMessage);
    }

    // ── Generation ────────────────────────────────────────────────────────────
    let answer;
    if (sources.length === 0) {
      answer = NO_ANSWER_FALLBACK;
    } else {
      answer = await callModel(sources, trimmedMessage);
    }

    // ── Suggested actions ─────────────────────────────────────────────────────
    /** @type {Array<{type:string, label:string, articleId?:string}>} */
    const suggestedActions = sources
      .filter(s => s.articleId && s.title)
      .slice(0, 3)
      .map(s => ({
        type: 'open_article',
        label: `Open: ${s.title}`,
        articleId: s.articleId
      }));

    /** @type {import('../src/shared/types').ChatResponse} */
    const response = {
      answer,
      sources,
      suggestedActions,
      sessionId: sessionId || null
    };

    return res.json(response);
  } catch (err) {
    console.error('[/chat] error:', err);
    return res
      .status(500)
      .json({ error: 'Chat service encountered an error. Please try again later.' });
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[stepper-chat-backend] Listening on http://localhost:${PORT}`);
});

module.exports = app; // for testing
