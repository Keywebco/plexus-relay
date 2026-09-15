/**
 * Plexus Relay — Express backend
 *
 * Pure message bus. No LLM, no AI — all intelligence lives at the edges.
 * Routes:
 *   POST /relay   — append a message (name must be in ROSTER)
 *   GET  /relay    — read messages from cursor onward
 *
 * Persistence: in-memory array, flushed to disk every 30s.
 *   - Glitch: .data/messages.json
 *   - Other:  /tmp/messages.json (fallback)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ── Config from env ────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROSTER = (process.env.ROSTER || 'Roger,Catalyst,Pontus,Aria')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES, 10) || 5000;
const MAX_TEXT_LEN = 2000;
const MAX_BYTES = 5 * 1024 * 1024; // ~5 MB rotation trigger

// ── CORS origins ───────────────────────────────────────────────────
function buildOrigins() {
  const defaults = [
    'https://keywebco.github.io',
    /https?:\/\/.*\.glitch\.me$/,
    /https?:\/\/localhost(:\d+)?$/,
    /https?:\/\/127\.0\.0\.1(:\d+)?$/
  ];
  if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(',').forEach(o => {
      const trimmed = o.trim();
      if (trimmed) defaults.push(trimmed);
    });
  }
  return defaults;
}

// ── Persistence path ───────────────────────────────────────────────
function storagePath() {
  // Glitch keeps writable data in .data/
  const glitchDir = path.join(__dirname, '.data');
  if (fs.existsSync(glitchDir)) {
    return path.join(glitchDir, 'messages.json');
  }
  // Fallback for Render / local
  return path.join('/tmp', 'messages.json');
}

const STORE_PATH = storagePath();

// ── Message store ──────────────────────────────────────────────────
let messages = [];

function loadMessages() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        messages = parsed;
        console.log(`[plexus] Loaded ${messages.length} messages from ${STORE_PATH}`);
      }
    }
  } catch (err) {
    console.warn('[plexus] Could not load stored messages:', err.message);
  }
}

function flushMessages() {
  try {
    // Ensure directory exists
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(messages), 'utf8');
  } catch (err) {
    console.warn('[plexus] Flush failed:', err.message);
  }
}

function estimateBytes() {
  // Quick estimate — JSON.stringify length is close enough
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

function rotateIfNeeded() {
  const overCount = messages.length > MAX_MESSAGES;
  const overSize = estimateBytes() > MAX_BYTES;
  if (!overCount && !overSize) return;

  const dropCount = Math.ceil(messages.length * 0.2);
  messages = messages.slice(dropCount);
  // Re-index remaining messages
  messages.forEach((m, i) => { m.id = i; });
  console.log(`[plexus] Rotated: dropped ${dropCount} oldest messages. ${messages.length} remain.`);
}

// ── Rate limiter (20 writes / minute / IP) ─────────────────────────
const rateBuckets = new Map(); // ip -> { count, resetAt }

function rateOk(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count <= 20;
}

// Sweep stale buckets every 2 minutes to avoid memory creep
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    if (now > b.resetAt) rateBuckets.delete(ip);
  }
}, 120000);

// ── Express app ────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: buildOrigins(),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '8kb' }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /relay — send a message ───────────────────────────────────
app.post('/relay', (req, res) => {
  // Rate limit
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateOk(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Max 20 writes per minute.' });
  }

  const { name, text } = req.body || {};

  // Validate name
  if (!name || typeof name !== 'string' || !ROSTER.includes(name.trim())) {
    return res.status(400).json({ error: `Name must be one of: ${ROSTER.join(', ')}` });
  }

  // Validate text
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required.' });
  }
  if (text.length > MAX_TEXT_LEN) {
    return res.status(400).json({ error: `Text exceeds ${MAX_TEXT_LEN} character limit.` });
  }

  // Append
  const msg = {
    id: messages.length,
    name: name.trim(),
    text: text,
    ts: Date.now()
  };
  messages.push(msg);

  // Rotate if needed
  rotateIfNeeded();

  return res.json({ ok: true, cursor: messages.length });
});

// ── GET /relay — read messages from cursor ─────────────────────────
app.get('/relay', (req, res) => {
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const slice = messages.slice(cursor);
  return res.json({
    messages: slice,
    cursor: messages.length
  });
});

// ── Health check ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, messages: messages.length, roster: ROSTER });
});

// ── Start ──────────────────────────────────────────────────────────
loadMessages();

// Flush to disk every 30 seconds
const flushInterval = setInterval(flushMessages, 30000);

const server = app.listen(PORT, () => {
  console.log(`[plexus] Relay listening on port ${PORT}`);
  console.log(`[plexus] Roster: ${ROSTER.join(', ')}`);
  console.log(`[plexus] Max messages: ${MAX_MESSAGES}`);
  console.log(`[plexus] Store path: ${STORE_PATH}`);
});

// Graceful shutdown — flush before exit
function shutdown() {
  console.log('[plexus] Shutting down, flushing messages...');
  clearInterval(flushInterval);
  flushMessages();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app; // For testing
