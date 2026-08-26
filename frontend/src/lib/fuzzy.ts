/**
 * Approximate substring matching via Levenshtein.
 *
 * `substringDistance(query, text)` = the minimum number of edits (insert / delete /
 * substitute) to turn `query` into SOME substring of `text`. Start and end positions
 * in `text` are free, so a short query matches anywhere inside a long name and small
 * typos cost little: "cors" → "corsair gaming" = 0, "dynx" → "dynex capital" = 1.
 * Lower is a closer match; 0 is a perfect (sub)match.
 */
export function substringDistance(query: string, text: string): number {
  const m = query.length;
  const n = text.length;
  if (m === 0) return 0;
  if (n === 0) return m;
  // First row all zeros → the match may begin at any offset in `text`.
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i; // consuming query chars with nothing in text costs one each
    const qi = query.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = qi === text.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  // Best match can end at any offset → take the minimum of the last row.
  let best = prev[0];
  for (let j = 1; j <= n; j++) if (prev[j] < best) best = prev[j];
  return best;
}

/**
 * Best (lowest) approximate-substring distance of `query` against any of `fields`
 * (e.g. an instrument's name and ticker). Case-insensitive.
 */
export function fuzzyScore(query: string, fields: (string | null | undefined)[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best = Infinity;
  for (const f of fields) {
    if (!f) continue;
    const d = substringDistance(q, f.toLowerCase());
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}
