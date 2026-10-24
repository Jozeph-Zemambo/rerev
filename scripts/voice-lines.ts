/**
 * `npm run voice:lines`
 *
 * 1. Writes the buddy's line catalog as a recording script, `voice-script/lines.csv` and
 *    `voice-script/lines.json` (id, text, mood, category, note, filename), to hand to a voice
 *    actor or TTS tool.
 * 2. Rebuilds `public/audio/lines/manifest.json` from the clips actually in that folder, so the
 *    app plays recorded clips for those lines and the browser voice for the rest. Drop
 *    `<id>.mp3` files in, run this again, done.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clipPath, LINES } from '../src/voice/lines';

const SCRIPT_DIR = 'voice-script';
const CLIP_DIR = join('public', 'audio', 'lines');

const rows = LINES.map(line => ({
  id: line.id,
  text: line.text,
  mood: line.mood,
  category: line.category,
  note: line.note ?? '',
  filename: `${line.id}.mp3`,
  path: join('public', clipPath(line.id)),
}));

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const columns = ['id', 'text', 'mood', 'category', 'note', 'filename'] as const;
const csv = [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n') + '\n';

mkdirSync(SCRIPT_DIR, { recursive: true });
writeFileSync(join(SCRIPT_DIR, 'lines.csv'), csv);
writeFileSync(join(SCRIPT_DIR, 'lines.json'), JSON.stringify(rows, null, 2) + '\n');

mkdirSync(CLIP_DIR, { recursive: true });
const known = new Set<string>(LINES.map(line => line.id));
const files = existsSync(CLIP_DIR) ? readdirSync(CLIP_DIR).filter(name => name.endsWith('.mp3')) : [];
const recorded = files.map(name => name.slice(0, -'.mp3'.length)).filter(id => known.has(id)).sort();
const strays = files.filter(name => !known.has(name.slice(0, -'.mp3'.length)));
writeFileSync(join(CLIP_DIR, 'manifest.json'), JSON.stringify(recorded, null, 2) + '\n');

console.log(`${rows.length} lines -> ${SCRIPT_DIR}/lines.csv, ${SCRIPT_DIR}/lines.json`);
console.log(`${recorded.length}/${rows.length} recorded -> ${CLIP_DIR}/manifest.json`);
if (strays.length) console.warn(`Not in the catalog (ignored): ${strays.join(', ')}`);
