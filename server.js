#!/usr/bin/env node
'use strict';
/**
 * Claude prompt-caching proxy for JanitorAI
 * ------------------------------------------
 * Sits between JanitorAI (or any client) and api.anthropic.com and adds
 * prompt-caching breakpoints (cache_control) to every request, so the
 * character card, persona and chat history are read from Anthropic's cache
 * at a fraction of the price instead of being re-billed in full every turn.
 *
 * Endpoints (all accept the URL with or without the "/v1" prefix)
 *   POST /                         OpenAI format (what JanitorAI's "Proxy" mode sends)
 *   POST /chat/completions         OpenAI format  -> translated to Anthropic (+ caching), response translated back
 *   POST /messages                 Anthropic format -> forwarded as-is (+ caching)
 *   GET  /models                   forwarded to Anthropic
 *   GET  /                         setup page (shows exactly what to type into JanitorAI)
 *   GET  /health                   JSON health for Render
 *   GET  /stats                    cumulative usage / savings since the process started
 *
 * Zero dependencies. Needs Node 18+.
 */

const http = require('http');
const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Configuration (environment variables)
// ----------------------------------------------------------------------------
const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k])).trim();

const PORT = parseInt(env('PORT', '10000'), 10);
const UPSTREAM = env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/+$/, '');
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY');
const PROXY_KEY = env('PROXY_KEY');
const CACHE_TTL = env('CACHE_TTL', '5m').toLowerCase() === '1h' ? '1h' : '5m';
const DEFAULT_MAX_TOKENS = parseInt(env('DEFAULT_MAX_TOKENS', '2048'), 10) || 2048;
const ANTHROPIC_VERSION = env('ANTHROPIC_VERSION', '2023-06-01');
const LOG_REQUESTS = env('LOG_REQUESTS', 'true').toLowerCase() !== 'false';
const PROXY_ADMIN = env('PROXY_ADMIN');
// Thinking depth for models with always-on adaptive thinking (5.x). Roleplay rarely benefits from
// deep thinking and thinking tokens are billed as output, so "low" is the cheap default.
// Allowed: low | medium | high | xhigh | max | "" (empty = leave the model's own default).
const EFFORT = (() => { const e = env('EFFORT', 'low').toLowerCase(); return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : ''; })();
// Extra max_tokens granted on thinking models so the reply isn't cut off before any text appears.
const THINKING_HEADROOM = Math.max(0, parseInt(env('THINKING_HEADROOM', '1024'), 10) || 0);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const VERSION = (() => { try { return require('./package.json').version; } catch { return 'dev'; } })();

// How clients authenticate:
//   * an Anthropic key (sk-ant-...) in the API-key field is always forwarded as-is
//   * anything else must equal PROXY_KEY, and the server-side ANTHROPIC_API_KEY is used
// A half-configured server (one of the two set, the other empty) still starts and
// explains itself on the landing page instead of crashing the deploy.
const SERVER_KEY_USABLE = Boolean(ANTHROPIC_API_KEY && PROXY_KEY);
const CONFIG_WARNINGS = [];
if (ANTHROPIC_API_KEY && !PROXY_KEY) {
  CONFIG_WARNINGS.push('ANTHROPIC_API_KEY is set but PROXY_KEY is empty, so the stored key is NOT being used (that would let anyone with this URL spend your money). Set PROXY_KEY in the Environment tab, or put your Anthropic key directly into JanitorAI instead.');
}
if (PROXY_KEY && !ANTHROPIC_API_KEY) {
  CONFIG_WARNINGS.push('PROXY_KEY is set but ANTHROPIC_API_KEY is empty. Add your Anthropic key (sk-ant-...) in the Environment tab, otherwise the PROXY_KEY cannot be used.');
}
if (ANTHROPIC_API_KEY && !/^sk-ant-/.test(ANTHROPIC_API_KEY)) {
  CONFIG_WARNINGS.push('ANTHROPIC_API_KEY does not look like an Anthropic key (they start with "sk-ant-"). Double-check it in the Environment tab.');
}
if (PROXY_KEY && /^sk-ant-/.test(PROXY_KEY)) {
  CONFIG_WARNINGS.push('PROXY_KEY looks like an Anthropic key. It should be a password you make up; the Anthropic key goes in ANTHROPIC_API_KEY.');
}
if (PROXY_KEY && PROXY_KEY.length < 12) {
  CONFIG_WARNINGS.push('PROXY_KEY is very short. Anyone who guesses it can spend on your Anthropic key; use at least 12 random characters.');
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const nowSec = () => Math.floor(Date.now() / 1000);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      req.headers['access-control-request-headers'] ||
      'Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(req),
  });
  res.end(body);
}

// Error in the shape each client expects.
//   anthropic : {type:"error", error:{type, message}}
//   openai    : {error:{message, type, code}}
//   test      : {error:"PROXY ERROR <status>: <message>"}   (JanitorAI's "Test" button shows this string)
function sendError(req, res, status, message, format, type) {
  const t = type || (status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : status === 404 ? 'not_found_error' : 'api_error');
  if (format === 'test') return sendJson(req, res, status, { error: `PROXY ERROR ${status}: ${message}` });
  if (format === 'openai') return sendJson(req, res, status, { error: { message, type: t, code: status === 401 ? 'invalid_api_key' : null, param: null } });
  return sendJson(req, res, status, { type: 'error', error: { type: t, message } });
}

function publicUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim() || 'http';
  const host = (req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`).toString().split(',')[0].trim();
  return `${proto}://${host}`;
}

function incomingKey(req) {
  const x = (req.headers['x-api-key'] || '').toString().trim();
  if (x) return x;
  const auth = (req.headers['authorization'] || '').toString().trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : auth; // some clients send the bare key without "Bearer"
}

function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Decide which key goes upstream. Never logs keys.
function resolveUpstreamKey(req) {
  const key = incomingKey(req).replace(/,.*$/, '').trim(); // ignore GFJ-style "key1,key2" lists: use the first
  if (!key) {
    return { error: SERVER_KEY_USABLE
      ? 'No API key received. Put your PROXY_KEY (the password you set on Render) into JanitorAI\'s API key field.'
      : 'No API key received. Put your Anthropic API key (sk-ant-...) into JanitorAI\'s API key field.' };
  }
  if (/^sk-ant-/i.test(key)) return { key, tag: key.slice(-4), via: 'own key' };
  if (SERVER_KEY_USABLE && safeEqual(key, PROXY_KEY)) return { key: ANTHROPIC_API_KEY, tag: 'proxy', via: 'PROXY_KEY' };
  if (PROXY_KEY && !ANTHROPIC_API_KEY) return { error: 'The proxy has a PROXY_KEY but no ANTHROPIC_API_KEY. Add your Anthropic key in the Render Environment tab.' };
  if (SERVER_KEY_USABLE) return { error: 'Wrong key. The API key field must contain the PROXY_KEY you set on Render (or an Anthropic key starting with sk-ant-).' };
  return { error: 'That is not an Anthropic key (they start with "sk-ant-"). If you meant to use a server-side key, set ANTHROPIC_API_KEY and PROXY_KEY on Render.' };
}

// Accept a few spellings JanitorAI users commonly type.
function normaliseModel(model) {
  let m = String(model || '').trim();
  m = m.replace(/^anthropic\//i, '');                 // OpenRouter style
  m = m.replace(/^(claude-[a-z]+-\d)\.(\d)/i, '$1-$2'); // claude-sonnet-5.5 -> claude-sonnet-5-5
  return m;
}

// ----------------------------------------------------------------------------
// Model compatibility
// ----------------------------------------------------------------------------
// The current 5.x models (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable/Mythos) return a
// 400 for `temperature`/`top_p`/`top_k`, for `thinking: disabled/enabled`, and for a
// history that ends with an assistant message; adaptive thinking is always on and
// its tokens count against max_tokens.  JanitorAI sends temperature on every
// request, so the proxy strips what the model will not accept.  Anything it does
// not know in advance it learns from the first 400 (per model, until restart).
const RESTRICTED_5X = /^claude-(opus-5-5|sonnet-5-5|haiku-5-5|fable-|mythos-)/i;
const modelQuirks = new Map(); // model -> Set('sampling' | 'effort' | 'thinking')
const quirksOf = (model) => { let s = modelQuirks.get(model); if (!s) { s = new Set(); modelQuirks.set(model, s); } return s; };

// Mutates body. Returns a list of human-readable adjustments (for logs).
function applyModelCompat(body) {
  const notes = [];
  const model = body.model || '';
  const q = quirksOf(model);
  const restricted = RESTRICTED_5X.test(model);

  if (restricted || q.has('sampling')) {
    for (const k of ['temperature', 'top_p', 'top_k']) if (k in body) { delete body[k]; notes.push(`dropped ${k}`); }
  }
  if (body.thinking && (restricted || q.has('thinking')) && ['disabled', 'enabled'].includes(body.thinking.type)) {
    delete body.thinking; notes.push('dropped thinking config (always-on model)');
  }
  if (restricted) {
    if (EFFORT && !q.has('effort') && !(body.output_config && body.output_config.effort)) {
      body.output_config = { ...(body.output_config || {}), effort: EFFORT };
      notes.push(`effort=${EFFORT}`);
    }
    if (THINKING_HEADROOM && Number.isFinite(body.max_tokens) && !body.__headroomApplied) {
      body.max_tokens += THINKING_HEADROOM;
      Object.defineProperty(body, '__headroomApplied', { value: true, enumerable: false });
      notes.push(`max_tokens +${THINKING_HEADROOM} for thinking`);
    }
  }
  return notes;
}

// Inspect a 400 from Anthropic; if it is about a parameter we can drop, drop it,
// remember the quirk for this model, and say so. Returns null if nothing to fix.
function learnFrom400(body, errorText) {
  let msg = errorText;
  try { const j = JSON.parse(errorText); msg = (j.error && j.error.message) || errorText; } catch { /* keep */ }
  const q = quirksOf(body.model || '');
  if (/temperature|top_p|top_k|sampling/i.test(msg) && ['temperature', 'top_p', 'top_k'].some((k) => k in body)) {
    for (const k of ['temperature', 'top_p', 'top_k']) delete body[k];
    q.add('sampling');
    return 'dropped temperature/top_p/top_k';
  }
  if (/output_config|effort/i.test(msg) && body.output_config) {
    delete body.output_config;
    q.add('effort');
    return 'dropped output_config.effort';
  }
  if (/thinking/i.test(msg) && body.thinking) {
    delete body.thinking;
    q.add('thinking');
    return 'dropped thinking config';
  }
  return null;
}

// POST to Anthropic, retrying up to twice after a 400 that learnFrom400 can fix.
async function postWithCompat(body, auth, req, signal) {
  for (let attempt = 0; ; attempt++) {
    const upstream = await callAnthropic('/v1/messages', body, auth.key, req, signal);
    if (upstream.status !== 400 || attempt >= 2) return upstream;
    const text = await upstream.text();
    const fix = learnFrom400(body, text);
    if (!fix) return new Response(text, { status: 400, headers: upstream.headers });
    if (LOG_REQUESTS) console.log(`[compat key=…${auth.tag}] ${body.model}: ${fix} after a 400, retrying`);
  }
}

// ----------------------------------------------------------------------------
// Prompt-caching breakpoint planner
// ----------------------------------------------------------------------------
//
// Anthropic only writes a cache entry at the exact block you mark, and only
// re-uses it when a later request has an identical prefix ending at a marked
// position (it looks back up to 20 blocks for earlier writes).  The trap for
// a roleplay frontend is that it usually appends something that is *not* part
// of the saved history to the end of every request (a jailbreak / "custom
// prompt" block, or an assistant prefill).  Putting the breakpoint on that
// trailing block writes an entry that no later request can ever hit.
//
// So the proxy:
//   1. always marks the end of the system prompt (character card, persona ...);
//   2. remembers the shape of recent requests per API key and works out how
//      many trailing messages are re-injected each turn ("t"), then marks the
//      last *stable* history message instead of the injected tail;
//   3. until t is known, marks the last few messages so that whichever one is
//      really the end of the history gets a cache write on the first turn.
//
// Breakpoints themselves are free; only writes/reads are billed.

const CACHEABLE_TYPES = new Set(['text', 'image', 'document', 'tool_use', 'tool_result']);

function cacheControl() {
  return CACHE_TTL === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function isCacheable(block) {
  if (!block || typeof block !== 'object' || !CACHEABLE_TYPES.has(block.type)) return false;
  if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0;
  return true;
}

function clientAlreadyCaches(body) {
  if (body.cache_control) return true;
  const scan = (arr) => Array.isArray(arr) && arr.some((b) => b && typeof b === 'object' && b.cache_control);
  if (scan(body.system) || scan(body.tools)) return true;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (m && scan(m.content)) return true;
  }
  return false;
}

// Mark the last cacheable block of a content array. Returns true if a new mark was added.
function markLast(blocks, cc) {
  if (!Array.isArray(blocks)) return false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isCacheable(blocks[i])) {
      if (blocks[i].cache_control) return false; // already marked by an earlier strategy
      blocks[i].cache_control = cc;
      return true;
    }
  }
  return false;
}

// Normalise string content into block arrays (semantically identical for the API).
function normaliseForCaching(body) {
  if (typeof body.system === 'string') {
    body.system = body.system.trim().length ? [{ type: 'text', text: body.system }] : undefined;
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && typeof m.content === 'string') m.content = [{ type: 'text', text: m.content }];
    }
  }
}

// --- per-API-key memory of recent request shapes --------------------------
const MAX_KEYS = 500;
const MAX_RECENT = 40;
const memory = new Map(); // keyHash -> { recent: [{ sigs: string[], at: number }], learnedT: number|null }

function getMemory(keyHash) {
  let m = memory.get(keyHash);
  if (m) {
    memory.delete(keyHash); // refresh LRU position
  } else {
    m = { recent: [], learnedT: null };
    if (memory.size >= MAX_KEYS) memory.delete(memory.keys().next().value);
  }
  memory.set(keyHash, m);
  return m;
}

function messageSignatures(body) {
  const sigs = [sha1('system:' + JSON.stringify(body.system || null))];
  for (const m of body.messages || []) sigs.push(sha1((m && m.role) + ':' + JSON.stringify((m && m.content) || null)));
  return sigs;
}

function lcpLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function arraysEqual(a, b) {
  return a.length === b.length && lcpLength(a, b) === a.length;
}

// Given message-signature lists for the previous and current request of the
// same chat, work out how many trailing messages are re-injected each turn.
function detectTrailing(prev, cur) {
  if (arraysEqual(prev, cur)) return null; // regenerate / retry: nothing new to learn
  for (let t = 3; t >= 0; t--) {
    if (t >= prev.length || t >= cur.length) continue;
    const prevBody = prev.slice(0, prev.length - t);
    const curBody = cur.slice(0, cur.length - t);
    const tailMatches = t === 0 || arraysEqual(prev.slice(prev.length - t), cur.slice(cur.length - t));
    if (tailMatches && curBody.length > prevBody.length && lcpLength(prevBody, curBody) === prevBody.length) return t;
  }
  return null;
}

// Mutates body: adds cache_control breakpoints. Returns a description for logging.
function applyCaching(body, keyHash) {
  if (clientAlreadyCaches(body)) return { skipped: 'client already sets cache_control' };
  normaliseForCaching(body);

  const cc = cacheControl();
  const mem = getMemory(keyHash);
  const sigs = messageSignatures(body);

  // Find the most similar recent request (same system prompt + longest shared history).
  let best = null;
  let bestLcp = 1; // need more than just the system prompt in common
  for (const r of mem.recent) {
    const l = lcpLength(r.sigs, sigs);
    if (l > bestLcp) { bestLcp = l; best = r; }
  }
  let t = mem.learnedT;
  if (best) {
    const detected = detectTrailing(best.sigs.slice(1), sigs.slice(1));
    if (detected !== null) { t = detected; mem.learnedT = detected; }
  }
  mem.recent.push({ sigs, at: Date.now() });
  if (mem.recent.length > MAX_RECENT) mem.recent.shift();

  let budget = 4;
  const placed = [];
  if (Array.isArray(body.system) && markLast(body.system, cc)) { budget--; placed.push('system'); }

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const n = msgs.length;
  if (t !== null && t !== undefined) {
    const idx = n - 1 - t;
    if (idx >= 0 && budget > 0 && markLast(msgs[idx].content, cc)) { budget--; placed.push(`msg[${idx + 1}/${n}]`); }
  } else {
    // Unknown layout yet: cover the last three messages so the real end of
    // history gets a cache write whichever one it is.
    for (let i = n - 1; i >= 0 && i >= n - 3 && budget > 0; i--) {
      if (markLast(msgs[i].content, cc)) { budget--; placed.push(`msg[${i + 1}/${n}]`); }
    }
  }
  return { placed, trailing: t === null || t === undefined ? 'unknown' : t, ttl: CACHE_TTL };
}

// ----------------------------------------------------------------------------
// Usage accounting / savings estimate
// ----------------------------------------------------------------------------
// USD per million input tokens and cache-read multiplier, by model-id fragment.
// (From platform.claude.com pricing, Oct 2026. Only used for the log estimate.)
const PRICE_TABLE = [
  ['fable-5-1', 10, 0.025], ['mythos-5-1', 10, 0.025],
  ['opus-5-5', 4, 0.05], ['sonnet-5-5', 2, 0.05],
  ['haiku-5-5', 0.10, 0.1],
  ['fable-5', 10, 0.1], ['mythos-5', 10, 0.1], ['opus-5', 5, 0.1], ['sonnet-5', 2, 0.1],
  ['opus-4-8', 5, 0.1], ['opus-4-7', 5, 0.1], ['opus-4-6', 5, 0.1], ['opus-4-5', 5, 0.1],
  ['opus-4-1', 15, 0.1], ['opus-4', 15, 0.1],
  ['sonnet-4-6', 3, 0.1], ['sonnet-4-5', 3, 0.1], ['sonnet-4', 3, 0.1],
  ['haiku-4-5', 1, 0.1], ['haiku-3-5', 0.8, 0.1], ['3-5-haiku', 0.8, 0.1],
  ['opus', 5, 0.1], ['sonnet', 3, 0.1], ['haiku', 1, 0.1],
];

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const [frag, base, readMult] of PRICE_TABLE) if (m.includes(frag)) return { base, readMult };
  return null;
}

const totals = { requests: 0, cacheRead: 0, cacheWrite: 0, uncached: 0, output: 0, savedUsd: 0, startedAt: new Date().toISOString() };

function recordUsage(model, usage, tag, cacheInfo) {
  if (!usage) return;
  const read = usage.cache_read_input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const fresh = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const totalIn = read + write + fresh;
  totals.requests++;
  totals.cacheRead += read;
  totals.cacheWrite += write;
  totals.uncached += fresh;
  totals.output += out;

  let savedTxt = '';
  const p = priceFor(model);
  if (p) {
    const writeMult = CACHE_TTL === '1h' ? 2 : 1.25;
    const withoutCache = (totalIn * p.base) / 1e6;
    const withCache = ((fresh + read * p.readMult + write * writeMult) * p.base) / 1e6;
    const saved = withoutCache - withCache;
    totals.savedUsd += saved;
    savedTxt = ` | this turn: $${withCache.toFixed(4)} instead of $${withoutCache.toFixed(4)} | saved so far ≈ $${totals.savedUsd.toFixed(2)}`;
  }
  if (LOG_REQUESTS) {
    const pct = totalIn ? Math.round((100 * read) / totalIn) : 0;
    const bp = cacheInfo && cacheInfo.placed ? ` | breakpoints: ${cacheInfo.placed.join(', ')} (trailing=${cacheInfo.trailing})` : cacheInfo && cacheInfo.skipped ? ` | ${cacheInfo.skipped}` : '';
    const cp = cacheInfo && cacheInfo.compat ? ` | compat: ${cacheInfo.compat.join(', ')}` : '';
    console.log(`[usage key=…${tag}] ${model} | input ${totalIn} = cached ${read} (${pct}%) + newly-cached ${write} + uncached ${fresh} | output ${out}${savedTxt}${bp}${cp}`);
  }
}

// Parse Anthropic SSE lines incrementally to pick out usage.
function makeSseUsageTracker(onEvent) {
  let buffer = '';
  const usage = {};
  let model = null;
  return {
    feed(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === 'message_start' && evt.message) {
          model = evt.message.model || model;
          Object.assign(usage, evt.message.usage || {});
        } else if (evt.type === 'message_delta' && evt.usage) {
          Object.assign(usage, evt.usage);
        }
        if (onEvent) onEvent(evt);
      }
    },
    result() { return { usage, model }; },
  };
}

// ----------------------------------------------------------------------------
// Upstream call
// ----------------------------------------------------------------------------
async function callAnthropic(path, body, key, req, signal, method = 'POST') {
  const headers = {
    'x-api-key': key,
    'anthropic-version': (req.headers['anthropic-version'] || ANTHROPIC_VERSION).toString(),
    'accept': body && body.stream ? 'text/event-stream' : 'application/json',
  };
  if (body) headers['content-type'] = 'application/json';
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'].toString();
  return fetch(UPSTREAM + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

function abortOnClientClose(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac;
}

// Turn an upstream error body into a message a JanitorAI user can act on.
function explainUpstreamError(status, text, auth) {
  let msg = text;
  let type;
  try { const j = JSON.parse(text); msg = (j.error && j.error.message) || text; type = j.error && j.error.type; } catch { /* keep text */ }
  msg = String(msg).slice(0, 600);
  if (status === 401) {
    msg += auth.via === 'PROXY_KEY'
      ? ' — Anthropic rejected the ANTHROPIC_API_KEY stored on Render. Check it in the Environment tab.'
      : ' — Anthropic rejected the key you entered in JanitorAI.';
  } else if (status === 404 && /model/i.test(msg)) {
    msg += ' — Check the Model name in JanitorAI (for example claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5).';
  } else if (status === 400 && /prefill|end with a user|final message|last message.*assistant/i.test(msg)) {
    msg += ' — This model does not accept a chat that ends with an assistant message. Send a normal message instead of continuing the bot\'s last reply.';
  } else if (status === 429 || status === 529) {
    msg += ' — Rate limited / overloaded. Wait a moment and try again.';
  } else if (status === 400 && /credit|billing|balance/i.test(msg)) {
    msg += ' — Top up your Anthropic account at console.anthropic.com.';
  }
  return { msg, type };
}

// ----------------------------------------------------------------------------
// Native Anthropic endpoint: POST /v1/messages
// ----------------------------------------------------------------------------
async function handleNativeMessages(req, res, body, auth) {
  if (body.model) body.model = normaliseModel(body.model);
  const compat = applyModelCompat(body);
  const cacheInfo = applyCaching(body, sha1(auth.key));
  if (compat.length) cacheInfo.compat = compat;
  const ac = abortOnClientClose(res);
  let upstream;
  try {
    upstream = await postWithCompat(body, auth, req, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) return;
    return sendError(req, res, 502, `Could not reach Anthropic: ${e.message}`, 'anthropic');
  }

  const headers = { ...corsHeaders(req) };
  const ct = upstream.headers.get('content-type');
  if (ct) headers['Content-Type'] = ct;
  const rid = upstream.headers.get('request-id');
  if (rid) headers['request-id'] = rid;

  if (!upstream.ok || !body.stream) {
    const text = await upstream.text();
    headers['Content-Length'] = Buffer.byteLength(text);
    res.writeHead(upstream.status, headers);
    res.end(text);
    if (upstream.ok) {
      try { const j = JSON.parse(text); recordUsage(j.model || body.model, j.usage, auth.tag, cacheInfo); } catch { /* ignore */ }
    } else if (LOG_REQUESTS) {
      console.log(`[upstream ${upstream.status} key=…${auth.tag}] ${text.slice(0, 300)}`);
    }
    return;
  }

  headers['Cache-Control'] = 'no-cache';
  headers['X-Accel-Buffering'] = 'no';
  res.writeHead(upstream.status, headers);
  res.flushHeaders();
  const tracker = makeSseUsageTracker();
  const decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      tracker.feed(decoder.decode(chunk, { stream: true }));
    }
  } catch (e) {
    if (!ac.signal.aborted && LOG_REQUESTS) console.log(`[stream error key=…${auth.tag}] ${e.message}`);
  }
  res.end();
  const r = tracker.result();
  recordUsage(r.model || body.model, r.usage, auth.tag, cacheInfo);
}

// ----------------------------------------------------------------------------
// OpenAI-compatible endpoint: POST /v1/chat/completions (what JanitorAI sends)
// ----------------------------------------------------------------------------
function dataUrlToImageSource(url) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url || '');
  if (m) return { type: 'base64', media_type: m[1], data: m[2] };
  if (/^https?:\/\//i.test(url || '')) return { type: 'url', url };
  return null;
}

function openaiContentToBlocks(content) {
  if (typeof content === 'string') {
    return content.trim().length ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length) {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
      const source = dataUrlToImageSource(url);
      if (source) out.push({ type: 'image', source });
    }
  }
  return out;
}

function openaiToAnthropic(oa) {
  const out = {};
  out.model = normaliseModel(oa.model);
  const mt = Number(oa.max_tokens ?? oa.max_completion_tokens);
  out.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.floor(mt) : DEFAULT_MAX_TOKENS;
  out.stream = Boolean(oa.stream);
  // Anthropic rejects temperature+top_p together on newer models; prefer temperature.
  if (oa.temperature !== undefined && oa.temperature !== null && Number.isFinite(Number(oa.temperature))) {
    out.temperature = clamp(Number(oa.temperature), 0, 1);
  } else if (oa.top_p !== undefined && oa.top_p !== null && Number.isFinite(Number(oa.top_p))) {
    out.top_p = clamp(Number(oa.top_p), 0, 1);
  }
  if (oa.top_k !== undefined && Number.isFinite(Number(oa.top_k)) && Number(oa.top_k) > 0) out.top_k = Math.floor(Number(oa.top_k));
  if (oa.stop) {
    const stops = (Array.isArray(oa.stop) ? oa.stop : [oa.stop]).filter((s) => typeof s === 'string' && s.length);
    if (stops.length) out.stop_sequences = stops.slice(0, 8);
  }
  if (oa.thinking && typeof oa.thinking === 'object') out.thinking = oa.thinking; // pass through if a client sends Anthropic-style thinking
  if (oa.metadata && typeof oa.metadata === 'object' && typeof oa.metadata.user_id === 'string') out.metadata = { user_id: oa.metadata.user_id };

  const system = [];
  const messages = [];
  let seenChat = false;
  for (const m of Array.isArray(oa.messages) ? oa.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const blocks = openaiContentToBlocks(m.content);
    if (!blocks.length) continue;
    if (role === 'system' || role === 'developer') {
      if (!seenChat) { system.push(...blocks.filter((b) => b.type === 'text')); continue; }
      messages.push({ role: 'user', content: blocks }); // mid-chat system note -> user turn
      continue;
    }
    if (role === 'user' || role === 'assistant') {
      seenChat = true;
      messages.push({ role, content: blocks });
    }
    // 'tool' / function roles are not used by chat frontends; ignored.
  }
  if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '[Start of conversation]' }] });
  if (messages[0].role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '[Start of conversation]' }] });
  // A final assistant message (prefill) must not end with whitespace.
  const last = messages[messages.length - 1];
  if (last.role === 'assistant') {
    for (let i = last.content.length - 1; i >= 0; i--) {
      const b = last.content[i];
      if (b.type === 'text') { b.text = b.text.replace(/\s+$/, ''); if (!b.text.length) last.content.splice(i, 1); break; }
    }
    if (!last.content.length) messages.pop();
  }
  if (system.length) out.system = system;
  out.messages = messages;
  return out;
}

// Shown instead of a blank chat bubble when the model returned no text.
function emptyReplyNote(stopReason) {
  if (stopReason === 'refusal') return '[The model declined to respond to this message.]';
  if (stopReason === 'max_tokens') return '[The reply hit the max-tokens limit before any text was produced. Raise "Max tokens" in JanitorAI\'s generation settings.]';
  return '[The model returned an empty reply. Try again.]';
}

function mapStopReason(r) {
  switch (r) {
    case 'max_tokens': return 'length';
    case 'end_turn': case 'stop_sequence': case 'pause_turn': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    default: return r ? 'stop' : null;
  }
}

function openaiUsage(u) {
  u = u || {};
  const read = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  const prompt = (u.input_tokens || 0) + read + write;
  const completion = u.output_tokens || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: read, cache_creation_tokens: write },
  };
}

// JanitorAI's "Test" button sends exactly one user message saying "Just say TEST".
function isJanitorTest(oa) {
  const msgs = oa && oa.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1) return false;
  const m = msgs[0];
  return Boolean(m && m.role === 'user' && typeof m.content === 'string' && /^\s*just say test\s*$/i.test(m.content));
}

// Send a complete OpenAI-format reply (non-stream or as a one-chunk stream).
function sendOpenAIText(req, res, { id, model, text, stream, finish = 'stop', usage }) {
  const created = nowSec();
  if (!stream) {
    return sendJson(req, res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
      usage: openaiUsage(usage),
    });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...corsHeaders(req) });
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: openaiUsage(usage) })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function handleJanitorTest(req, res, oaBody, auth) {
  const body = openaiToAnthropic(oaBody);
  if (!body.model) return sendError(req, res, 400, 'No model name. Put a Claude model id (e.g. claude-sonnet-5-5) in the Model field.', 'test');
  body.stream = false;
  body.max_tokens = 64;
  applyModelCompat(body);
  const ac = abortOnClientClose(res);
  let upstream;
  try {
    upstream = await postWithCompat(body, auth, req, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) return;
    return sendError(req, res, 502, `Could not reach Anthropic: ${e.message}`, 'test');
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const { msg } = explainUpstreamError(upstream.status, text, auth);
    if (LOG_REQUESTS) console.log(`[test FAILED ${upstream.status} key=…${auth.tag}] model=${body.model} ${msg.slice(0, 300)}`);
    return sendError(req, res, upstream.status, msg, 'test');
  }
  let msg = {};
  try { msg = JSON.parse(text); } catch { /* ignore */ }
  if (LOG_REQUESTS) console.log(`[test OK key=…${auth.tag} via ${auth.via}] model=${msg.model || body.model} | cache TTL ${CACHE_TTL}`);
  // Always answer exactly "TEST" so JanitorAI reports the configuration as working.
  sendOpenAIText(req, res, { id: msg.id || `chatcmpl-${crypto.randomUUID()}`, model: msg.model || body.model, text: 'TEST', stream: Boolean(oaBody.stream), usage: msg.usage });
}

async function handleChatCompletions(req, res, oaBody, auth) {
  if (isJanitorTest(oaBody)) return handleJanitorTest(req, res, oaBody, auth);

  let body;
  try { body = openaiToAnthropic(oaBody); } catch (e) {
    return sendError(req, res, 400, `Could not translate request: ${e.message}`, 'openai');
  }
  if (!body.model) return sendError(req, res, 400, 'Missing "model". Put a Claude model id (e.g. claude-sonnet-5-5) in the Model field.', 'openai');

  const compat = applyModelCompat(body);
  const cacheInfo = applyCaching(body, sha1(auth.key));
  if (compat.length) cacheInfo.compat = compat;
  const ac = abortOnClientClose(res);
  let upstream;
  try {
    upstream = await postWithCompat(body, auth, req, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) return;
    return sendError(req, res, 502, `Could not reach Anthropic: ${e.message}`, 'openai');
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    const { msg, type } = explainUpstreamError(upstream.status, text, auth);
    if (LOG_REQUESTS) console.log(`[upstream ${upstream.status} key=…${auth.tag}] ${msg.slice(0, 300)}`);
    return sendError(req, res, upstream.status, msg, 'openai', type);
  }

  const created = nowSec();

  if (!body.stream) {
    let msg;
    try { msg = JSON.parse(await upstream.text()); } catch (e) {
      return sendError(req, res, 502, 'Bad JSON from Anthropic', 'openai');
    }
    let text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) text = emptyReplyNote(msg.stop_reason);
    recordUsage(msg.model || body.model, msg.usage, auth.tag, cacheInfo);
    return sendJson(req, res, 200, {
      id: msg.id || `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created,
      model: msg.model || body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: mapStopReason(msg.stop_reason) || 'stop' }],
      usage: openaiUsage(msg.usage),
    });
  }

  // Streaming: translate Anthropic SSE -> OpenAI chat.completion.chunk SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(req),
  });
  res.flushHeaders();

  let id = `chatcmpl-${crypto.randomUUID()}`;
  let model = body.model;
  let finish = null;
  let stopReason = null;
  let sentRole = false;
  let sentText = false;
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish_reason = null, extra = {}) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }], ...extra,
  });

  const tracker = makeSseUsageTracker((evt) => {
    switch (evt.type) {
      case 'message_start':
        if (evt.message) { id = evt.message.id || id; model = evt.message.model || model; }
        if (!sentRole) { sentRole = true; send(chunk({ role: 'assistant', content: '' })); }
        break;
      case 'content_block_delta':
        if (evt.delta && evt.delta.type === 'text_delta' && evt.delta.text) {
          if (!sentRole) { sentRole = true; send(chunk({ role: 'assistant', content: '' })); }
          sentText = true;
          send(chunk({ content: evt.delta.text }));
        }
        break;
      case 'message_delta':
        if (evt.delta && evt.delta.stop_reason) { stopReason = evt.delta.stop_reason; finish = mapStopReason(stopReason); }
        break;
      case 'error':
        send({ error: evt.error || { message: 'stream error', type: 'api_error' } });
        break;
      default:
        break;
    }
  });

  const decoder = new TextDecoder();
  try {
    for await (const c of upstream.body) tracker.feed(decoder.decode(c, { stream: true }));
  } catch (e) {
    if (!ac.signal.aborted && LOG_REQUESTS) console.log(`[stream error key=…${auth.tag}] ${e.message}`);
  }
  const r = tracker.result();
  if (!res.writableEnded && !ac.signal.aborted) {
    if (!sentText) send(chunk({ role: sentRole ? undefined : 'assistant', content: emptyReplyNote(stopReason) }));
    send(chunk({}, finish || 'stop', { usage: openaiUsage(r.usage) }));
    res.write('data: [DONE]\n\n');
  }
  res.end();
  recordUsage(r.model || body.model, r.usage, auth.tag, cacheInfo);
}

// ----------------------------------------------------------------------------
// GET /v1/models passthrough, landing page, health, stats
// ----------------------------------------------------------------------------
async function handleModels(req, res, auth) {
  const ac = abortOnClientClose(res);
  try {
    const upstream = await callAnthropic('/v1/models?limit=100', null, auth.key, req, ac.signal, 'GET');
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', ...corsHeaders(req) });
    res.end(text);
  } catch (e) {
    if (!ac.signal.aborted) sendError(req, res, 502, `Could not reach Anthropic: ${e.message}`, 'openai');
  }
}

function healthJson() {
  const totalIn = totals.cacheRead + totals.cacheWrite + totals.uncached;
  return {
    ok: true,
    version: VERSION,
    mode: SERVER_KEY_USABLE ? 'server-key (PROXY_KEY)' : 'bring-your-own-key',
    cacheTtl: CACHE_TTL,
    effort: EFFORT || 'model default',
    warnings: CONFIG_WARNINGS,
    uptimeSec: Math.floor(process.uptime()),
    requests: totals.requests,
    cachedInputPct: totalIn ? Math.round((100 * totals.cacheRead) / totalIn) : 0,
    estimatedSavingsUsd: Math.round(totals.savedUsd * 100) / 100,
    admin: PROXY_ADMIN || undefined,
  };
}

function landingPage(req, res) {
  const base = publicUrl(req);
  const h = healthJson();
  const apiKeyField = SERVER_KEY_USABLE
    ? 'the <b>PROXY_KEY</b> password you set on Render'
    : 'your <b>Anthropic API key</b> (starts with <code>sk-ant-</code>)';
  const warn = CONFIG_WARNINGS.length
    ? `<div class="warn"><b>Configuration needs attention</b><ul>${CONFIG_WARNINGS.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude caching proxy</title>
<style>
  :root{color-scheme:light dark}
  body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1d1d1f;background:#fff}
  @media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#111} code,pre{background:#222!important} .box{border-color:#333!important} .warn{background:#3a2a00!important;border-color:#8a6500!important}}
  h1{font-size:1.5rem;margin:0 0 4px} h2{font-size:1.1rem;margin:28px 0 8px}
  .ok{color:#1a7f37;font-weight:600} .muted{opacity:.7}
  code{background:#f2f2f4;padding:2px 6px;border-radius:5px;font-size:.95em;word-break:break-all}
  .box{border:1px solid #ddd;border-radius:10px;padding:14px 16px;margin:12px 0}
  table{border-collapse:collapse;width:100%} td{padding:7px 4px;vertical-align:top;border-top:1px solid #eee} td:first-child{white-space:nowrap;width:9em;opacity:.75}
  .warn{background:#fff6d6;border:1px solid #e8c547;border-radius:10px;padding:12px 16px;margin:12px 0}
  ol li{margin:6px 0}
  button{font:inherit;padding:2px 8px;border-radius:6px;border:1px solid #bbb;background:transparent;cursor:pointer;margin-left:6px}
</style></head><body>
<h1>Claude caching proxy <span class="ok">● running</span></h1>
<p class="muted">Prompt caching for JanitorAI → Anthropic. Mode: <b>${escapeHtml(h.mode)}</b> · cache TTL <b>${CACHE_TTL}</b> · thinking effort <b>${escapeHtml(h.effort)}</b> · v${escapeHtml(VERSION)}${PROXY_ADMIN ? ` · hosted by ${escapeHtml(PROXY_ADMIN)}` : ''}</p>
${warn}
<h2>Set up JanitorAI</h2>
<div class="box">
<ol>
  <li>Open any chat → top-right menu → <b>API Settings</b> → <b>Proxy</b> → <b>Add Configuration</b>.</li>
  <li>Fill in the fields below, then press <b>Save</b> (twice helps) and <b>Save Settings</b>.</li>
  <li>Reload the JanitorAI page, make the configuration <b>Active</b>, then press <b>Test</b>. You should see <i>“Valid API Key. Configuration works!”</i>.</li>
</ol>
<table>
  <tr><td>Model</td><td><code>claude-sonnet-5-5</code> &nbsp;<span class="muted">or</span>&nbsp; <code>claude-opus-5-5</code> &nbsp;<span class="muted">or</span>&nbsp; <code>claude-haiku-5-5</code></td></tr>
  <tr><td>Proxy URL</td><td><code id="u">${escapeHtml(base)}/v1/chat/completions</code><button onclick="navigator.clipboard.writeText(document.getElementById('u').textContent)">copy</button></td></tr>
  <tr><td>API key</td><td>${apiKeyField}</td></tr>
</table>
<p class="muted" style="margin:10px 0 0">Keep <b>Streaming</b> on. If JanitorAI offers a separate Claude/Anthropic-format option, use <code>${escapeHtml(base)}/v1/messages</code> instead.</p>
</div>
<h2>Is it saving money?</h2>
<p>Every message prints a line in the Render <b>Logs</b> tab like <code>input 9342 = cached 9000 (96%) + …</code>. From the second message of a chat, most of the input should be <i>cached</i>.
Since this instance started: <b>${h.requests}</b> requests, <b>${h.cachedInputPct}%</b> of input tokens served from cache, estimated savings <b>$${h.estimatedSavingsUsd.toFixed(2)}</b>. <a href="/stats">JSON</a></p>
<p class="muted">Caching only kicks in once the prompt is above the model's minimum (512 tokens on the 5.x models); a tiny character card won't cache, but then there was little to save. Keep replying within ${CACHE_TTL === '1h' ? 'an hour' : '5 minutes'} to keep the cache warm.</p>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(req) });
  res.end(html);
}

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    if (path === '/health' || path === '/healthz') return sendJson(req, res, 200, healthJson());
    if (path === '/stats') return sendJson(req, res, 200, { ...totals, cacheTtl: CACHE_TTL, mode: healthJson().mode, warnings: CONFIG_WARNINGS });
    if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (req.method === 'HEAD') { res.writeHead(200, corsHeaders(req)); return res.end(); }
      return landingPage(req, res);
    }

    const isCountTokens = /\/messages\/count_tokens$/.test(path);
    const isModels = /\/models$/.test(path);
    // Anthropic-native if the path says so or the client speaks Anthropic headers; otherwise OpenAI format.
    const isNative = !isCountTokens && (/\/messages$/.test(path) || (path === '/' && Boolean(req.headers['anthropic-version'])));
    const isChat = !isNative && !isModels && !isCountTokens && (path === '/' || /\/chat\/completions$/.test(path) || /\/completions$/.test(path));
    const fmt = isNative || isCountTokens ? 'anthropic' : 'openai';

    if (!isChat && !isNative && !isModels && !isCountTokens) {
      return sendError(req, res, 404, `Unknown path ${path}. Use ${publicUrl(req)}/v1/chat/completions (OpenAI format) or ${publicUrl(req)}/v1/messages (Anthropic format).`, 'openai');
    }

    if (isModels) {
      if (req.method !== 'GET') return sendError(req, res, 405, 'Use GET for /v1/models', 'openai');
      const auth = resolveUpstreamKey(req);
      if (auth.error) return sendError(req, res, 401, auth.error, 'openai');
      return handleModels(req, res, auth);
    }
    if (req.method !== 'POST') {
      return sendError(req, res, 405, `The proxy is up. This endpoint expects POST requests (got ${req.method}); JanitorAI will send them. Visit ${publicUrl(req)}/ for setup instructions.`, fmt);
    }

    let raw;
    try { raw = await readBody(req); } catch (e) { return sendError(req, res, 413, e.message, fmt); }
    let json;
    try { json = JSON.parse(raw); } catch { return sendError(req, res, 400, 'Request body is not valid JSON', fmt); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return sendError(req, res, 400, 'Request body must be a JSON object', fmt);

    const testReq = isChat && isJanitorTest(json);
    const auth = resolveUpstreamKey(req);
    if (auth.error) {
      if (LOG_REQUESTS) console.log(`[auth rejected] ${auth.error}`);
      return sendError(req, res, 401, auth.error, testReq ? 'test' : fmt);
    }

    if (isCountTokens) {
      const up = await callAnthropic('/v1/messages/count_tokens', json, auth.key, req, abortOnClientClose(res).signal);
      const text = await up.text();
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json', ...corsHeaders(req) });
      return res.end(text);
    }
    if (isChat) return await handleChatCompletions(req, res, json, auth);
    return await handleNativeMessages(req, res, json, auth);
  } catch (e) {
    console.error('[proxy error]', e && e.stack || e);
    if (!res.headersSent) sendError(req, res, 500, 'Proxy error: ' + (e && e.message), 'openai');
    else res.end();
  }
});

server.requestTimeout = 0;   // long chats can take a while to upload
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Claude caching proxy v${VERSION} listening on :${PORT}`);
    console.log(`  upstream : ${UPSTREAM}`);
    console.log(`  mode     : ${SERVER_KEY_USABLE ? 'server-key — clients send PROXY_KEY, Anthropic key stays on the server' : 'bring-your-own-key — clients send their own sk-ant- key'}`);
    console.log(`  cache TTL: ${CACHE_TTL}`);
    for (const w of CONFIG_WARNINGS) console.log(`  WARNING  : ${w}`);
  });
}

module.exports = { server, applyCaching, openaiToAnthropic, detectTrailing, normaliseModel, isJanitorTest }; // for tests
