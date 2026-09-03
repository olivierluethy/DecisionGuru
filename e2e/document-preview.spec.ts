import { test, expect, type Page } from '@playwright/test';

/**
 * The document preview must show ONE document in two formats.
 *
 * The PDF side has always looked right; the Word side is what these assertions pin down —
 * that a Word page is the same size as a PDF page, that no page grows past A4 because a
 * table did not fit, that a thumbnail is a picture of its page rather than a shifted crop
 * of it, and that the Word text is set in the same face the PDF uses. The last two checks
 * cover the search highlight staying readable and dates reading as dates.
 *
 * The doc is injected through the dev-only store handle (window.__app, see store.ts), so
 * these run without any market data.
 */

const A4 = { w: 794, h: 1123 };  // A4 at 96dpi — the CSS size of one page, both formats

/** A document long enough to paginate, with a table taller than a single page. */
const DOC = {
  title: 'Portfolio review — Q3 2026',
  subtitle: 'Swiss tax-aware counterfactual analysis',
  meta: [
    { label: 'As of', value: '03 Sep 2026' },
    { label: 'Currency', value: 'CHF' },
    { label: 'Benchmark', value: 'VT' },
  ],
  blocks: [
    {
      id: 'summary', kind: 'text', title: 'Summary',
      body: 'The portfolio returned 12.4% over the trailing year against 9.1% for the benchmark.'
        + '\n\nTwo positions account for 41% of book value.',
    },
    {
      id: 'holdings', kind: 'table', title: 'Holdings',
      headers: ['Symbol', 'Name', 'Weight', 'Value CHF', '1Y return'],
      rows: Array.from({ length: 90 }, (_, i) => [
        `SYM${i}`, `Company Number ${i} Holding AG`, `${(3 + i / 10).toFixed(1)}%`,
        `${12000 + i * 731}`, `${(i - 8).toFixed(1)}%`,
      ]),
    },
    { id: 'notes', kind: 'notes', title: 'Notes', items: ['Prices are previous close.', 'FX from ECB rates.'] },
  ],
};

async function openPreview(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __app?: unknown }).__app), null, { timeout: 30_000 });
  await page.evaluate(
    (doc) => (window as never as { __app: { getState(): { openModal(m: unknown): void } } })
      .__app.getState().openModal({ kind: 'doc-preview', doc }),
    DOC,
  );
  await expect(page.getByText('Document preview')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.locator('.dg-doc-pages .dg-doc-page').count(), { timeout: 40_000 })
    .toBeGreaterThan(0);
}

const pageBoxes = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>('.dg-doc-pages .dg-doc-page'))
    .map((el) => ({ w: el.offsetWidth, h: el.offsetHeight })));

/**
 * Switch to Word and wait for the Word DOM specifically.
 *
 * The previous format's pages stay on screen until the new render replaces them, so simply
 * counting `.dg-doc-page` after the click still counts PDF pages. docx-preview emits each
 * page as a `<section>`; pdf.js pages are `<div>`s. That tag is the only unambiguous signal
 * that the switch has actually landed.
 */
async function switchToWord(page: Page) {
  await page.getByRole('button', { name: 'Word' }).click();
  await expect
    .poll(() => page.locator('.dg-doc-pages section.dg-doc-page').count(), { timeout: 40_000 })
    .toBeGreaterThan(1);
  // One frame for the split tables to settle before anything is measured.
  await page.waitForTimeout(300);
}

test('a Word page is the same page as a PDF page', async ({ page }) => {
  await openPreview(page);
  const pdf = await pageBoxes(page);
  expect(pdf.length).toBeGreaterThan(1);
  for (const box of pdf) {
    expect(box.w).toBeCloseTo(A4.w, -0.5);
    expect(box.h).toBeCloseTo(A4.h, -0.5);
  }

  await switchToWord(page);
  const word = await pageBoxes(page);

  // Same paper. A page that grew because a block did not fit is the bug this pins down.
  for (const box of word) {
    expect(box.w).toBeCloseTo(A4.w, -0.5);
    expect(box.h).toBeCloseTo(A4.h, -0.5);
  }
  expect(word[0].w).toBeCloseTo(pdf[0].w, -0.5);
  expect(word[0].h).toBeCloseTo(pdf[0].h, -0.5);
});

test('a table too long for one page carries its header onto the next', async ({ page }) => {
  await openPreview(page);
  await switchToWord(page);

  const tables = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLTableElement>('.dg-doc-pages section.dg-doc-page table'))
      .map((t) => ({
        first: Array.from(t.rows[0]?.cells ?? []).map((c) => (c.textContent ?? '').trim()),
        bodyRows: t.rows.length - 1,
      })));

  // The 90 rows have to be spread over more than one table, and no row may go missing.
  expect(tables.length).toBeGreaterThan(1);
  expect(tables.reduce((n, t) => n + t.bodyRows, 0)).toBe(90);
  // Every continuation repeats the header, the way Word's `w:tblHeader` asks it to.
  for (const t of tables) expect(t.first).toEqual(DOC.blocks[1].headers);
});

test('a Word thumbnail is a picture of its whole page', async ({ page }) => {
  await openPreview(page);
  await switchToWord(page);

  const thumbs = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.dg-doc-chrome button[title^="Page"]'))
      .slice(0, 3)
      .map((btn) => {
        const host = btn.querySelector<HTMLElement>('div');
        const section = host?.querySelector<HTMLElement>('section');
        if (!host || !section) return null;
        const h = host.getBoundingClientRect();
        const s = section.getBoundingClientRect();
        return { dx: s.left - h.left, dy: s.top - h.top, dw: s.width - h.width, dh: s.height - h.height };
      }));

  expect(thumbs.filter(Boolean).length).toBeGreaterThan(1);
  for (const t of thumbs) {
    if (!t) continue;
    // The scaled page must sit ON its host, not beside it.
    expect(Math.abs(t.dx)).toBeLessThan(1.5);
    expect(Math.abs(t.dy)).toBeLessThan(1.5);
    expect(Math.abs(t.dw)).toBeLessThan(1.5);
    expect(Math.abs(t.dh)).toBeLessThan(1.5);
  }
});

test('Word text is set in the same face as the PDF', async ({ page }) => {
  await openPreview(page);
  await switchToWord(page);

  const faces = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.dg-doc-pages section.dg-doc-page span'))
      .slice(0, 12)
      .map((el) => getComputedStyle(el).fontFamily));

  expect(faces.length).toBeGreaterThan(0);
  // The PDF is Helvetica throughout. Word's default theme fonts (Calibri / the serif
  // Cambria) are what made the two documents look unrelated.
  for (const f of faces) expect(f).toMatch(/Helvetica|Arial/i);
  for (const f of faces) expect(f).not.toMatch(/Cambria|Times|serif/i);
});

test('a search hit stays readable in both formats', async ({ page }) => {
  await openPreview(page);

  for (const format of ['PDF', 'Word'] as const) {
    if (format === 'Word') await switchToWord(page);
    await page.getByPlaceholder('Find in document').fill('benchmark');
    await expect(page.getByText(/1 \/ \d/)).toBeVisible({ timeout: 10_000 });

    // The PDF text layer is transparent and its glyphs live on the canvas underneath, so an
    // opaque highlight erases the word it is meant to point at. Both highlights must stay
    // see-through enough for the text to read through them.
    const alphas = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const read = (name: string) => {
        // ::highlight() is not reachable from getComputedStyle; read the rule instead.
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule && rule.selectorText === `::highlight(${name})`) {
              const m = /rgba?\([^)]*?([\d.]+)\s*\)/.exec(rule.style.backgroundColor);
              return m ? Number(m[1]) : 1;
            }
          }
        }
        return null;
      };
      probe.remove();
      return { hit: read('dg-find'), active: read('dg-find-active') };
    });

    expect(alphas.hit).not.toBeNull();
    expect(alphas.active).not.toBeNull();
    expect(alphas.hit!).toBeLessThanOrEqual(0.6);
    expect(alphas.active!).toBeLessThanOrEqual(0.6);
    await page.getByPlaceholder('Find in document').fill('');
  }
});

test('dates in an exported document read as dates', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as never as { __app?: unknown }).__app), null, { timeout: 30_000 });

  const meta = await page.evaluate(async () => {
    const mod = await import('/src/lib/domExport.ts');
    const host = document.createElement('div');
    host.innerHTML = '<h2>Analysis</h2><p>' + 'x'.repeat(60) + '</p>';
    document.body.appendChild(host);
    const doc = await mod.docFromElement(host, {});
    host.remove();
    return doc.meta;
  });

  const asOf = meta?.find((m: { label: string }) => m.label === 'As of');
  expect(asOf).toBeTruthy();
  expect(asOf!.value).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(asOf!.value).toMatch(/^\d{2} [A-Z][a-z]{2,3} \d{4}$/);
});
