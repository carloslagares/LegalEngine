require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');

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
app.use(express.static(__dirname));

// index.html is served automatically by express.static

// ── Rate limiting (simple in-memory) ──
const rateMap = new Map();
const RATE_LIMIT = 15;      // requests
const RATE_WINDOW = 60000;  // per minute

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
function loadKnowledge() {
  const indexPath = path.join(__dirname, 'knowledge', '_index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('ERROR: knowledge/_index.json not found. Run "npm run extract" first.');
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

  for (const [slug, meta] of Object.entries(index)) {
    const filePath = path.join(__dirname, 'knowledge', meta.file);
    meta.content = fs.readFileSync(filePath, 'utf-8');
  }

  console.log(`Loaded ${Object.keys(index).length} region guides.`);
  return index;
}

const knowledge = loadKnowledge();

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
6. CRITICAL: Always answer in the SAME language as the user's FIRST message. If they started in English, ALL your responses must be in English, even if guide content is in Spanish. If they started in Spanish, respond in Spanish. Never switch languages mid-conversation.
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
// Thematic keywords that should also pull in a thematic guide
const THEMATIC_TRIGGERS = {
  'city-tax': /city.?tax|tourist.?tax|tasa.?tur|impuesto.?tur|accommodation.?tax|taxe|kurtaxe|its\b|tourist.?levy|tax.?rate|impuesto.?sostenible/i,
  'tourist-license': /licencia.?tur|tourist.?licen|declaraci.n.?responsable|registro.?tur|tourism.?registration|vut.?regist|license.?require|do i need.*(license|licencia|registro)|necesito.*(licencia|registro)|how to register|c.mo registro|dar de alta|high.?up|start.?operat|empezar.?a.?alqui/i,
  'identity-verification': /identity.?verif|verificaci.n.?de.?identidad|check.?in.?wall|guest.?registr|registro.?(de.?)?(hu.sped|guest|viajero)|alloggiati|ses\.?hospedaje|police.?registr|registro.?polic|self.?check.?in|documento.?identidad|pasaporte|passport.?check|who needs to register|obligatorio.*(identidad|identity|verificar)/i
};

// Map cities/provinces to their parent region or country for guide resolution
// Spanish cities → regional guide slug; European cities → thematic guides only (handled by triggers)
const CITY_TO_REGION = {
  // Andalucía provinces/cities
  'huelva': 'andalucia', 'jerez': 'andalucia', 'marbella': 'andalucia', 'torremolinos': 'andalucia',
  'estepona': 'andalucia', 'nerja': 'andalucia', 'ronda': 'andalucia', 'motril': 'andalucia',
  'roquetas': 'andalucia', 'costa del sol': 'andalucia', 'costa de la luz': 'andalucia',
  // Cataluña
  'sitges': 'cataluna', 'lloret': 'cataluna', 'salou': 'cataluna', 'cambrils': 'cataluna',
  // Valencia
  'torrevieja': 'valencia', 'denia': 'valencia', 'jávea': 'valencia', 'javea': 'valencia',
  'gandía': 'valencia', 'gandia': 'valencia', 'peñíscola': 'valencia', 'peniscola': 'valencia',
  // Baleares
  'sóller': 'baleares', 'soller': 'baleares', 'alcúdia': 'baleares', 'alcudia': 'baleares',
  // Canarias
  'playa de las américas': 'canarias-main', 'los cristianos': 'canarias-main',
  'puerto de la cruz': 'canarias-main', 'maspalomas': 'canarias-main', 'corralejo': 'canarias-main',
  // Galicia
  'sanxenxo': 'galicia', 'baiona': 'galicia', 'ferrol': 'galicia',
};

// European countries/cities → included as context hint (no regional guide, but thematic guides fire)
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

  // If explicit region parameter, start with that guide
  if (regionParam && knowledge[regionParam]) {
    matched.push({ slug: regionParam, ...knowledge[regionParam] });
  } else {
    // Try to detect region from the question text
    for (const [slug, meta] of Object.entries(knowledge)) {
      if (meta.type === 'thematic') continue;
      const allTerms = [meta.name.toLowerCase(), ...meta.aliases];
      if (allTerms.some(term => q.includes(term))) {
        matched.push({ slug, ...meta });
      }
    }

    // Check city-to-region map for Spanish cities not in aliases
    for (const [city, slug] of Object.entries(CITY_TO_REGION)) {
      if (q.includes(city) && knowledge[slug] && !matched.some(m => m.slug === slug)) {
        matched.push({ slug, ...knowledge[slug] });
      }
    }
  }

  // Check if any thematic guide should be included
  for (const [slug, regex] of Object.entries(THEMATIC_TRIGGERS)) {
    if (regex.test(q) && knowledge[slug] && !matched.some(m => m.slug === slug)) {
      matched.push({ slug, ...knowledge[slug] });
    }
  }

  // If European (non-Spanish) location detected, mark it so we don't fallback to ALL guides
  const isEuropean = EUROPEAN_LOCATIONS.some(loc => q.includes(loc));

  if (matched.length > 0) return matched;

  // If a European location was mentioned but no guide matched, return empty
  // (Claude will use its own knowledge + system prompt)
  if (isEuropean) return [];

  // No region detected — return empty and let Claude use its own knowledge
  // (sending all guides would overwhelm with irrelevant context)
  return [];
}

// ── POST /api/ask ──
app.post('/api/ask', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { question, region, history: rawHistory = [], stream = true } = req.body;

  if (!question || question.trim().length < 3) {
    return res.status(400).json({ error: 'Question is required (min 3 characters).' });
  }

  // Keep last 10 messages (5 exchanges) to avoid large token usage
  const history = rawHistory.slice(-10);

  // Resolve guides from the current question + all past user messages
  const allUserText = history
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .concat(question)
    .join(' ');
  const guides = resolveGuides(allUserText, region);

  const guideContext = guides.length > 0
    ? guides.map(g => `<guide region="${g.name}">\n${g.content}\n</guide>`).join('\n\n')
    : '';

  // Build the context prefix for the first user message
  const contextPrefix = guideContext
    ? `${guideContext}\n\nQuestion: `
    : 'No specific guide is available for this question. Use your expert knowledge to answer, and recommend verifying with official sources.\n\nQuestion: ';

  // Build messages array: guide context in first user message, then history, then current question
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

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const response = anthropic.messages.stream({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages
      });

      let ended = false;

      response.on('text', (text) => {
        if (!ended) res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
      });

      response.on('end', () => {
        if (!ended) {
          ended = true;
          res.write(`data: ${JSON.stringify({ type: 'done', regions: guides.map(g => g.slug) })}\n\n`);
          res.end();
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
        system: SYSTEM_PROMPT,
        messages
      });

      res.json({
        answer: response.content[0].text,
        regions: guides.map(g => g.slug)
      });
    }
  } catch (err) {
    console.error('API error:', err.message);
    res.status(500).json({ error: 'Failed to generate answer. Please try again.' });
  }
});

// ── SQLite leads database ──
const dbPath = path.join(__dirname, 'data', 'leads.db');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
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
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Lead save error:', err.message);
    res.status(500).json({ error: 'Failed to save lead.' });
  }
});

// ── GET /api/leads (admin) ──
app.get('/api/leads', (req, res) => {
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500').all();
  res.json(leads);
});

// ── GET /api/regions ──
app.get('/api/regions', (req, res) => {
  const regions = Object.entries(knowledge)
    .filter(([, meta]) => meta.type !== 'thematic')
    .map(([slug, meta]) => ({
      slug,
      name: meta.name
    }));
  res.json(regions);
});

// routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`LegalEngine running on port ${PORT}`);
});
