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

## 4b. App shell & scroll architecture

The app is a **fixed chassis, not a scrolling document**. `#root` is exactly `100dvh`
and `body` is `overflow: hidden`, so the page itself can never scroll. Scrolling only
ever happens *inside* a pane, and panes are independent — moving one never moves another.

```
┌──────────────┬──────────────────────────────────┐
│ brand lockup │  (mobile app bar)                │  ← pinned
├──────────────┼──────────────────────────────────┤
│  nav rail    │  main content well               │
│  ▲ its own   │  ▲ its own scroll                │
│  ▼ scroll    │  ▼                               │
├──────────────┤                                  │  ← pinned
│ settings     │                                  │
└──────────────┴──────────────────────────────────┘
```

- Every scroll pane carries `.pane` (`min-h-0 overflow-y-auto overscroll-contain`).
  **`min-h-0` is load-bearing**: without it a tall child grows a flex column past the
  viewport, the document gains a scrollbar, and scrolling the rail drags the whole shell
  — the exact bug this architecture exists to prevent. `overscroll-contain` stops a pane
  that has hit its end from handing the wheel to its neighbour.
- Narrow panes add `.scroll-slim` (6px bar) — the 10px default eats a 240px rail.
- **Never** set a fixed pixel height to make a pane fit. Panes size from the flex column.
- The **sidebar** is three zones: pinned brand lockup, a `.pane` holding nav + add-data +
  the markets strip (`min-h-full` inner column so the strip sits at the bottom when there
  is slack and simply flows when there is not), and a pinned foot with settings + the
  disclaimer. Rail rows are `h-9` (touch) and `lg:h-8` (pointer).
- The **active destination** is marked by a 2px azure rule flush to the rail's inner edge
  — "azure means you are here", the navigational sibling of "azure means you" on charts
  and metric cards. It costs no vertical space, which is why a dense rail can afford it.
- A long view's page header may be `sticky top-0` **within the main pane**, full-bleed via
  `-mx-6 px-6` over `bg-bg/90 backdrop-blur-md` + a bottom hairline (see `SectionNav`,
  and the Alerts page head). Only ever one sticky bar per view — a page with a
  `SectionNav` rail does not also pin its title.

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
- **Tabs (`Tabs`).** Page-level sub-navigation for a view whose panels each want the whole
  content area — not a control (that's `Segmented`) and not a scroll-spy (that's
  `SectionNav`). Height 40, active tab carries a **2px azure bottom rule** (same "azure
  marks where you are" device as the rail's active row) and a live count pill; inactive is
  `--text-muted` with a `--hairline-strong` underline on hover. Full WAI-ARIA tabs pattern
  incl. arrow-key roving focus. **Counts are always derived from the real data** — never a
  constant. Sits on a container hairline via `-mb-px` so the active rule replaces it.
- **Empty states (`EmptyState`).** An empty screen is an invitation to act, never an
  apology: optional glyph in a hairline ring, a plain-language title, one sentence saying
  what will fill it and what to do, and the action itself where there is one. Wrap in a
  `border-dashed border-hairline` panel so the region reads as defined rather than adrift.
- **Chips / tags.** `rounded-full`, `--surface-2`, `label` 11px. Status dot 6px: gain/loss/azure/gold/warn.
- **Staleness / data source.** Small `--warn` dot + timestamp caption when cached market data is old; `--text-faint` "live" otherwise.
- **The delta panel.** Big number (`display-xl`, gain/loss coloured), eyebrow basis line, sub-line "ETF would recover this in ~N months". This is the per-position decision panel's crown.

## 7. Charts (Recharts) & globe (cobe)

- **Colour tokens are Tailwind theme values (`tailwind.config.js`), _not_ CSS custom
  properties.** There is no `--azure`/`--gain`/`--surface-2` CSS variable, so passing
  `var(--token)` to a Recharts `stroke`/`fill`/`tick.fill` prop resolves to nothing and the
  SVG presentation attribute falls back to black — invisible on `--bg`. Always pass the
  **hex literal** (e.g. `stroke="#3DA9FC"`), the way `DeltaChart` does. Token→hex: gain
  `#31D6A0`, loss `#FF5D6C`, warn `#F0B34A`, azure `#3DA9FC`, gold `#D9A94E`, text-faint
  `#5F6E82`, hairline `#243040`, surface-2 `#1A2331`.
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
  zones — buy = `--gain`@15%, fair = `--azure`@8%, overvalued = `--warn`@14%, sell =
  `--loss`@18% (fills clearly perceptible on `--bg` yet subordinate to the line). Thin
  dashed **boundary dividers** sit at each band edge — entry target (`--gain`), overvalued
  threshold (`--warn`) and sell zone (`--loss`) — and a separate dashed **fair-value
  reference line** (`--text-faint`) is labelled with its value. The azure price line is the
  dominant mark (≈2.2px, full opacity) with a **marker dot at the latest point**. Subtle
  horizontal-only gridlines (`--hairline`, dashed) sit behind the bands. The y-domain always
  spans `min/max(price series ∪ all four zone thresholds)` plus padding, so no band is ever
  clipped off-canvas. This is the only place price and valuation share an axis; keep the
  azure price line dominant. One shared component feeds Discover, Research and the map/screener
  drill-in — never fork per-view variants.
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

**Discover — New-opportunities mode:** the *All names / New opportunities* toggle is a
standard `Segmented` control; New-opportunities is never the default (All names is, to
preserve prior behaviour). A freshly-attractive name carries a `--gain` **`NEW`** chip and
appears in the gain-bordered "New opportunities today" strip (same treatment as the
sell-signal card, gain side). Grouping (Sector / Industry-theme / Country) reuses the gold
group-header eyebrow. A screened name's row opens the **OpportunityModal** (reuses
ValueAnalysis) — detail is a modal, never a redirect.

**Discover — sortable table:** every column header in the results table is a sort
control, not a static label. A header is a full-width `button` inheriting the `.th`
type (no restyle of the cell); the **active** column shows a small chevron
(`--text` when active, hidden otherwise) — up for ascending, down for descending.
Click a header to sort by it; click the active header again to flip direction.
Numeric columns (Price, Margin of safety, Quality, Supportable, Yield, Portfolio fit,
Attractiveness) sort numerically with nulls always last; text columns (Company, Sector,
Verdict) sort alphabetically. First click on a numeric column is **descending** (biggest
first), on a text column **ascending** — because that is the useful default in each case.
The table defaults to **Attractiveness descending**; sorting composes with the filters,
the mode toggle and grouping (rows sort within each group when grouped).

**Price freshness:** a price is never shown as `0.00`. When the value is not a fresh
live quote it carries a faint qualifier in `--text-faint` (`prev close · <date>` for a
cached close, `delayed` for a stale quote). The number stays in the normal price
style; only the qualifier is faint. If no price exists anywhere, show an explicit
"no price data" rather than a zero.

**External / new-tab links:** in-app navigation stays a store transition (no reload).
The one exception is **Open Research**, which opens the addressable
`#/research/<symbol>` route in a **new tab** — a real `<a target="_blank"
rel="noopener noreferrer">` styled as the primary button (`.btn-primary`), with the
`ArrowUpRight` glyph marking it as leaving the current tab.

## 9c. Unified verdict (single recommendation engine)

Every surface that recommends an action — Overview, Decisions, Advisory, Discover,
Watchlist and the per-position detail page — renders **one** verdict produced by the
shared engine (`services/verdict.py`). No view computes its own buy/sell/hold logic, and
the **same asset shows the identical verdict, confidence and rationale everywhere**; views
differ only in presentation density.

**Canonical verdict set** — exactly three, each mapped onto the reserved semantic tokens
(never a new colour):
| Verdict | Meaning | Colour role | Token |
|---|---|---|---|
| **Buy more** | Undervalued with a real margin of safety and sound fundamentals | gain | `--gain` |
| **Hold** | Fairly valued, or overvalued-but-sound (with a trim note), or a value-trap caution | neutral | `--text-muted` / `--hairline-strong` |
| **Sell** | In the sell zone (≥ fair × 1.40) — realise it (tax-free for a private investor) | loss | `--loss` |

- **`VerdictBadge`** is the canonical chip (dot + label), same shape as `BandBadge`:
  `chip` + 6px status dot + sentence-case label. Buy more = `--gain`, Hold =
  `--text-muted` (dot `--text-faint`), Sell = `--loss`. Reuse it everywhere a verdict is
  shown — never fork a per-view badge. An optional faint `conf` suffix (`--text-faint`,
  11px) shows the confidence (`high` / `medium` / `low`) when space allows.
- **Rationale line.** One factual sentence in the product voice listing the driving
  factors — valuation band, margin of safety %, upside to fair value, quality score,
  performance vs the benchmark — then the resolved verdict. `--text-muted`, 13px, tabular
  figures for the numbers. Never advisory phrasing beyond the verdict word itself.
- **Conflict note.** When the verdict overrides a signal — underperforming the benchmark
  yet **Buy more**, or beating it yet **Sell** — a one-line note explains why valuation
  won, prefixed with a small `↔` connector in `--text-faint`. This is the core of the
  feature: benchmark underperformance alone **never** yields Sell. Style: `--text-faint`,
  11–12px, sits directly under the rationale.
- **Trim note.** Overvalued-but-not-sell-zone and concentration flags surface as a
  `--warn` "consider trimming" note on a **Hold** verdict — they never escalate the badge.
- **Value-trap caution.** Undervalued but weak/deteriorating fundamentals resolves to
  **Hold** with a `--warn` value-trap note — never auto-**Buy more**, never **Sell** for
  lagging the benchmark.
- **Underperformance cause.** The rationale states which case applies: *fundamentals-driven*
  (weak/falling quality, declining earnings — a genuine concern) vs *temporary discount*
  (a sound, undervalued name that simply lags). Never colour the cause; it lives in the
  rationale/conflict text.
- **Sell framing.** A Sell verdict reuses the existing after-tax framing (`SellSignalPanel`):
  the crown figure is the after-tax gain if sold now, gain-coloured, with the plain Swiss
  tax fact. The badge says the verdict; the panel carries the numbers.

## 9d. Advanced Discover filters (numeric ranges, presets)

The screener's dropdown filters (sector / industry / verdict) and mode toggle are joined
by a **numeric filter bar** for the measurable columns. All filters compose with logical
**AND**; results, the count and the map recompute **live** on every change (inputs
lightly debounced, no apply button). None of this introduces a new colour — it reuses the
tokens and the `.input` / `.chip` primitives.

- **Range control (`RangeFilter`).** One per numeric metric — at minimum **Dividend
  yield** and **Margin of safety**, plus **Quality**, **Supportable return** and
  **Price**. A compact block: a `label` caption + the live min–max readout (mono,
  tabular, in the metric's own unit — `%` for the rate metrics, `/100` for quality,
  currency for price), over a **dual-thumb slider**. The slider track is `--surface-2`
  (`h-1.5`, `--r-sm`); the **selected span** between the thumbs is filled `--azure` at
  full opacity; the two thumbs are 14px `--azure` discs with a 1px `--bg` ring and the
  standard azure focus ring. The domain (min/max bounds) is derived from the data's own
  spread for that metric, so the ends are always reachable. A metric is **active** only
  when its range is narrower than the full domain.
- **Missing values.** A name with no value for an *active* metric is excluded from that
  filter (never coerced to 0) and reappears the moment the filter is cleared. A name is
  never dropped by a metric the user hasn't touched.
- **Preset chips.** A row of `.chip` toggles for common value combinations — **High MoS**,
  **High yield**, **Undervalued income** (high MoS *and* high yield). A preset only
  *sets* the underlying ranges (which stay freely editable afterwards); an active preset
  chip reads `--azure` (text + `border-azure/50`), inactive is the default chip. Presets
  are a shortcut onto the same range state, never a separate filter.
- **Active-filter count + clear-all.** When any filter (dropdown or range) is active, a
  faint count (`--text-faint`, e.g. `3 filters`) sits by a **Clear all** ghost control
  that resets every filter and preset at once. Absent when nothing is filtered.
- **Sorting composes.** Dividend yield and margin of safety are ordinary sortable columns
  (§ *Discover — sortable table*); sorting always runs *after* filtering, so the active
  ranges and the sort order stack.

## 9e. Cross-listing & exchange recommendation

When a company trades on more than one exchange, DecisionGuru names the **one listing to
buy for a CHF portfolio** so two lines of the same company are never confused. The
recommendation is derived per-investor from the configured base currency (Tax & settings,
CHF) — never a fixed default. It lives in the **opportunity detail modal**; a name's own
exchange also shows as a faint tag on its Discover row (derived from the ticker suffix, no
fetch). No new colour: currency-match is the one moment that earns `--gain`.

- **Recommended listing (`ListingRecommendation`).** A `--gain`-left-bordered block (same
  device as the new-opportunities strip) headed by an eyebrow `RECOMMENDED FOR YOUR CHF
  PORTFOLIO`. It carries: the **exchange name**, the **exact exchange-specific ticker** in
  mono (`NESN.SW`, `SHEL.L`), the **trading currency**, and a **copy button**. When the
  recommended listing already trades in CHF that fact is the crown (`--gain`); otherwise
  the block is quiet (`--hairline-strong` left border) and states the single FX conversion
  plainly.
- **Copy button (`CopyTicker`).** A `.btn-secondary`-height control pairing the mono
  ticker with a `Copy` glyph; on click it copies the exchange-specific symbol and flips to
  a `--gain` `Check` + “Copied” state for ~1.5s, then reverts. Keyboard-operable, ≥36px hit
  target. This is the canonical copy affordance — reuse it wherever a ticker is copied.
- **Why-this-exchange.** One factual sentence under the ticker (`--text-muted`, 13px,
  tabular figures), in the product voice: currency match (“Trades in CHF — no conversion”)
  or the FX case (“No CHF listing; London in USD is the most liquid major line — one FX
  conversion, ≈ CHF 0.79 per USD today”). Never advisory beyond stating the facts.
- **Alternative listings.** Every other detected listing is listed beneath the recommended
  one as a quiet hairline-separated row — exchange · mono ticker · currency · copy — each
  clearly labelled so the wrong line is never picked. A ticker is never shown bare and
  ambiguous.
- **Graceful degradation.** One known listing → show it as the ticker with no
  recommendation ceremony. Cross-listing data unavailable → show the primary listing and
  note alternatives weren't found. Never fabricate an exchange, ticker or currency.

## 10. Voice

Plain, factual, instrument-like. State numbers; never advise. "You'd have CHF 4,120
more in VWRL" — not "you should sell". Errors explain what happened and how to fix it.
Empty states invite the next action ("Import a history or add a position to begin").
Sentence case everywhere. Swiss number format: `1'234.50`, currency prefixed (`CHF 1'234`).
