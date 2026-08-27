# DecisionGuru — Style Guide

> Single source of truth for the visual system. Dark mode only. Tailwind only.
> Every new feature must look like it was always part of the product. Colours and
> type stay exactly as specified here.

## 1. Design thesis

**A precision instrument for the road not taken.**

DecisionGuru answers one question: *how much better or worse off am I holding this
stock versus the same money in an ETF, after Swiss tax?* The whole aesthetic serves
that comparison. It is Swiss-cool, engineered, dense but legible — a measuring device,
not a brochure.

### The signature: the counterfactual delta

One visual language repeats at every scale (position, basket, portfolio):

- **Azure** = *you* — your actual position / the path you took.
- **Gold (dashed / ghosted)** = the **counterfactual** — the ETF you did *not* buy, the road not taken.
- The **area between the two lines** is shaded **green** (your pick won) or **red** (the ETF won). That shaded gap **is** the opportunity cost.
- The delta number is rendered **large and unmissable** — this is the emotional core the product exists to expose.

This azure-vs-gold-with-shaded-delta motif is the one thing the app is remembered by.
Everything else stays quiet so it can shout.

## 2. Colour tokens

Dark mode only. Cool near-black base (precision instrument, Swiss cool — never warm).
Semantic red/green are **reserved for loss/gain** and must never be used decoratively.

### Base / surfaces
| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0A0E15` | App background (cool near-black) |
| `--bg-elev` | `#10151F` | Elevated background, rails |
| `--surface` | `#141B27` | Cards, panels, modals |
| `--surface-2` | `#1A2331` | Nested surfaces, table header, inputs |
| `--hairline` | `#243040` | Borders, dividers (1px) |
| `--hairline-strong` | `#324156` | Emphasised borders, focus tracks |

### Text
| Token | Hex | Use |
|---|---|---|
| `--text` | `#E7EDF5` | Primary (cool white) |
| `--text-muted` | `#93A1B5` | Secondary / labels |
| `--text-faint` | `#5F6E82` | Captions, disabled, eyebrows |

### Semantic — reserved
| Token | Hex | Use |
|---|---|---|
| `--gain` | `#31D6A0` | Positive P/L, up moves |
| `--gain-dim` | `#1C7A5E` | Gain fills / shaded areas @ low alpha |
| `--loss` | `#FF5D6C` | Negative P/L, down moves |
| `--loss-dim` | `#8F3038` | Loss fills / shaded areas @ low alpha |
| `--warn` | `#F0B34A` | Staleness, cautions (distinct from gold accent by context) |

### Brand / structural accents
| Token | Hex | Use |
|---|---|---|
| `--azure` | `#3DA9FC` | **You / actual position.** Primary interactive, links, focus, primary line |
| `--azure-bright` | `#6FC3FF` | Hover / active azure |
| `--gold` | `#D9A94E` | **Counterfactual / ETF (road not taken).** The ghost line, opportunity-cost highlight |
| `--gold-bright` | `#F0C368` | Hover / active gold |

> **Why not Swiss red as the accent?** Red is loss. Using it for brand would poison the
> single most important signal in the app. The brand carries azure (you) + gold (the
> counterfactual) instead — a palette that itself encodes the core comparison.

## 3. Typography

Three roles. Self-hosted via `@fontsource` (no runtime CDN — local-first).

| Role | Family | Notes |
|---|---|---|
| Display / headings | **Space Grotesk** | Engineered grotesque, strong numerals. Used with restraint |
| Body / UI | **Inter** | Neutral workhorse. `font-feature-settings: "cv05","ss01"; tabular-nums` in tables |
| Data / mono | **JetBrains Mono** | All aligned financial figures, tickers, ISINs, code. `tabular-nums` |

**All monetary and percentage figures use tabular figures** so columns align. Prefer
mono for dense numeric tables and the big delta numbers.

### Type scale
| Token | Size / line | Weight | Use |
|---|---|---|---|
| `display-xl` | 48 / 52 | 600 | The one hero delta number |
| `display-l` | 34 / 40 | 600 | Section hero numbers |
| `h1` | 24 / 30 | 600 | Page / modal titles |
| `h2` | 19 / 26 | 600 | Card titles |
| `h3` | 15 / 22 | 600 | Sub-sections |
| `body` | 14 / 21 | 400 | Default |
| `label` | 13 / 18 | 500 | Form labels, table headers |
| `eyebrow` | 11 / 14 | 600 | Uppercase, `letter-spacing: 0.12em`, `--text-faint` |
| `mono-num` | 14 / 20 | 500 | Table figures |

## 4. Spacing, radii, borders, elevation

- **Spacing:** Tailwind 4px scale. Section rhythm 24/32; card padding 20 (`p-5`); dense tables 8–12.
- **Radii:** tight, engineered. `--r-sm: 4px` (inputs, chips), `--r: 6px` (cards, buttons), `--r-lg: 10px` (modals). **No pills** except tag chips (`rounded-full` only for tiny status dots/tags).
- **Borders:** hairline `1px solid var(--hairline)` is the primary separation device — this is a Swiss-grid product, structure is drawn with rules, not shadows.
- **Elevation:** minimal. Modals: `box-shadow: 0 24px 60px -20px rgba(0,0,0,.7)` + hairline. Accent glow (used sparingly on the hero delta / focus): `0 0 0 1px + 0 0 20px -6px` of the accent at low alpha. Never drop-shadow cards.

## 5. Structural devices (encode meaning, don't decorate)

- **Eyebrows** label a data region's *unit / basis* (e.g. `AFTER-TAX · CHF`), not decoration.
- **Hairline grid** organises dense data; align everything to it.
- **Directional glyphs / colour** (▲ gain / ▼ loss) always pair with `--gain`/`--loss`; never colour a number green/red without meaning.
- **Ghost/dashed strokes** are exclusively the counterfactual. A dashed gold line always means "the ETF you didn't buy". Never dash for style.
- No `01 / 02 / 03` numbering unless the content is a genuine ordered sequence (e.g. the import wizard steps).

## 6. Components

- **Buttons.** Primary = azure fill (`--azure`) on dark, `--bg` text, hover `--azure-bright`. Secondary = surface + hairline, text `--text`. Ghost = text-only azure. Destructive = `--loss` outline → fill on hover. Height 36 (`h-9`), radius `--r`, mono-friendly labels in sentence case.
- **Cards / panels.** `--surface`, `1px --hairline`, `--r`. Title row: `h2` + right-aligned unit eyebrow. Optional accent left-border (2px) only to flag the hero opportunity-cost card.
- **Tables.** Header row `--surface-2`, `label` uppercase-ish, sticky. Rows hairline-separated, hover `--surface-2`. Numeric columns right-aligned, mono, tabular. Gain/loss coloured per §2.
- **Inputs.** `--surface-2`, `1px --hairline`, `--r-sm`, focus → `--azure` ring (`0 0 0 2px azure@40%`). Labels `label` above.
- **Modals.** All create/edit/import/settings/scenario flows are **modals, never route changes**. Backdrop `rgba(6,9,14,.66)` + blur(2px). Panel `--surface`, `--r-lg`, max-w per content, hairline header/footer, `Esc`/backdrop close, focus-trapped.
- **Chips / tags.** `rounded-full`, `--surface-2`, `label` 11px. Status dot 6px: gain/loss/azure/gold/warn.
- **Staleness / data source.** Small `--warn` dot + timestamp caption when cached market data is old; `--text-faint` "live" otherwise.
- **The delta panel.** Big number (`display-xl`, gain/loss coloured), eyebrow basis line, sub-line "ETF would recover this in ~N months". This is the per-position decision panel's crown.

## 7. Charts (Recharts) & globe (cobe)

- Grid lines `--hairline` at low alpha; axes `--text-faint`; tooltips `--surface-2` + hairline.
- **Actual series = `--azure` solid.** **Counterfactual/ETF series = `--gold`, dashed (`4 3`).**
- Delta area between them: `--gain`/`--loss` at ~12% alpha.
- Projection / hypothetical curves are always dashed and labelled "hypothetical".
- **cobe globe:** dark ocean matching `--bg`, azure landmasses, gold markers sized by allocation weight; glow azure. One globe per instrument, never gratuitous.

## 8. Motion

Restrained, purposeful. `prefers-reduced-motion` fully respected (disable all).
- Modal in: 140ms ease-out fade+2px rise. Backdrop 120ms fade.
- Number/delta reveal: 500ms count-up on first render of a decision panel (respect reduced-motion → snap).
- Hover micro: 100ms colour only. No parallax, no scattered ambient effects. The globe's slow auto-rotation is the one ambient motion.

## 9. Quality floor

Responsive to mobile (rail collapses to top bar), visible keyboard focus (azure ring),
reduced-motion honoured, hit targets ≥ 36px, contrast AA on `--text`/`--text-muted`
against surfaces. A persistent "Not financial advice" disclaimer lives in the footer/rail.

## 9b. Valuation bands, sell signals & alerts (value-investing layer)

These reuse the existing tokens — no new colours. Meaning is carried by the reserved
gain/loss/warn semantics, never decoration.

**Fair-value bands** (a security's price vs its estimated fair value):
| Band | Colour role | Token |
|---|---|---|
| Undervalued (≤ entry target) | gain | `--gain` |
| Fairly valued | neutral | `--text-muted` / `--hairline-strong` |
| Overvalued (≥ fair ×1.20) | caution | `--warn` |
| Significantly overvalued (≥ fair ×1.40) | loss | `--loss` |

- **`BandBadge`** is the canonical chip (dot + label) — reuse it everywhere a band is shown
  (valuation panel, watchlist, screener, map drill-in, replay).
- **Price-zone chart** (`PriceBandChart`): the azure price line over shaded `ReferenceArea`
  zones — buy = `--gain`@12%, fair = `--azure`@5%, overvalued = `--warn`@10%, sell =
  `--loss`@13% — with dashed guides for the entry target (`--gain`), fair value
  (`--text-faint`) and sell zone (`--loss`). This is the only place price and valuation
  share an axis; keep the azure price line dominant.
- **Sell signal** is a loss-bordered card; the crown figure is the **after-tax gain if sold
  now** in `display-l`/mono, gain-coloured. State the tax fact plainly (capital gains are
  tax-free for a private investor); never say "sell".
- **Attractive entry price** = fair value × (1 − margin of safety), always gain-coloured.

**Alerts & notifications:** buy alerts carry a `--gain` up-glyph, sell alerts a `--loss`
down-glyph; `auto` (scan-maintained) alerts get a faint `auto` chip. Triggered alerts use a
`--warn` surface. The header **bell** shows an unread count in a `--loss` dot badge — the one
place a small red badge is allowed, because an unread alert is genuinely actionable.

**Discover map:** the signature **cobe** globe (§7) doubles as the opportunity map — gold
markers sized by opportunity density; the country rail is the legend and the drill-in
trigger. No second map metaphor.

## 10. Voice

Plain, factual, instrument-like. State numbers; never advise. "You'd have CHF 4,120
more in VWRL" — not "you should sell". Errors explain what happened and how to fix it.
Empty states invite the next action ("Import a history or add a position to begin").
Sentence case everywhere. Swiss number format: `1'234.50`, currency prefixed (`CHF 1'234`).
