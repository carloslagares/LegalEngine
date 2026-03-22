require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Validate API key ──
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const anthropic = new Anthropic();

// ── Middleware ──
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// ── Sessions ──
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'chekin-legalengine-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// ── Static files (after session middleware) ──
app.use(express.static(__dirname));

// ── Admin credentials ──
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'chekin2026';

// ── Auth middleware ──
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Rate limiting (simple in-memory) ──
const rateMap = new Map();
const RATE_LIMIT = 15;
const RATE_WINDOW = 60000;

function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ── Load knowledge base ──
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const INDEX_PATH = path.join(KNOWLEDGE_DIR, '_index.json');

function loadKnowledge() {
  if (!fs.existsSync(INDEX_PATH)) {
    console.error('ERROR: knowledge/_index.json not found. Run "npm run extract" first.');
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));

  for (const [slug, meta] of Object.entries(index)) {
    const filePath = path.join(KNOWLEDGE_DIR, meta.file);
    if (fs.existsSync(filePath)) {
      meta.content = fs.readFileSync(filePath, 'utf-8');
    }
  }

  console.log(`Loaded ${Object.keys(index).length} region guides.`);
  return index;
}

let knowledge = loadKnowledge();

function reloadKnowledge() {
  knowledge = loadKnowledge();
}

// ════════════════════════════════════════════════════
// ══ RAG — Embedding-based guide retrieval ══
// ════════════════════════════════════════════════════

let ragIndex = []; // [{slug, chunkIndex, chunkText, embedding}]
let ragReady = false;

function chunkText(text, maxChars = 800, overlap = 100) {
  const parts = text.split(/\n#{1,3}\s/);
  const chunks = [];
  for (const part of parts) {
    if (part.length <= maxChars) {
      if (part.trim().length > 30) chunks.push(part.trim());
    } else {
      const paragraphs = part.split(/\n\n+/);
      let current = '';
      for (const para of paragraphs) {
        if (current.length + para.length > maxChars && current.length > 0) {
          chunks.push(current.trim());
          current = current.slice(-overlap) + '\n\n' + para;
        } else {
          current += (current ? '\n\n' : '') + para;
        }
      }
      if (current.trim().length > 30) chunks.push(current.trim());
    }
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function voyageEmbed(texts, inputType = 'document') {
  return new Promise((resolve, reject) => {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) return resolve(null);

    const body = JSON.stringify({
      model: 'voyage-3-lite',
      input: texts,
      input_type: inputType
    });

    const req = https.request({
      hostname: 'api.voyageai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data) resolve(parsed.data.map(d => d.embedding));
          else reject(new Error(parsed.detail || 'Voyage API error'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function initRAG() {
  if (!process.env.VOYAGE_API_KEY) {
    console.log('RAG disabled: VOYAGE_API_KEY not set. Using keyword matching.');
    return;
  }
  console.log('Initializing RAG embeddings...');

  try {
    // Check which guides need (re)embedding
    const existing = {};
    const rows = db.prepare('SELECT slug, chunk_index, chunk_text, embedding, content_hash FROM guide_embeddings').all();
    for (const row of rows) {
      if (!existing[row.slug]) existing[row.slug] = [];
      existing[row.slug].push(row);
    }

    const toEmbed = []; // {slug, chunkIndex, chunkText}

    for (const [slug, meta] of Object.entries(knowledge)) {
      if (!meta.content) continue;
      const contentHash = crypto.createHash('md5').update(meta.content).digest('hex');
      const cachedChunks = existing[slug];

      if (cachedChunks && cachedChunks.length > 0 && cachedChunks[0].content_hash === contentHash) {
        // Load from cache
        for (const row of cachedChunks) {
          ragIndex.push({
            slug,
            chunkIndex: row.chunk_index,
            chunkText: row.chunk_text,
            embedding: JSON.parse(row.embedding)
          });
        }
      } else {
        // Need new embeddings
        const chunks = chunkText(meta.content);
        chunks.forEach((text, i) => toEmbed.push({ slug, chunkIndex: i, chunkText: text, contentHash }));
      }
    }

    if (toEmbed.length > 0) {
      console.log(`Generating embeddings for ${toEmbed.length} chunks...`);
      // Batch in groups of 64
      for (let i = 0; i < toEmbed.length; i += 64) {
        const batch = toEmbed.slice(i, i + 64);
        const embeddings = await voyageEmbed(batch.map(c => c.chunkText), 'document');
        if (!embeddings) break;

        const insertEmb = db.prepare(`
          INSERT OR REPLACE INTO guide_embeddings (slug, chunk_index, chunk_text, embedding, content_hash)
          VALUES (@slug, @chunk_index, @chunk_text, @embedding, @content_hash)
        `);

        for (let j = 0; j < batch.length; j++) {
          const item = batch[j];
          insertEmb.run({
            slug: item.slug,
            chunk_index: item.chunkIndex,
            chunk_text: item.chunkText,
            embedding: JSON.stringify(embeddings[j]),
            content_hash: item.contentHash
          });
          ragIndex.push({
            slug: item.slug,
            chunkIndex: item.chunkIndex,
            chunkText: item.chunkText,
            embedding: embeddings[j]
          });
        }
      }
    }

    ragReady = ragIndex.length > 0;
    console.log(`RAG ready: ${ragIndex.length} chunks indexed across ${new Set(ragIndex.map(r => r.slug)).size} guides.`);
  } catch (err) {
    console.error('RAG init error:', err.message, '— falling back to keyword matching.');
    ragReady = false;
  }
}

async function resolveGuidesRAG(question, regionParam) {
  if (!ragReady) return null; // fallback to keyword

  try {
    const queryEmbedding = await voyageEmbed([question], 'query');
    if (!queryEmbedding || !queryEmbedding[0]) return null;

    const qVec = queryEmbedding[0];
    const scored = ragIndex.map(item => ({
      ...item,
      score: cosineSimilarity(qVec, item.embedding)
    }));

    scored.sort((a, b) => b.score - a.score);

    // Take top chunks with score > 0.35, max 8
    const topChunks = scored.filter(c => c.score > 0.35).slice(0, 8);
    if (topChunks.length === 0) return null;

    // Group by slug and build context
    const slugMap = {};
    for (const chunk of topChunks) {
      if (!slugMap[chunk.slug]) slugMap[chunk.slug] = { chunks: [], maxScore: 0 };
      slugMap[chunk.slug].chunks.push(chunk);
      slugMap[chunk.slug].maxScore = Math.max(slugMap[chunk.slug].maxScore, chunk.score);
    }

    // If a specific region was requested, prioritize it
    if (regionParam && knowledge[regionParam]) {
      if (!slugMap[regionParam]) {
        slugMap[regionParam] = { chunks: [], maxScore: 1.0 };
      }
      slugMap[regionParam].maxScore = 1.0;
    }

    const results = [];
    for (const [slug, data] of Object.entries(slugMap)) {
      if (!knowledge[slug]) continue;
      const meta = knowledge[slug];
      // Use relevant chunks as content instead of full guide
      const chunkContent = data.chunks.length > 0
        ? data.chunks.map(c => c.chunkText).join('\n\n---\n\n')
        : meta.content;
      results.push({
        slug,
        name: meta.name,
        content: chunkContent,
        score: data.maxScore
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 4);
  } catch (err) {
    console.error('RAG query error:', err.message);
    return null; // fallback
  }
}

// ════════════════════════════════════════════════════
// ══ CACHE — Reduce API costs for repeat questions ══
// ════════════════════════════════════════════════════

const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '24', 10);

function getCacheKey(question, region, lang) {
  const normalized = (question || '').toLowerCase().trim() + '|' + (region || '') + '|' + (lang || 'en');
  return crypto.createHash('md5').update(normalized).digest('hex');
}

// ════════════════════════════════════════════════════
// ══ ANALYTICS — Event tracking ══
// ════════════════════════════════════════════════════

function trackEvent(event, data = {}) {
  try {
    db.prepare('INSERT INTO analytics_events (event, region, lang, data, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').run(
      event,
      data.region || null,
      data.lang || null,
      JSON.stringify(data)
    );
  } catch (e) { /* silent */ }
}

// ── System prompt ──
const SYSTEM_PROMPT = `You are the Chekin Compliance Assistant, an expert on vacation rental (VUT — Vivienda de Uso Turístico) regulations in Spain and Europe.

Your role is to answer questions about:
- Tourist license registration and requirements
- Guest reporting obligations (SES.HOSPEDAJES, police registration, Alloggiati Web)
- Identity verification requirements (in-person vs remote, check-in wall)
- Regional regulations, zoning, and restrictions
- City tax / tourist tax rates and rules across European cities
- Taxes (tourist tax, IGIC, IVA, income tax on rentals)
- Electronic invoicing requirements
- Required documentation and administrative procedures
- Fines and penalties for non-compliance

RULES:
1. Answer based PRIMARILY on the guide content provided. When the guides contain relevant information, use it as the authoritative source.
2. If the guides do not cover a topic but you have reliable knowledge about it (e.g. well-known regulations, official government requirements), you MAY supplement with your own knowledge. When doing so, clearly indicate which information comes from the guides and which is based on general knowledge, and recommend verifying with official sources.
3. Always cite the specific region, country, or city when relevant.
4. Format your answers in HTML using <strong>, <ul>/<li>, <ol>/<li>, and <p> tags.
5. Keep answers concise but thorough (2-4 paragraphs or a structured list).
6. CRITICAL LANGUAGE RULE: The website interface language is provided as a parameter. You MUST respond in that language by default. Only switch language if the user EXPLICITLY writes to you in a different language (e.g. they write their question in Spanish when the site is in English). If the site language is English, respond in English even if guide content is in Spanish. Never switch languages mid-conversation unless the user explicitly requests it.
7. When listing steps, use numbered lists (<ol>).
8. If a user asks about a specific city (e.g. "Roma", "Milán", "Huelva"), associate it with its country or region and answer accordingly. For example: Roma → Italy, Huelva → Andalucía, Lyon → France.
9. For city tax questions, include the rate, who pays, exemptions, and how it is calculated when the data is available.
10. If you notice that guide content may be outdated or incomplete based on your knowledge of current regulations, flag it politely and provide what you know, recommending official verification.
11. At the END of every answer, suggest 2-3 relevant follow-up questions the user might want to ask next. These should be logical continuations based on your answer. Format them EXACTLY like this, after your main answer:
<follow-up>
<q>First suggested question here</q>
<q>Second suggested question here</q>
<q>Third suggested question here</q>
</follow-up>
The follow-up questions should be in the same language as the conversation and should help the user dive deeper into the topic or explore related compliance areas.
12. When the user sends a short follow-up (like a city name, region, or "yes"/"no"), treat it as a continuation of the previous topic. For example, if the user asked about electronic invoicing and then says "Huelva", answer about electronic invoicing specifically for Huelva/Andalucía — do NOT start a completely new topic about Huelva.`;

// ── Guide resolution ──
const THEMATIC_TRIGGERS = {
  'city-tax': /city.?tax|tourist.?tax|tasa.?tur|impuesto.?tur|accommodation.?tax|taxe|kurtaxe|its\b|tourist.?levy|tax.?rate|impuesto.?sostenible/i,
  'tourist-license': /licencia.?tur|tourist.?licen|declaraci.n.?responsable|registro.?tur|tourism.?registration|vut.?regist|license.?require|do i need.*(license|licencia|registro)|necesito.*(licencia|registro)|how to register|c.mo registro|dar de alta|high.?up|start.?operat|empezar.?a.?alqui/i,
  'identity-verification': /identity.?verif|verificaci.n.?de.?identidad|check.?in.?wall|guest.?registr|registro.?(de.?)?(hu.sped|guest|viajero)|alloggiati|ses\.?hospedaje|police.?registr|registro.?polic|self.?check.?in|documento.?identidad|pasaporte|passport.?check|who needs to register|obligatorio.*(identidad|identity|verificar)/i
};

const CITY_TO_REGION = {
  'huelva': 'andalucia', 'jerez': 'andalucia', 'marbella': 'andalucia', 'torremolinos': 'andalucia',
  'estepona': 'andalucia', 'nerja': 'andalucia', 'ronda': 'andalucia', 'motril': 'andalucia',
  'roquetas': 'andalucia', 'costa del sol': 'andalucia', 'costa de la luz': 'andalucia',
  'sitges': 'cataluna', 'lloret': 'cataluna', 'salou': 'cataluna', 'cambrils': 'cataluna',
  'torrevieja': 'valencia', 'denia': 'valencia', 'jávea': 'valencia', 'javea': 'valencia',
  'gandía': 'valencia', 'gandia': 'valencia', 'peñíscola': 'valencia', 'peniscola': 'valencia',
  'sóller': 'baleares', 'soller': 'baleares', 'alcúdia': 'baleares', 'alcudia': 'baleares',
  'playa de las américas': 'canarias-main', 'los cristianos': 'canarias-main',
  'puerto de la cruz': 'canarias-main', 'maspalomas': 'canarias-main', 'corralejo': 'canarias-main',
  'sanxenxo': 'galicia', 'baiona': 'galicia', 'ferrol': 'galicia',
};

const EUROPEAN_LOCATIONS = [
  'italy', 'italia', 'rome', 'roma', 'milan', 'milán', 'milano', 'florence', 'firenze',
  'naples', 'nápoles', 'napoli', 'venice', 'venecia', 'venezia', 'bologna', 'bolonia',
  'lucca', 'turin', 'torino', 'sicily', 'sicilia', 'sardinia', 'cerdeña',
  'portugal', 'lisbon', 'lisboa', 'porto', 'oporto', 'algarve', 'faro', 'madeira',
  'france', 'francia', 'paris', 'parís', 'nice', 'niza', 'cannes', 'lyon', 'marseille', 'marsella',
  'bordeaux', 'burdeos', 'toulouse', 'montpellier', 'strasbourg',
  'germany', 'alemania', 'berlin', 'berlín', 'munich', 'múnich', 'münchen', 'hamburg', 'hamburgo',
  'austria', 'vienna', 'viena', 'wien', 'salzburg', 'salzburgo',
  'greece', 'grecia', 'athens', 'atenas', 'santorini', 'mykonos', 'crete', 'creta',
  'netherlands', 'holanda', 'amsterdam', 'ámsterdam', 'rotterdam',
  'belgium', 'bélgica', 'brussels', 'bruselas', 'bruges', 'brujas',
  'croatia', 'croacia', 'dubrovnik', 'split', 'zagreb',
  'czech republic', 'chequia', 'prague', 'praga',
  'hungary', 'hungría', 'budapest',
  'poland', 'polonia', 'warsaw', 'varsovia', 'krakow', 'cracovia',
  'ireland', 'irlanda', 'dublin', 'dublín',
  'uk', 'united kingdom', 'reino unido', 'london', 'londres', 'edinburgh', 'edimburgo',
  'switzerland', 'suiza', 'zurich', 'zúrich', 'geneva', 'ginebra',
  'denmark', 'dinamarca', 'copenhagen', 'copenhague',
  'sweden', 'suecia', 'stockholm', 'estocolmo',
  'norway', 'noruega', 'oslo',
];

function resolveGuides(question, regionParam) {
  const q = question.toLowerCase().normalize('NFC');
  const matched = [];

  if (regionParam && knowledge[regionParam]) {
    matched.push({ slug: regionParam, ...knowledge[regionParam] });
  } else {
    for (const [slug, meta] of Object.entries(knowledge)) {
      if (meta.type === 'thematic') continue;
      const allTerms = [meta.name.toLowerCase(), ...meta.aliases];
      if (allTerms.some(term => q.includes(term))) {
        matched.push({ slug, ...meta });
      }
    }

    for (const [city, slug] of Object.entries(CITY_TO_REGION)) {
      if (q.includes(city) && knowledge[slug] && !matched.some(m => m.slug === slug)) {
        matched.push({ slug, ...knowledge[slug] });
      }
    }
  }

  for (const [slug, regex] of Object.entries(THEMATIC_TRIGGERS)) {
    if (regex.test(q) && knowledge[slug] && !matched.some(m => m.slug === slug)) {
      matched.push({ slug, ...knowledge[slug] });
    }
  }

  const isEuropean = EUROPEAN_LOCATIONS.some(loc => q.includes(loc));

  if (matched.length > 0) return matched;
  if (isEuropean) return [];
  return [];
}

// ── POST /api/ask ──
app.post('/api/ask', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { question, region, history: rawHistory = [], stream = true, lang = 'en', sessionId } = req.body;

  if (!question || question.trim().length < 3) {
    return res.status(400).json({ error: 'Question is required (min 3 characters).' });
  }

  const history = rawHistory.slice(-10);

  // ── Cache check (only for first messages, no history) ──
  const cacheKey = (history.length === 0) ? getCacheKey(question, region, lang) : null;
  if (cacheKey) {
    try {
      const cached = db.prepare("SELECT * FROM response_cache WHERE cache_key = ? AND expires_at > datetime('now')").get(cacheKey);
      if (cached) {
        db.prepare('UPDATE response_cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(cacheKey);
        trackEvent('cache_hit', { question, region, lang });

        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.write(`data: ${JSON.stringify({ type: 'chunk', text: cached.response })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done', regions: JSON.parse(cached.regions_json || '[]'), cached: true })}\n\n`);
          res.end();
        } else {
          res.json({ answer: cached.response, regions: JSON.parse(cached.regions_json || '[]'), cached: true });
        }

        // Still save chat session for cached responses
        if (sessionId) {
          try {
            const allMessages = [...rawHistory, { role: 'user', content: question }, { role: 'assistant', content: cached.response }];
            upsertChat.run({ id: sessionId, region: region || null, lang, messages: JSON.stringify(allMessages), message_count: allMessages.length });
          } catch (e) { /* silent */ }
        }
        return;
      }
    } catch (e) { /* cache miss, continue normally */ }
  }

  // ── Guide resolution: try RAG first, fallback to keywords ──
  const allUserText = history
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .concat(question)
    .join(' ');

  let guides;
  const ragResult = ragReady ? await resolveGuidesRAG(allUserText, region) : null;
  if (ragResult && ragResult.length > 0) {
    guides = ragResult;
  } else {
    guides = resolveGuides(allUserText, region);
  }

  const guideContext = guides.length > 0
    ? guides.map(g => `<guide region="${g.name}">\n${g.content}\n</guide>`).join('\n\n')
    : '';

  const contextPrefix = guideContext
    ? `${guideContext}\n\nQuestion: `
    : 'No specific guide is available for this question. Use your expert knowledge to answer, and recommend verifying with official sources.\n\nQuestion: ';

  const messages = [];

  if (history.length > 0) {
    const firstHistoryMsg = history[0];
    messages.push({
      role: 'user',
      content: `${contextPrefix}${firstHistoryMsg.content}`
    });
    for (let i = 1; i < history.length; i++) {
      messages.push({ role: history[i].role, content: history[i].content });
    }
    messages.push({ role: 'user', content: question });
  } else {
    messages.push({ role: 'user', content: `${contextPrefix}${question}` });
  }

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
  const systemPrompt = SYSTEM_PROMPT + `\n\nIMPORTANT: The website is currently set to "${lang === 'es' ? 'Spanish' : 'English'}". Respond in ${lang === 'es' ? 'Spanish' : 'English'} by default.`;

  // Track analytics
  trackEvent('question', { question: question.substring(0, 200), region, lang, rag: !!ragResult });

  const guideSlugs = guides.map(g => g.slug);

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const response = anthropic.messages.stream({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages
      });

      let ended = false;
      let fullResponse = '';

      response.on('text', (text) => {
        if (!ended) {
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
        }
      });

      response.on('end', () => {
        if (!ended) {
          ended = true;
          res.write(`data: ${JSON.stringify({ type: 'done', regions: guideSlugs })}\n\n`);
          res.end();

          // Store chat session
          if (sessionId) {
            try {
              const allMessages = [...rawHistory, { role: 'user', content: question }, { role: 'assistant', content: fullResponse }];
              upsertChat.run({ id: sessionId, region: region || null, lang, messages: JSON.stringify(allMessages), message_count: allMessages.length });
            } catch (e) { console.error('Chat save error:', e.message); }
          }

          // Store in cache (only first messages)
          if (cacheKey && fullResponse) {
            try {
              db.prepare(`INSERT OR REPLACE INTO response_cache (cache_key, question, region, lang, response, regions_json, hit_count, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now', '+${CACHE_TTL_HOURS} hours'))`).run(
                cacheKey, question, region || null, lang, fullResponse, JSON.stringify(guideSlugs)
              );
            } catch (e) { /* silent */ }
          }
        }
      });

      response.on('error', (err) => {
        console.error('Stream error:', err.message);
        if (!ended) {
          ended = true;
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'An error occurred while generating the answer.' })}\n\n`);
          res.end();
        }
      });

    } else {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages
      });

      const answer = response.content[0].text;

      // Store chat session
      if (sessionId) {
        try {
          const allMessages = [...rawHistory, { role: 'user', content: question }, { role: 'assistant', content: answer }];
          upsertChat.run({ id: sessionId, region: region || null, lang, messages: JSON.stringify(allMessages), message_count: allMessages.length });
        } catch (e) { /* silent */ }
      }

      // Store in cache
      if (cacheKey && answer) {
        try {
          db.prepare(`INSERT OR REPLACE INTO response_cache (cache_key, question, region, lang, response, regions_json, hit_count, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now', '+${CACHE_TTL_HOURS} hours'))`).run(
            cacheKey, question, region || null, lang, answer, JSON.stringify(guideSlugs)
          );
        } catch (e) { /* silent */ }
      }

      res.json({ answer, regions: guideSlugs });
    }
  } catch (err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: 'Failed to generate answer. Please try again.' });
  }
});

// ── SQLite leads database ──
const dbPath = path.join(__dirname, 'data', 'leads.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    name TEXT,
    company TEXT,
    property_type TEXT,
    units TEXT,
    country TEXT,
    region TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    region TEXT,
    lang TEXT DEFAULT 'en',
    messages TEXT NOT NULL DEFAULT '[]',
    message_count INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

const upsertChat = db.prepare(`
  INSERT INTO chat_sessions (id, region, lang, messages, message_count, started_at, updated_at)
  VALUES (@id, @region, @lang, @messages, @message_count, datetime('now'), datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    region = @region,
    lang = @lang,
    messages = @messages,
    message_count = @message_count,
    updated_at = datetime('now')
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS guide_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    UNIQUE(slug, chunk_index)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS response_cache (
    cache_key TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    region TEXT,
    lang TEXT DEFAULT 'en',
    response TEXT NOT NULL,
    regions_json TEXT DEFAULT '[]',
    hit_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    region TEXT,
    lang TEXT,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const insertLead = db.prepare(`
  INSERT INTO leads (type, email, phone, name, company, property_type, units, country, region)
  VALUES (@type, @email, @phone, @name, @company, @property_type, @units, @country, @region)
`);

// ── POST /api/leads ──
app.post('/api/leads', (req, res) => {
  const { type, email, phone, name, company, property_type, units, country, region } = req.body;
  if (!email && !phone) {
    return res.status(400).json({ error: 'Email or phone is required.' });
  }
  try {
    const result = insertLead.run({
      type: type || 'unknown',
      email: email || null,
      phone: phone || null,
      name: name || null,
      company: company || null,
      property_type: property_type || null,
      units: units || null,
      country: country || null,
      region: region || null
    });
    console.log(`Lead saved: ${type} — ${email || phone} (id: ${result.lastInsertRowid})`);
    trackEvent('lead_capture', { type, region, country });
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Lead save error:', err.message);
    res.status(500).json({ error: 'Failed to save lead.' });
  }
});

// ── GET /api/regions (public — for frontend cards) ──
app.get('/api/regions', (req, res) => {
  const regions = Object.entries(knowledge)
    .filter(([, meta]) => meta.type !== 'thematic')
    .map(([slug, meta]) => ({
      slug,
      name: meta.name,
      emoji: meta.emoji || '📋',
      description: meta.description || '',
      country: meta.country || 'spain'
    }));
  res.json(regions);
});

// ════════════════════════════════════════════════════
// ══ ADMIN ROUTES ══
// ════════════════════════════════════════════════════

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Login / Logout ──
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/admin/me', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin) });
});

// ── Admin: Leads ──
app.get('/api/admin/leads', requireAuth, (req, res) => {
  const { page = 1, limit = 50, type, search, from, to } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = '1=1';
  const params = {};

  if (type) { where += ' AND type = @type'; params.type = type; }
  if (search) { where += ' AND (email LIKE @search OR name LIKE @search OR company LIKE @search)'; params.search = `%${search}%`; }
  if (from) { where += ' AND created_at >= @from'; params.from = from; }
  if (to) { where += ' AND created_at <= @to'; params.to = to + ' 23:59:59'; }

  const total = db.prepare(`SELECT COUNT(*) as count FROM leads WHERE ${where}`).get(params).count;
  const leads = db.prepare(`SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: parseInt(limit), offset });

  res.json({ leads, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// ── Admin: Guides ──
app.get('/api/admin/guides', requireAuth, (req, res) => {
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  const guides = Object.entries(index).map(([slug, meta]) => ({
    slug,
    name: meta.name,
    file: meta.file,
    country: meta.country || '',
    emoji: meta.emoji || '',
    description: meta.description || '',
    type: meta.type || 'regional',
    aliases: meta.aliases || [],
    source: meta.source || ''
  }));
  res.json(guides);
});

// ── Admin: Upload guide ──
const upload = multer({ dest: path.join(__dirname, 'data', 'uploads'), limits: { fileSize: 20 * 1024 * 1024 } });

// Region metadata — auto-generated name, emoji, description, aliases per country+region
const REGION_META = {
  spain: {
    andalucia: { name: 'Andalucía', emoji: '☀️', desc: 'Málaga, Sevilla, Cádiz, Granada — Junta registration.', aliases: ['andalusia', 'andalucia', 'malaga', 'málaga', 'sevilla', 'granada', 'cadiz', 'cádiz', 'cordoba', 'córdoba', 'huelva', 'jaen', 'jaén', 'almeria', 'almería'] },
    aragon: { name: 'Aragón', emoji: '🏰', desc: 'Zaragoza, Huesca, Teruel — vivienda turística registration.', aliases: ['aragon', 'aragón', 'zaragoza', 'huesca', 'teruel'] },
    asturias: { name: 'Asturias', emoji: '🌿', desc: 'Oviedo, Gijón — vivienda vacacional registration.', aliases: ['asturias', 'oviedo', 'gijón', 'gijon'] },
    baleares: { name: 'Islas Baleares', emoji: '⛵', desc: 'Mallorca, Ibiza, Menorca — holiday rental license (ETV).', aliases: ['balearic', 'baleares', 'mallorca', 'ibiza', 'menorca', 'formentera', 'palma'] },
    canarias: { name: 'Canarias', emoji: '🌋', desc: 'Tenerife, Gran Canaria, Lanzarote — Ley 6/2025.', aliases: ['canary', 'canarias', 'tenerife', 'gran canaria', 'lanzarote', 'fuerteventura'] },
    'canarias-main': { name: 'Canarias (Tenerife, Gran Canaria, Lanzarote, Fuerteventura)', emoji: '🌋', desc: 'Tenerife, Gran Canaria, Lanzarote, Fuerteventura — Ley 6/2025.', aliases: ['canary', 'canarias', 'tenerife', 'gran canaria', 'lanzarote', 'fuerteventura', 'las palmas'] },
    'canarias-green': { name: 'Canarias (La Gomera, El Hierro, La Palma)', emoji: '🏝️', desc: 'La Palma, La Gomera, El Hierro — easier rules, 10-year validity.', aliases: ['gomera', 'hierro', 'la palma'] },
    cantabria: { name: 'Cantabria', emoji: '🏔️', desc: 'Santander, Picos de Europa — vivienda turística registration.', aliases: ['cantabria', 'santander'] },
    'castilla-la-mancha': { name: 'Castilla-La Mancha', emoji: '🏜️', desc: 'Toledo, Ciudad Real — vivienda turística registration.', aliases: ['castilla la mancha', 'toledo', 'ciudad real', 'albacete', 'cuenca', 'guadalajara'] },
    'castilla-y-leon': { name: 'Castilla y León', emoji: '🏰', desc: 'Salamanca, Valladolid, Segovia — alojamiento turístico registration.', aliases: ['castilla y leon', 'castilla y león', 'salamanca', 'valladolid', 'segovia', 'leon', 'león', 'burgos', 'ávila', 'avila'] },
    cataluna: { name: 'Cataluña', emoji: '🏔️', desc: 'Barcelona, Costa Brava, Tarragona — HUTT license and tourist tax.', aliases: ['catalonia', 'cataluña', 'barcelona', 'girona', 'tarragona', 'lleida', 'costa brava'] },
    extremadura: { name: 'Extremadura', emoji: '🌾', desc: 'Cáceres, Badajoz — vivienda turística registration.', aliases: ['extremadura', 'cáceres', 'caceres', 'badajoz', 'mérida', 'merida'] },
    galicia: { name: 'Galicia', emoji: '🌊', desc: 'Santiago, Vigo, A Coruña — Xunta de Galicia tourism registration.', aliases: ['galicia', 'vigo', 'coruña', 'santiago', 'pontevedra', 'lugo', 'ourense'] },
    madrid: { name: 'Madrid', emoji: '🏛️', desc: 'Comunidad de Madrid — vivienda de uso turístico registration.', aliases: ['madrid'] },
    murcia: { name: 'Murcia', emoji: '🌶️', desc: 'Cartagena, Costa Cálida — vivienda de uso turístico registration.', aliases: ['murcia', 'cartagena', 'costa calida', 'costa cálida'] },
    navarra: { name: 'Navarra', emoji: '🐂', desc: 'Pamplona — vivienda turística registration.', aliases: ['navarra', 'pamplona'] },
    'pais-vasco': { name: 'País Vasco', emoji: '🌧️', desc: 'Bilbao, San Sebastián, Vitoria — vivienda turística registration.', aliases: ['pais vasco', 'país vasco', 'basque', 'bilbao', 'san sebastián', 'san sebastian', 'vitoria', 'donostia'] },
    'la-rioja': { name: 'La Rioja', emoji: '🍷', desc: 'Logroño — vivienda turística registration.', aliases: ['la rioja', 'rioja', 'logroño', 'logrono'] },
    valencia: { name: 'Comunidad Valenciana', emoji: '🍊', desc: 'Alicante, Valencia, Castellón — Comunitat Valenciana registration.', aliases: ['valencia', 'valenciana', 'alicante', 'castellon', 'castellón', 'benidorm', 'costa blanca'] }
  },
  italy: {
    abruzzo: { name: 'Abruzzo', emoji: '🏔️', desc: 'Pescara, L\'Aquila — locazione turistica registration.', aliases: ['abruzzo', 'pescara', "l'aquila"] },
    basilicata: { name: 'Basilicata', emoji: '🏛️', desc: 'Matera, Potenza — locazione turistica registration.', aliases: ['basilicata', 'matera', 'potenza'] },
    calabria: { name: 'Calabria', emoji: '🌊', desc: 'Reggio Calabria, Cosenza — locazione turistica registration.', aliases: ['calabria', 'reggio calabria', 'cosenza'] },
    campania: { name: 'Campania', emoji: '🌋', desc: 'Naples, Amalfi Coast, Capri — locazione turistica registration.', aliases: ['campania', 'napoli', 'naples', 'amalfi', 'capri', 'sorrento'] },
    'emilia-romagna': { name: 'Emilia-Romagna', emoji: '🍝', desc: 'Bologna, Rimini, Parma — locazione turistica registration.', aliases: ['emilia romagna', 'emilia-romagna', 'bologna', 'rimini', 'parma', 'modena'] },
    'friuli-venezia-giulia': { name: 'Friuli Venezia Giulia', emoji: '⛰️', desc: 'Trieste, Udine — locazione turistica registration.', aliases: ['friuli', 'trieste', 'udine'] },
    lazio: { name: 'Lazio', emoji: '🏛️', desc: 'Rome — locazione turistica and CIR registration.', aliases: ['lazio', 'roma', 'rome'] },
    liguria: { name: 'Liguria', emoji: '🌊', desc: 'Genoa, Cinque Terre — locazione turistica registration.', aliases: ['liguria', 'genova', 'genoa', 'cinque terre'] },
    lombardia: { name: 'Lombardia', emoji: '🏙️', desc: 'Milan, Lake Como, Bergamo — CIR registration.', aliases: ['lombardia', 'lombardy', 'milano', 'milan', 'como', 'bergamo'] },
    marche: { name: 'Marche', emoji: '🌻', desc: 'Ancona, Pesaro — locazione turistica registration.', aliases: ['marche', 'ancona', 'pesaro'] },
    molise: { name: 'Molise', emoji: '🏔️', desc: 'Campobasso — locazione turistica registration.', aliases: ['molise', 'campobasso'] },
    piemonte: { name: 'Piemonte', emoji: '🍷', desc: 'Turin, Langhe — locazione turistica registration.', aliases: ['piemonte', 'piedmont', 'torino', 'turin'] },
    puglia: { name: 'Puglia', emoji: '🫒', desc: 'Bari, Lecce, Alberobello — locazione turistica registration.', aliases: ['puglia', 'apulia', 'bari', 'lecce', 'alberobello'] },
    sardegna: { name: 'Sardegna', emoji: '🏖️', desc: 'Cagliari, Costa Smeralda — locazione turistica registration.', aliases: ['sardegna', 'sardinia', 'cagliari', 'costa smeralda'] },
    sicilia: { name: 'Sicilia', emoji: '🌋', desc: 'Palermo, Catania, Taormina — CIR registration.', aliases: ['sicilia', 'sicily', 'palermo', 'catania', 'taormina'] },
    toscana: { name: 'Toscana', emoji: '🌻', desc: 'Florence, Siena, Pisa — locazione turistica registration.', aliases: ['toscana', 'tuscany', 'firenze', 'florence', 'siena', 'pisa', 'lucca'] },
    'trentino-alto-adige': { name: 'Trentino-Alto Adige', emoji: '⛷️', desc: 'Trento, Bolzano — CIN and CIPAT registration.', aliases: ['trentino', 'alto adige', 'trento', 'bolzano'] },
    umbria: { name: 'Umbria', emoji: '🌿', desc: 'Perugia, Assisi — locazione turistica registration.', aliases: ['umbria', 'perugia', 'assisi'] },
    'valle-d-aosta': { name: 'Valle d\'Aosta', emoji: '🏔️', desc: 'Aosta, Courmayeur — locazione turistica registration.', aliases: ['valle d\'aosta', 'aosta', 'courmayeur'] },
    veneto: { name: 'Veneto', emoji: '🏛️', desc: 'Venice, Verona, Padua — CIR and imposta di soggiorno.', aliases: ['veneto', 'venezia', 'venice', 'verona', 'padova', 'padua'] }
  }
};

function cleanPdfText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .replace(/^Página \d+ de \d+$/gm, '')
    .trim();
}

app.post('/api/admin/guides', requireAuth, upload.single('pdf'), async (req, res) => {
  try {
    const { country, region } = req.body;
    if (!country || !region || !req.file) {
      return res.status(400).json({ error: 'Country, region, and PDF file are required.' });
    }

    // Get auto-generated metadata
    const meta = (REGION_META[country] && REGION_META[country][region]) || null;
    const name = meta ? meta.name : region.charAt(0).toUpperCase() + region.slice(1);
    const emoji = meta ? meta.emoji : '📋';
    const description = meta ? meta.desc : `${name} — vacation rental registration.`;
    const aliases = meta ? meta.aliases : [region];

    const slug = region;

    // Extract text from PDF
    const pdfBuffer = fs.readFileSync(req.file.path);
    const pdfData = await pdfParse(pdfBuffer);
    const cleaned = cleanPdfText(pdfData.text);
    const mdContent = `# ${name}\n\n${cleaned}`;

    // Save markdown to knowledge/
    const mdPath = path.join(KNOWLEDGE_DIR, `${slug}.md`);
    fs.writeFileSync(mdPath, mdContent, 'utf-8');

    // Save PDF to Guias/
    const guiasDir = path.join(__dirname, 'Guias');
    fs.mkdirSync(guiasDir, { recursive: true });
    const pdfDest = path.join(guiasDir, `${name}.pdf`);
    fs.copyFileSync(req.file.path, pdfDest);

    // Clean up upload temp file
    fs.unlinkSync(req.file.path);

    // Update _index.json
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    index[slug] = {
      name,
      file: `${slug}.md`,
      aliases,
      source: `${name}.pdf`,
      country,
      emoji,
      description
    };
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');

    // Reload knowledge in memory
    reloadKnowledge();

    console.log(`Guide uploaded: ${name} (${slug}) — ${country}`);
    trackEvent('guide_upload', { slug, country, region });
    // Re-index RAG for new guide in background
    if (process.env.VOYAGE_API_KEY) {
      ragIndex = ragIndex.filter(r => r.slug !== slug);
      db.prepare('DELETE FROM guide_embeddings WHERE slug = ?').run(slug);
      initRAG().catch(() => {});
    }
    res.json({ ok: true, slug, name, country });
  } catch (err) {
    console.error('Guide upload error:', err.message);
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to process guide: ' + err.message });
  }
});

app.delete('/api/admin/guides/:slug', requireAuth, (req, res) => {
  const { slug } = req.params;

  try {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
    if (!index[slug]) {
      return res.status(404).json({ error: 'Guide not found.' });
    }

    // Remove markdown file
    const mdPath = path.join(KNOWLEDGE_DIR, index[slug].file);
    if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);

    // Remove from index
    delete index[slug];
    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf-8');

    // Reload knowledge
    reloadKnowledge();

    console.log(`Guide deleted: ${slug}`);
    trackEvent('guide_delete', { slug });
    // Clean RAG index
    ragIndex = ragIndex.filter(r => r.slug !== slug);
    db.prepare('DELETE FROM guide_embeddings WHERE slug = ?').run(slug);
    res.json({ ok: true });
  } catch (err) {
    console.error('Guide delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete guide.' });
  }
});

// ── Admin: Chat Sessions ──
app.get('/api/admin/chats', requireAuth, (req, res) => {
  const { page = 1, limit = 50, region, search, from, to } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = '1=1';
  const params = {};
  if (region) { where += ' AND region = @region'; params.region = region; }
  if (search) { where += ' AND messages LIKE @search'; params.search = `%${search}%`; }
  if (from) { where += ' AND started_at >= @from'; params.from = from; }
  if (to) { where += ' AND started_at <= @to'; params.to = to + ' 23:59:59'; }

  const total = db.prepare(`SELECT COUNT(*) as count FROM chat_sessions WHERE ${where}`).get(params).count;
  const chats = db.prepare(`SELECT id, region, lang, message_count, started_at, updated_at FROM chat_sessions WHERE ${where} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: parseInt(limit), offset });

  res.json({ chats, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

app.get('/api/admin/chats/:id', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat session not found' });
  chat.messages = JSON.parse(chat.messages || '[]');
  res.json(chat);
});

// ── Admin: Analytics ──
app.get('/api/admin/analytics', requireAuth, (req, res) => {
  const totalQuestions = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'question'").get().c;
  const questionsToday = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'question' AND date(created_at) = date('now')").get().c;
  const totalLeads = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const leadsToday = db.prepare("SELECT COUNT(*) as c FROM leads WHERE date(created_at) = date('now')").get().c;
  const cacheHits = db.prepare("SELECT COUNT(*) as c FROM analytics_events WHERE event = 'cache_hit'").get().c;
  const cacheRate = totalQuestions > 0 ? Math.round((cacheHits / (totalQuestions + cacheHits)) * 100) : 0;
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM chat_sessions').get().c;

  const questionsOverTime = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count
    FROM analytics_events WHERE event = 'question'
    AND created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day
  `).all();

  const topRegions = db.prepare(`
    SELECT region, COUNT(*) as count
    FROM analytics_events WHERE event = 'question' AND region IS NOT NULL AND region != ''
    GROUP BY region ORDER BY count DESC LIMIT 10
  `).all();

  const topLanguages = db.prepare(`
    SELECT lang, COUNT(*) as count
    FROM analytics_events WHERE event = 'question' AND lang IS NOT NULL
    GROUP BY lang ORDER BY count DESC
  `).all();

  const conversions = db.prepare(`
    SELECT date(created_at) as day,
      SUM(CASE WHEN event = 'question' THEN 1 ELSE 0 END) as questions,
      SUM(CASE WHEN event = 'lead_capture' THEN 1 ELSE 0 END) as leads
    FROM analytics_events
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day
  `).all();

  const recentQuestions = db.prepare(`
    SELECT data, region, lang, created_at
    FROM analytics_events WHERE event = 'question'
    ORDER BY created_at DESC LIMIT 20
  `).all().map(r => {
    try { const d = JSON.parse(r.data); return { question: d.question, region: r.region, lang: r.lang, created_at: r.created_at }; }
    catch (e) { return { question: '—', region: r.region, lang: r.lang, created_at: r.created_at }; }
  });

  const guideDownloads = db.prepare(`
    SELECT region, COUNT(*) as count FROM leads WHERE type = 'guide_download'
    GROUP BY region ORDER BY count DESC LIMIT 10
  `).all();

  res.json({
    overview: { totalQuestions, questionsToday, totalLeads, leadsToday, cacheRate, totalSessions, ragEnabled: ragReady },
    questionsOverTime, topRegions, topLanguages, conversions, recentQuestions, guideDownloads
  });
});

// ── Admin: Cache management ──
app.get('/api/admin/cache/stats', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM response_cache').get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM response_cache WHERE expires_at > datetime('now')").get().c;
  const totalHits = db.prepare('SELECT SUM(hit_count) as c FROM response_cache').get().c || 0;
  res.json({ total, active, totalHits });
});

app.post('/api/admin/cache/clear', requireAuth, (req, res) => {
  db.prepare('DELETE FROM response_cache').run();
  res.json({ ok: true });
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rag: ragReady });
});

// ── Start server ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LegalEngine running on port ${PORT}`);
  // Initialize RAG in background (don't block startup)
  initRAG().catch(err => console.error('RAG init failed:', err.message));
  // Clean expired cache entries periodically
  setInterval(() => {
    try { db.prepare("DELETE FROM response_cache WHERE expires_at <= datetime('now')").run(); } catch (e) { /* silent */ }
  }, 60 * 60 * 1000); // every hour
});
