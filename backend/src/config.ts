import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'decisionguru.sqlite');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const PORT = Number(process.env.PORT ?? 5178);
export const CACHE_TTL_MS = {
  quote: 15 * 60 * 1000, // 15 min
  history: 12 * 60 * 60 * 1000, // 12 h
  fund: 7 * 24 * 60 * 60 * 1000, // 7 d
  fx: 12 * 60 * 60 * 1000, // 12 h
};
