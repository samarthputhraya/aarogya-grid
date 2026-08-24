/**
 * Discovers which Gemini models this API key can actually reach, so we pick a
 * model that exists rather than one we assumed exists.
 *
 * Run with:  npx tsx scripts/list-models.mts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env.local loader -- avoids a dependency for one file. */
function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    try {
      const text = readFileSync(resolve(process.cwd(), name), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, key, rawValue] = m;
        if (process.env[key]) continue;
        const value = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
        if (value) process.env[key] = value;
      }
    } catch {
      /* file absent -- fine */
    }
  }
}

loadEnv();

const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!key) {
  console.error('No GEMINI_API_KEY found.');
  console.error('Add it to .env.local:  GEMINI_API_KEY=your-key-here');
  console.error('Get one free at https://aistudio.google.com/app/apikey');
  process.exit(1);
}

interface ModelInfo {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + key;

const res = await fetch(url);
if (!res.ok) {
  console.error('Request failed:', res.status, res.statusText);
  console.error(await res.text());
  process.exit(1);
}

const data = (await res.json()) as { models?: ModelInfo[] };
const models = (data.models ?? []).filter((m) =>
  (m.supportedGenerationMethods ?? []).includes('generateContent'),
);

console.log('Models reachable with this key that support generateContent:\n');
console.log('name'.padEnd(46) + 'in-tokens'.padEnd(12) + 'out-tokens');
console.log('-'.repeat(72));

const rows = models
  .map((m) => ({ ...m, short: m.name.replace(/^models\//, '') }))
  .sort((a, b) => a.short.localeCompare(b.short));

for (const m of rows) {
  console.log(
    m.short.padEnd(46) +
      String(m.inputTokenLimit ?? '-').padEnd(12) +
      String(m.outputTokenLimit ?? '-'),
  );
}

// --- recommendation -------------------------------------------------------
// Prefer the newest generation available, and within it a flash tier for the
// interactive capture path (latency matters when a health worker is waiting)
// and a pro tier for the reasoning-heavy briefing path.
function pick(patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const hit = rows.filter((m) => p.test(m.short) && !/tts|image|embedding|audio-native|live/.test(m.short));
    if (hit.length) {
      // Prefer a stable id over -preview/-exp when both exist.
      const stable = hit.find((m) => !/preview|exp|latest/.test(m.short));
      return (stable ?? hit[hit.length - 1]).short;
    }
  }
  return undefined;
}

const main = pick([/^gemini-3.*pro/, /^gemini-3/, /^gemini-2\.5-pro/, /^gemini-2\.5-flash$/, /^gemini-2\.5/]);
const fast = pick([/^gemini-3.*flash/, /^gemini-2\.5-flash-lite/, /^gemini-2\.5-flash/, /^gemini-2\.0-flash/]);

console.log('\n' + '='.repeat(72));
console.log('Suggested .env.local settings:\n');
console.log('  GEMINI_MODEL=' + (main ?? '(none found)'));
console.log('  GEMINI_MODEL_FAST=' + (fast ?? main ?? '(none found)'));
console.log('\n(' + rows.length + ' models available)');
