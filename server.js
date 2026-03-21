require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

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

// Serve indexS.html as the root page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'indexS.html'));
});

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
- Guest reporting obligations (SES.HOSPEDAJES, police registration)
- Identity verification requirements
- Regional regulations, zoning, and restrictions
- City tax / tourist tax rates and rules across European cities
- Taxes (tourist tax, IGIC, IVA, income tax on rentals)
- Electronic invoicing requirements
- Required documentation and administrative procedures
- Fines and penalties for non-compliance

RULES:
1. Answer based ONLY on the guide content provided. Do not invent requirements.
2. If the information is not in the provided guides, say so clearly and recommend consulting a lawyer or checking official sources.
3. Always cite the specific region or city when relevant.
4. Format your answers in HTML using <strong>, <ul>/<li>, <ol>/<li>, and <p> tags.
5. Keep answers concise but thorough (2-4 paragraphs or a structured list).
6. Answer in the same language the user writes in (Spanish or English).
7. When listing steps, use numbered lists (<ol>).
8. If the user asks about a region not covered by the guides, say that region is not yet available and list the regions that are.
9. For city tax questions, include the rate, who pays, exemptions, and how it is calculated when the data is available.`;

// ── Guide resolution ──
// Thematic keywords that should also pull in a thematic guide
const THEMATIC_TRIGGERS = {
  'city-tax': /city.?tax|tourist.?tax|tasa.?tur|impuesto.?tur|accommodation.?tax|taxe|kurtaxe|its\b|tourist.?levy|tax.?rate|impuesto.?sostenible/i
};

function resolveGuides(question, regionParam) {
  const q = question.toLowerCase().normalize('NFC');
  const matched = [];

  // If explicit region parameter, start with that guide
  if (regionParam && knowledge[regionParam]) {
    matched.push({ slug: regionParam, ...knowledge[regionParam] });
  } else {
    // Try to detect region from the question text
    for (const [slug, meta] of Object.entries(knowledge)) {
      if (meta.type === 'thematic') continue; // thematic guides handled below
      const allTerms = [meta.name.toLowerCase(), ...meta.aliases];
      if (allTerms.some(term => q.includes(term))) {
        matched.push({ slug, ...meta });
      }
    }
  }

  // Also check if any thematic guide should be included
  for (const [slug, regex] of Object.entries(THEMATIC_TRIGGERS)) {
    if (regex.test(q) && knowledge[slug] && !matched.some(m => m.slug === slug)) {
      matched.push({ slug, ...knowledge[slug] });
    }
  }

  if (matched.length > 0) return matched;

  // No region detected: include ALL guides
  return Object.entries(knowledge).map(([slug, meta]) => ({ slug, ...meta }));
}

// ── POST /api/ask ──
app.post('/api/ask', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { question, region, stream = true } = req.body;

  if (!question || question.trim().length < 3) {
    return res.status(400).json({ error: 'Question is required (min 3 characters).' });
  }

  const guides = resolveGuides(question, region);

  const guideContext = guides
    .map(g => `<guide region="${g.name}">\n${g.content}\n</guide>`)
    .join('\n\n');

  const messages = [
    { role: 'user', content: `${guideContext}\n\nQuestion: ${question}` }
  ];

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

// ── GET /api/regions ──
app.get('/api/regions', (req, res) => {
  const regions = Object.entries(knowledge).map(([slug, meta]) => ({
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
