const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const GUIAS_DIR = path.join(__dirname, '..', 'Guias');
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

// Map PDF filenames (without extension) to region metadata
const FILENAME_MAP = {
  'GUÍA PARA ANDALUCÍA': {
    slug: 'andalucia',
    name: 'Andalucía',
    aliases: ['andalusia', 'andalucia', 'malaga', 'málaga', 'sevilla', 'granada', 'cadiz', 'cádiz', 'cordoba', 'córdoba', 'huelva', 'jaen', 'jaén', 'almeria', 'almería']
  },
  'GUÍA PARA CATALUÑA': {
    slug: 'cataluna',
    name: 'Cataluña',
    aliases: ['catalonia', 'cataluña', 'barcelona', 'girona', 'tarragona', 'lleida', 'costa brava']
  },
  'GUÍA PARA LA COMUNIDAD VALENCIANA': {
    slug: 'valencia',
    name: 'Comunidad Valenciana',
    aliases: ['valencia', 'valenciana', 'alicante', 'castellon', 'castellón', 'benidorm', 'costa blanca']
  },
  'GUÍA PARA LAS ISLAS BALEARES (1)': {
    slug: 'baleares',
    name: 'Islas Baleares',
    aliases: ['balearic', 'baleares', 'mallorca', 'ibiza', 'menorca', 'formentera', 'palma']
  },
  'GUÍA PARA MADRID': {
    slug: 'madrid',
    name: 'Madrid',
    aliases: ['madrid']
  },
  'GUÍA GALICIA (1)': {
    slug: 'galicia',
    name: 'Galicia',
    aliases: ['galicia', 'vigo', 'coruña', 'santiago', 'pontevedra', 'lugo', 'ourense']
  },
  'GUÍA CANTABRIA': {
    slug: 'cantabria',
    name: 'Cantabria',
    aliases: ['cantabria', 'santander']
  },
  'GUÍA MURCIA': {
    slug: 'murcia',
    name: 'Murcia',
    aliases: ['murcia', 'cartagena', 'costa calida', 'costa cálida']
  },
  'GUÍA ACTUALIZADA TFE-GC-LTE-FTE': {
    slug: 'canarias-main',
    name: 'Canarias (Tenerife, Gran Canaria, Lanzarote, Fuerteventura)',
    aliases: ['canary', 'canarias', 'tenerife', 'gran canaria', 'lanzarote', 'fuerteventura', 'las palmas']
  },
  'GUÍA ACTUALIZADA LA GOMERA-EL HIERRO-LA PALMA': {
    slug: 'canarias-green',
    name: 'Canarias (La Gomera, El Hierro, La Palma)',
    aliases: ['gomera', 'hierro', 'la palma']
  }
};

function cleanText(text) {
  return text
    // Normalize line breaks
    .replace(/\r\n/g, '\n')
    // Remove excessive blank lines (keep max 2)
    .replace(/\n{3,}/g, '\n\n')
    // Remove leading/trailing whitespace per line
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    // Remove page headers/footers (common patterns)
    .replace(/^Página \d+ de \d+$/gm, '')
    .trim();
}

async function extractGuide(pdfPath, meta) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const cleaned = cleanText(data.text);

  const mdContent = `# ${meta.name}\n\n${cleaned}`;
  const outPath = path.join(KNOWLEDGE_DIR, `${meta.slug}.md`);
  fs.writeFileSync(outPath, mdContent, 'utf-8');

  console.log(`  ✓ ${meta.name} → knowledge/${meta.slug}.md (${cleaned.length} chars)`);
  return {
    slug: meta.slug,
    name: meta.name,
    file: `${meta.slug}.md`,
    aliases: meta.aliases,
    source: path.basename(pdfPath)
  };
}

async function main() {
  console.log('Extracting PDF guides...\n');

  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }

  const files = fs.readdirSync(GUIAS_DIR).filter(f => f.endsWith('.pdf'));
  const index = {};
  let extracted = 0;
  let skipped = 0;

  for (const file of files) {
    // Normalize Unicode (NFD → NFC) to handle decomposed accents in macOS filenames
    const nameWithoutExt = file.replace('.pdf', '').normalize('NFC');
    const meta = FILENAME_MAP[nameWithoutExt];

    if (!meta) {
      console.log(`  ⚠ Skipped (no mapping): ${file}`);
      skipped++;
      continue;
    }

    try {
      const entry = await extractGuide(path.join(GUIAS_DIR, file), meta);
      index[entry.slug] = {
        name: entry.name,
        file: entry.file,
        aliases: entry.aliases,
        source: entry.source
      };
      extracted++;
    } catch (err) {
      console.error(`  ✗ Error extracting ${file}: ${err.message}`);
      skipped++;
    }
  }

  // Write the index manifest
  const indexPath = path.join(KNOWLEDGE_DIR, '_index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  console.log(`\nDone: ${extracted} extracted, ${skipped} skipped`);
  console.log(`Index written to knowledge/_index.json`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
