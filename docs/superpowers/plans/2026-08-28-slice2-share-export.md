# Slice 2 — Share & export

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **No automated tests** (owner constraint) — verify with frontend `build` + backend no-Yahoo smokes; owner tests the running app.

**Goal:** Add DOCX + image export and a Share workflow (Web Share + email) on top of the existing per-stock PDF/XLSX export, and fold the ownership-aware recommendation + portfolio context into the exported document.

**Architecture:** Reuse the existing server-rendered export (`routers/export.py` + `lib/exporters.ts`, JSON `body` → openpyxl/reportlab). Add a `_build_docx` mirroring `_build_pdf`; enrich `buildPositionExport` with a recommendation + portfolio-fit table; add a dependency-free canvas image renderer (`lib/shareImage.ts`); and a `ShareModal` wired through the already-declared-but-unimplemented `{ kind: 'export' }` modal. Position context gets the full PDF/DOCX/XLSX/Image suite; a symbol-only opportunity gets Image share (no P/L document).

**Tech Stack:** FastAPI + `python-docx` (new), reportlab/openpyxl (existing); React + Vite; Canvas 2D for the image (no new frontend dep).

## Global Constraints
- Tailwind only; dark mode only; modals not page redirects; Conventional Commits.
- Implementation only — no automated tests. Verify: `npm run build --workspace frontend` clean; backend `uv run python -c` import/route smoke (no Yahoo).
- Never fabricate data; the Share UI must **never claim an email was sent** — mailto only opens the client, attachments are downloaded separately with a clear note.
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_012qvEytzsTQKRG9fzDezv6X`.

---

## Task 1: DOCX export (backend + client plumbing)

**Files:**
- Modify: `backend/pyproject.toml` (add `python-docx>=1.1`)
- Modify: `backend/app/routers/export.py` (add `_build_docx` + `/docx` route)
- Modify: `frontend/src/lib/api.ts:342` (`exportUrl` accepts `'docx'`), `:1086` (`downloadExport` kind)

**Interfaces:**
- Produces: `POST /api/export/docx` consuming the same `body` shape as `/pdf` (`{title, subtitle, chartImage, tables[], notes[], disclaimer}`).

- [ ] **Step 1: Add the dependency**

In `backend/pyproject.toml`, add to the dependencies list beside `openpyxl`/`reportlab`:
```toml
    "python-docx>=1.1",
```
Then: `cd backend && uv sync` (expected: resolves + installs `python-docx`).

- [ ] **Step 2: `_build_docx` in `export.py`**

Add after `_build_pdf`:
```python
def _build_docx(body: dict) -> bytes:
    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document()
    title = doc.add_paragraph()
    run = title.add_run(str(body.get("title") or ""))
    run.bold = True
    run.font.size = Pt(18)
    if body.get("subtitle"):
        sub = doc.add_paragraph(str(body["subtitle"]))
        sub.runs[0].font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    chart = body.get("chartImage")
    if isinstance(chart, str) and chart.startswith("data:image"):
        try:
            from docx.shared import Inches
            raw = base64.b64decode(chart.split(",", 1)[1])
            doc.add_picture(io.BytesIO(raw), width=Inches(6.0))
        except Exception:  # noqa: BLE001
            pass

    for table in (body.get("tables") or []):
        if table.get("title"):
            h = doc.add_paragraph()
            hr = h.add_run(str(table["title"]))
            hr.bold = True
            hr.font.size = Pt(12)
        headers = table.get("headers") or []
        rows = table.get("rows") or []
        t = doc.add_table(rows=1, cols=max(len(headers), 1))
        t.style = "Light Grid Accent 1"
        for i, htext in enumerate(headers):
            cell = t.rows[0].cells[i]
            cell.text = str(htext)
            for p in cell.paragraphs:
                for r in p.runs:
                    r.bold = True
        for row in rows:
            cells = t.add_row().cells
            for i, val in enumerate(row):
                if i < len(cells):
                    cells[i].text = str(val)

    if body.get("notes"):
        nh = doc.add_paragraph()
        nh.add_run("Notes").bold = True
        for n in body["notes"]:
            doc.add_paragraph(str(n))

    disc = doc.add_paragraph(
        str(body.get("disclaimer")
            or "Not financial advice. Figures are model estimates — see docs/TAX-MODEL.md."))
    disc.runs[0].italic = True
    disc.runs[0].font.size = Pt(7)
    disc.runs[0].font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
```

- [ ] **Step 3: `/docx` route in `export.py`**

Add a MIME constant near `XLSX_MIME`:
```python
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
```
Add the route after `export_pdf`:
```python
@router.post("/docx")
async def export_docx(request: Request) -> Response:
    body = await request.json() or {}
    data = await run_in_threadpool(_build_docx, body)
    filename = f"{_safe_name(body.get('title'))}.docx"
    return Response(content=data, media_type=DOCX_MIME,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})
```

- [ ] **Step 4: Widen the frontend export kind**

`api.ts:342` → `exportUrl: (kind: 'excel' | 'pdf' | 'docx') => \`${BASE}/export/${kind}\`,`
`api.ts:1086` → `export async function downloadExport(kind: 'excel' | 'pdf' | 'docx', body: unknown, filename: string) {`

- [ ] **Step 5: Backend smoke (no Yahoo)**

```bash
cd backend && uv run python -c "from app.routers.export import _build_docx; b=_build_docx({'title':'T','subtitle':'s','tables':[{'title':'A','headers':['k','v'],'rows':[['x',1]]}],'notes':['n']}); print('docx bytes:', len(b) > 0)"
```
Expected: `docx bytes: True`.

- [ ] **Step 6: Commit**
```bash
git add backend/pyproject.toml backend/uv.lock backend/app/routers/export.py frontend/src/lib/api.ts
git commit -m "feat(export): DOCX export mirroring the PDF builder"
```

---

## Task 2: Recommendation + portfolio context in the export body

**Files:**
- Modify: `frontend/src/lib/exporters.ts` (`buildPositionExport` — add recommendation + fit tables; accept `'docx'`)

**Interfaces:**
- Consumes: `position.verdict` (ownership-aware `action` from Slice 1), `api.fit(symbol)` (`PortfolioFit`).
- Produces: `buildPositionExport(position, cf, kind: 'excel' | 'pdf' | 'docx', notes)` — pdf/docx share one body.

- [ ] **Step 1: Add a recommendation + fit block builder**

At the top of `exporters.ts` add helpers (after `taxRows`):
```ts
import type { PortfolioFit } from './api';

function recommendationRows(p: Position): (string | number)[][] {
  const v = p.verdict;
  if (!v) return [['Recommendation', 'Not available']];
  return [
    ['Recommendation', v.action?.label ?? v.label],
    ['Owned', v.action?.owned ? 'Yes' : 'No'],
    ['Confidence', v.confidence],
    ['Rationale', v.rationale],
    ...(v.conflictNote ? [['Note', v.conflictNote]] : []),
  ];
}

function fitRows(fit: PortfolioFit | null): (string | number)[][] {
  if (!fit) return [['Portfolio fit', 'Unavailable']];
  const ind = fit.indirect.available ? pct(fit.indirect.weight) : 'unavailable';
  return [
    ['Owned', fit.owned ? 'Yes' : 'No'],
    ['Direct exposure', fit.owned ? pct(fit.directWeight) : '0%'],
    ['Indirect ETF exposure', ind],
    ['Effective exposure', fit.effectiveExposure != null ? pct(fit.effectiveExposure) : '—'],
    ['Diversification', fit.diversification.note],
    ...(fit.concentrationNote ? [['Concentration', fit.concentrationNote]] : []),
  ];
}
```

- [ ] **Step 2: Thread fit + recommendation into `buildPositionExport`**

Change the signature to accept `'docx'`, fetch fit alongside settings/transactions, and add the two tables. In `buildPositionExport`:
```ts
export async function buildPositionExport(
  position: Position,
  cf: CounterfactualResult,
  kind: 'excel' | 'pdf' | 'docx',
  notes: string[] = [],
) {
```
Extend the `Promise.all` to also fetch fit:
```ts
  const [settings, transactions, fit] = await Promise.all([
    api.getSettings().catch(() => null),
    api.getTransactions(p.instrument.id).catch(() => [] as Transaction[]),
    api.fit(p.instrument.symbol).catch(() => null),
  ]);
```
For `kind === 'excel'`, add two sheets before the Tax sheet:
```ts
      { name: 'Recommendation', table: { headers: ['Field', 'Value'], rows: recommendationRows(p) } },
      { name: 'Portfolio fit', table: { headers: ['Field', 'Value'], rows: fitRows(fit) } },
```
For the pdf/docx branch (the `else` returning `{title, subtitle, chartImage, tables, notes}`), add two tables before Tax assumptions:
```ts
    { title: 'Recommendation', headers: ['Field', 'Value'], rows: recommendationRows(p) },
    { title: 'Portfolio fit', headers: ['Field', 'Value'], rows: fitRows(fit) },
```
The pdf/docx branch already runs whenever `kind !== 'excel'`, so `'docx'` reuses it unchanged.

- [ ] **Step 3: Build**

Run `npm run build --workspace frontend`. Expected: clean.

- [ ] **Step 4: Commit**
```bash
git add frontend/src/lib/exporters.ts
git commit -m "feat(export): include ownership-aware recommendation + portfolio fit in the analysis export"
```

---

## Task 3: Image export (canvas renderer, no new dep)

**Files:**
- Create: `frontend/src/lib/shareImage.ts`

**Interfaces:**
- Produces: `renderAnalysisImage(input: AnalysisImageInput): Promise<Blob>`, `downloadBlob(blob, filename)`, `type AnalysisImageInput`.

- [ ] **Step 1: Write `shareImage.ts`**

A branded dark card drawn on a 2× canvas — title, verdict action, price/fair value/MoS, portfolio-fit line, disclaimer. Colours mirror the app (azure `#4EA1FF`, gold `#E5B769`, ground `#0A0E15`).
```ts
export interface AnalysisImageInput {
  symbol: string;
  name?: string | null;
  isin?: string | null;
  actionLabel?: string | null;      // ownership-aware verdict label
  owned?: boolean | null;
  price?: number | null;
  currency?: string | null;
  fairValue?: number | null;
  marginOfSafetyPct?: number | null; // fraction
  bandLabel?: string | null;
  fitLine?: string | null;           // one-line portfolio-fit summary
}

const GROUND = '#0A0E15', CARD = '#111725', INK = '#E6EDF6', MUTED = '#8A97A8';
const AZURE = '#4EA1FF', GOLD = '#E5B769';

function money(v: number | null | undefined, ccy?: string | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${ccy ? ccy + ' ' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function pctf(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}

export async function renderAnalysisImage(input: AnalysisImageInput): Promise<Blob> {
  const scale = 2, W = 1000, H = 560;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.fillStyle = GROUND; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = CARD; roundRect(ctx, 32, 32, W - 64, H - 64, 20); ctx.fill();
  ctx.fillStyle = GOLD; ctx.fillRect(32, 32, W - 64, 6); // top accent

  const L = 72;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED; ctx.font = '600 15px Inter, system-ui, sans-serif';
  ctx.fillText('DECISIONGURU · ANALYSIS', L, 92);

  ctx.fillStyle = INK; ctx.font = '700 40px Inter, system-ui, sans-serif';
  ctx.fillText(input.symbol, L, 140);
  ctx.fillStyle = MUTED; ctx.font = '400 18px Inter, system-ui, sans-serif';
  ctx.fillText([input.name, input.isin].filter(Boolean).join('  ·  ') || '', L, 168);

  // Verdict pill
  if (input.actionLabel) {
    const label = input.actionLabel + (input.owned == null ? '' : input.owned ? '  (owned)' : '  (not owned)');
    ctx.font = '600 20px Inter, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 40;
    ctx.fillStyle = AZURE; roundRect(ctx, L, 196, w, 44, 22); ctx.fill();
    ctx.fillStyle = GROUND; ctx.fillText(label, L + 20, 225);
  }

  // Metric grid
  const metrics: [string, string][] = [
    ['Price', money(input.price, input.currency)],
    ['Fair value', money(input.fairValue, input.currency)],
    ['Margin of safety', pctf(input.marginOfSafetyPct)],
    ['Valuation', input.bandLabel || '—'],
  ];
  let x = L, y = 300;
  metrics.forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    x = L + col * 440; y = 300 + row * 80;
    ctx.fillStyle = MUTED; ctx.font = '500 14px Inter, system-ui, sans-serif';
    ctx.fillText(k.toUpperCase(), x, y);
    ctx.fillStyle = INK; ctx.font = '700 28px Inter, system-ui, sans-serif';
    ctx.fillText(v, x, y + 34);
  });

  if (input.fitLine) {
    ctx.fillStyle = MUTED; ctx.font = '400 16px Inter, system-ui, sans-serif';
    wrapText(ctx, input.fitLine, L, 486, W - 2 * L, 22);
  }

  ctx.fillStyle = '#5A6675'; ctx.font = 'italic 12px Inter, system-ui, sans-serif';
  ctx.fillText('Model estimates — not financial advice.', L, H - 52);

  return await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y); line = word; y += lh;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, y);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Build**

Run `npm run build --workspace frontend`. Expected: clean.

- [ ] **Step 3: Commit**
```bash
git add frontend/src/lib/shareImage.ts
git commit -m "feat(share): dependency-free canvas renderer for a branded analysis image"
```

---

## Task 4: ShareModal + entry points

**Files:**
- Create: `frontend/src/modals/ShareModal.tsx`
- Modify: `frontend/src/modals/ModalHost.tsx` (case `'export'`)
- Modify: `frontend/src/views/PositionDetail.tsx` (replace PDF/XLS buttons with a Share button)
- Modify: `frontend/src/modals/OpportunityModal.tsx` (add a Share-image button)

**Interfaces:**
- Consumes: `{ kind: 'export'; context: 'portfolio' | 'position'; instrumentId? }` (already in `store.ts`) — extend it minimally to also carry an optional `symbol`/`name` for the opportunity (image-only) case.

- [ ] **Step 1: Extend the modal kind for the symbol case**

In `store.ts:22` change the `export` variant to:
```ts
  | { kind: 'export'; context: 'portfolio' | 'position' | 'symbol'; instrumentId?: number; symbol?: string; name?: string | null }
```

- [ ] **Step 2: Write `ShareModal.tsx`**

Position context → PDF/DOCX/XLSX/Image + System share + Email. Symbol context → Image + System share + Email of the image. Web Share uses `navigator.canShare({ files })` before attempting; email is `mailto:` with a summary body and a clear "attachment downloaded separately" note (never claims sent).
```tsx
import { useState } from 'react';
import { FileText, FileType, Sheet, Image as ImageIcon, Share2, Mail } from 'lucide-react';
import { useApp } from '../store';
import { Modal } from '../components/Modal';
import { api, downloadExport } from '../lib/api';
import { buildPositionExport } from '../lib/exporters';
import { renderAnalysisImage, downloadBlob, type AnalysisImageInput } from '../lib/shareImage';

export function ShareModal({
  context, instrumentId, symbol, name,
}: { context: 'portfolio' | 'position' | 'symbol'; instrumentId?: number; symbol?: string; name?: string | null }) {
  const { closeModal } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const positionMode = context === 'position' && instrumentId != null;

  async function positionPayload(kind: 'pdf' | 'docx' | 'excel') {
    const p = await api.position(instrumentId!);            // Position + counterfactual bundle
    const cf = p.counterfactual;                            // adjust to the real field name
    const notes = (await api.listNotes('instrument', instrumentId!).catch(() => [])).map((n) => n.body);
    return { payload: await buildPositionExport(p.position, cf, kind, notes), sym: p.position.instrument.symbol, bench: cf.benchmarkSymbol };
  }

  async function doDoc(kind: 'pdf' | 'docx' | 'excel') {
    setBusy(kind);
    try {
      const { payload, sym, bench } = await positionPayload(kind);
      await downloadExport(kind === 'excel' ? 'excel' : kind, payload, `${sym}-vs-${bench}`);
    } finally { setBusy(null); }
  }

  async function imageInput(): Promise<AnalysisImageInput> {
    const sym = positionMode ? (await api.position(instrumentId!)).position.instrument.symbol : symbol!;
    const [val, fit] = await Promise.all([
      api.valuation(sym).catch(() => null),
      api.fit(sym).catch(() => null),
    ]);
    return {
      symbol: sym, name,
      actionLabel: val?.recommendation?.action?.label ?? val?.recommendation?.label ?? null,
      owned: fit?.owned ?? null,
      price: val?.price ?? null, currency: val?.currency ?? null,
      fairValue: val?.fairValue ?? null,
      marginOfSafetyPct: val?.marginOfSafety ?? null,
      bandLabel: val?.band?.label ?? null,
      fitLine: fit?.diversification?.note ?? null,
    };
  }

  async function doImage(share: boolean) {
    setBusy(share ? 'share' : 'image');
    try {
      const input = await imageInput();
      const blob = await renderAnalysisImage(input);
      const file = new File([blob], `${input.symbol}-analysis.png`, { type: 'image/png' });
      if (share && typeof navigator !== 'undefined' && (navigator as any).canShare?.({ files: [file] })) {
        await (navigator as any).share({ files: [file], title: `${input.symbol} analysis` });
      } else {
        downloadBlob(blob, file.name);
        if (share) setMsg('Your browser can’t share files directly — the image was downloaded so you can attach it.');
      }
    } finally { setBusy(null); }
  }

  async function doEmail() {
    const input = await imageInput();
    downloadBlob(await renderAnalysisImage(input), `${input.symbol}-analysis.png`);
    const subject = encodeURIComponent(`${input.symbol} — DecisionGuru analysis`);
    const body = encodeURIComponent(
      `${input.symbol}${input.name ? ' (' + input.name + ')' : ''}\n` +
      `Recommendation: ${input.actionLabel ?? '—'}\n` +
      `Fair value: ${input.fairValue ?? '—'} · Margin of safety: ${input.marginOfSafetyPct != null ? (input.marginOfSafetyPct * 100).toFixed(1) + '%' : '—'}\n\n` +
      `The analysis image was downloaded to your device — attach it before sending.\n` +
      `(Model estimates — not financial advice.)`);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
    setMsg('Opened your email client. Nothing is sent until you press Send — remember to attach the downloaded image.');
  }

  return (
    <Modal title="Share analysis" subtitle={symbol ?? undefined} onClose={closeModal} size="md">
      {positionMode && (
        <div className="mb-5">
          <p className="eyebrow mb-2">Export document</p>
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary" disabled={!!busy} onClick={() => doDoc('pdf')}><FileText size={15} /> PDF</button>
            <button className="btn-secondary" disabled={!!busy} onClick={() => doDoc('docx')}><FileType size={15} /> Word</button>
            <button className="btn-secondary" disabled={!!busy} onClick={() => doDoc('excel')}><Sheet size={15} /> Excel</button>
            <button className="btn-secondary" disabled={!!busy} onClick={() => doImage(false)}><ImageIcon size={15} /> Image</button>
          </div>
        </div>
      )}
      {!positionMode && (
        <div className="mb-5">
          <p className="eyebrow mb-2">Export</p>
          <button className="btn-secondary" disabled={!!busy} onClick={() => doImage(false)}><ImageIcon size={15} /> Image</button>
        </div>
      )}
      <div>
        <p className="eyebrow mb-2">Share via</p>
        <div className="flex gap-2 flex-wrap">
          <button className="btn-secondary" disabled={!!busy} onClick={() => doImage(true)}><Share2 size={15} /> System share</button>
          <button className="btn-secondary" disabled={!!busy} onClick={doEmail}><Mail size={15} /> Email</button>
        </div>
      </div>
      {msg && <p className="text-[12px] text-text-faint mt-4">{msg}</p>}
    </Modal>
  );
}
```
NOTE at implementation: confirm the real field names — `api.position(id)` return shape (`.position` / `.counterfactual`), `api.valuation(sym)` result fields (`recommendation`, `price`, `fairValue`, `marginOfSafety`, `band.label`). Adjust the accessors to match `api.ts`; do not invent fields.

- [ ] **Step 3: Wire into `ModalHost.tsx`**

Import `ShareModal` and add:
```tsx
    case 'export':
      return <ShareModal context={modal.context} instrumentId={modal.instrumentId} symbol={modal.symbol} name={modal.name} />;
```

- [ ] **Step 4: Entry point in `PositionDetail.tsx`**

Replace the two export buttons (`doExport('pdf')` / `doExport('excel')`, lines ~272-277) with one:
```tsx
          <button className="btn-secondary" onClick={() => openModal({ kind: 'export', context: 'position', instrumentId: id })}>
            <Share2 size={15} /> Share
          </button>
```
Import `Share2` from `lucide-react`. Remove the now-unused `doExport` if nothing else uses it (keep `buildPositionExport`/`downloadExport` imports only if still referenced — otherwise drop them to keep the build clean).

- [ ] **Step 5: Entry point in `OpportunityModal.tsx`**

Add a footer/ghost button opening the symbol share:
```tsx
          <button className="btn-secondary" onClick={() => openModal({ kind: 'export', context: 'symbol', symbol, name })}>
            <Share2 size={15} /> Share
          </button>
```
(Use the existing `openModal` from `useApp()` — already destructured in the modal.)

- [ ] **Step 6: Build**

Run `npm run build --workspace frontend`. Expected: clean. Fix any field-name mismatches surfaced by tsc (the NOTE in Step 2).

- [ ] **Step 7: Commit**
```bash
git add frontend/src/store.ts frontend/src/modals/ShareModal.tsx frontend/src/modals/ModalHost.tsx frontend/src/views/PositionDetail.tsx frontend/src/modals/OpportunityModal.tsx
git commit -m "feat(share): ShareModal (PDF/DOCX/XLSX/Image + Web Share + email) on position & opportunity"
```

---

## Self-review notes
- **Coverage:** DOCX (§18), image (§19), email/share within browser limits + no fake "sent" (§20-22), recommendation + portfolio context in the export (§18). PDF/XLSX pre-existing.
- **No fabrication / honesty:** email copy explicitly says nothing is sent until the user presses Send and that the attachment was downloaded separately; Web Share falls back to download with a clear message when `canShare` is false.
- **No new frontend dep:** image is Canvas 2D. One new backend dep: `python-docx`.
- **Field-name risk:** Step 2/Task 4 flags the accessors to confirm against `api.ts` at implementation — not placeholders, but must be verified (position bundle + valuation result fields).
