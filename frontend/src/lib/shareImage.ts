/** Branded analysis image rendered on a Canvas 2D surface — a professional share card, not
 *  a screenshot, with no extra dependency. Colours mirror the app (azure = actual,
 *  gold = counterfactual accent, dark ground). */

export interface AnalysisImageInput {
  symbol: string;
  name?: string | null;
  isin?: string | null;
  actionLabel?: string | null; // ownership-aware verdict label
  owned?: boolean | null;
  price?: number | null;
  currency?: string | null;
  fairValue?: number | null;
  marginOfSafetyPct?: number | null; // fraction
  bandLabel?: string | null;
  fitLine?: string | null; // one-line portfolio-fit summary
}

const GROUND = '#0A0E15';
const CARD = '#111725';
const INK = '#E6EDF6';
const MUTED = '#8A97A8';
const AZURE = '#4EA1FF';
const GOLD = '#E5B769';

function money(v: number | null | undefined, ccy?: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${ccy ? ccy + ' ' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function pctf(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}

export async function renderAnalysisImage(input: AnalysisImageInput): Promise<Blob> {
  const scale = 2;
  const W = 1000;
  const H = 560;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CARD;
  roundRect(ctx, 32, 32, W - 64, H - 64, 20);
  ctx.fill();
  ctx.fillStyle = GOLD;
  ctx.fillRect(32, 32, W - 64, 6); // top accent

  const L = 72;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  ctx.font = '600 15px Inter, system-ui, sans-serif';
  ctx.fillText('DECISIONGURU · ANALYSIS', L, 92);

  ctx.fillStyle = INK;
  ctx.font = '700 40px Inter, system-ui, sans-serif';
  ctx.fillText(input.symbol, L, 140);
  ctx.fillStyle = MUTED;
  ctx.font = '400 18px Inter, system-ui, sans-serif';
  ctx.fillText([input.name, input.isin].filter(Boolean).join('  ·  ') || '', L, 168);

  // Verdict pill
  if (input.actionLabel) {
    const label =
      input.actionLabel + (input.owned == null ? '' : input.owned ? '  (owned)' : '  (not owned)');
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 40;
    ctx.fillStyle = AZURE;
    roundRect(ctx, L, 196, w, 44, 22);
    ctx.fill();
    ctx.fillStyle = GROUND;
    ctx.fillText(label, L + 20, 225);
  }

  // Metric grid (2×2)
  const metrics: [string, string][] = [
    ['Price', money(input.price, input.currency)],
    ['Fair value', money(input.fairValue, input.currency)],
    ['Margin of safety', pctf(input.marginOfSafetyPct)],
    ['Valuation', input.bandLabel || '—'],
  ];
  metrics.forEach(([k, v], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = L + col * 440;
    const y = 300 + row * 80;
    ctx.fillStyle = MUTED;
    ctx.font = '500 14px Inter, system-ui, sans-serif';
    ctx.fillText(k.toUpperCase(), x, y);
    ctx.fillStyle = INK;
    ctx.font = '700 28px Inter, system-ui, sans-serif';
    ctx.fillText(v, x, y + 34);
  });

  if (input.fitLine) {
    ctx.fillStyle = MUTED;
    ctx.font = '400 16px Inter, system-ui, sans-serif';
    wrapText(ctx, input.fitLine, L, 486, W - 2 * L, 22);
  }

  ctx.fillStyle = '#5A6675';
  ctx.font = 'italic 12px Inter, system-ui, sans-serif';
  ctx.fillText('Model estimates — not financial advice.', L, H - 52);

  return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lh: number,
) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lh;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
