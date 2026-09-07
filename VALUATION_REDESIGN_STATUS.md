# Valuation Engine Redesign — Status & Handoff

> **Date:** 2026-09-08 · **Branch:** `feat/valuation-graham-buffett` · **State:** Areas 1–3 implemented + tested, **NOT committed**, still on the branch (main is untouched). Area 4 not started.

Governing goal: make DecisionGuru's valuation a **strictly conservative Graham/Buffett value-investing** engine — fewer, more defensible intrinsic values; abstain rather than fake precision. Statistics/heuristics are implementation tools only; they must never introduce a separate investment philosophy.

**Overriding principle (frozen):** *When Graham/Buffett principles and a precise numerical valuation conflict, prefer the conservative conclusion and abstention over false precision.*

**Do NOT:** add momentum, technical analysis, factor investing, market timing, ML/predictive scores, or ticker/company-specific rules. Do not tune parameters to make a holding land on a chosen verdict.

---

## The 5 binding gates (apply to all work)
1. No growth rate is ever presented as a Graham/Buffett rule (the +15% cap included).
2. The `[-5%, +15%]` growth clamp is an explicit internal **guardrail / sensitivity control**, never evidence the fair value is intrinsically correct.
3. A computed fair value never alone makes a high-growth / cap-sensitive name a BUY.
4. Intrinsic value, confidence, and margin of safety stay **separate** concepts (never merged into one "Fair" label).
5. Insufficient evidence → `NO RELIABLE FAIR VALUE`, never a forced number.

Additional frozen rules: default structural growth **0%**; positive growth only with multi-year, still-trending evidence in the chosen measure (never from revenue, never a single year, never auto-high); ROIC/margins/moat may support durability **confidence** but must never mechanically create a growth number; no-growth value stays visible as the anchor; growth may not turn a no-margin-of-safety company into a BUY; Graham Number is a cross-check, not a universal floor; BUY requires a genuine conservative margin of safety **and** reliable assumptions; low confidence is a **decision constraint**, not just a display label.

---

## What is DONE (branch `feat/valuation-graham-buffett`)

### Area 1 — Intrinsic value independent of price ✅
- **Change:** book value per share now comes from the balance sheet (`equity ÷ shares`, minor-unit normalized, price-independent) instead of `price / priceToBook`. So the fair value no longer tracks the market price and the margin of safety is a real discount. (`backend/app/services/valuation.py`, ~line 289.)
- **Tests:** `backend/tests/test_valuation_price_independence.py`.

### Area 2 — Business-type routing + abstention ✅
- **Change:** `_framework_for_sector` routes financials/REITs (sector ∈ Financial Services, Banks, Insurance, Real Estate) to **NAV/book**; `validate_book_value` rejects corrupt/share-class book data (Berkshire 0.001× P/B; balance vs feed book disagree) → abstain. `<3` profitable years on record → `NO RELIABLE FAIR VALUE` (no forward-EPS fantasy).
- **Output fields added:** `valuationFramework`, `reliableValue`, `reliabilityReason`, `bookNav` (navPerShare, priceToNav, caveat).
- **Tests:** `backend/tests/test_valuation_routing.py`.

### Area 3 — Sustainable earning power first, growth only when justified ✅
- **New module:** `backend/app/services/earning_power.py` — deterministic:
  - `select_measure(eps_series, fcf_series)`: FCF erratic/negative while earnings positive (working-capital/order timing) → **normalized net income**; FCF persistently above net income and stable (amortization-heavy) → **owner earnings / FCF**; else net income. (Uses drawdown, not raw CoV, so a growing series isn't mistaken for noise.)
  - `derive_growth(series, roe, margins_stable)`: default **0%** (`basis:"none"`); credit growth only if the series is still near its peak (uptrend) with a positive smoothed CAGR → conservative **half** of it, guardrail 15% (`basis:"supported"`); exceptional (>20%) → capped, `basis:"high-capped"`, low confidence. ROE/margins set **confidence only**, never the growth number.
  - `value_at_growth(level, g, bvps, roe)`: median of a DCF on the normalized level + Graham-growth anchor; Graham **number** added only when book is the value driver (`roe < 0.30`) — not a universal floor.
  - `sensitivity(...)`: fair value at 0% / g / g+3pp → the reliability signal.
- **Wired into** `value_analysis` (the "earnings" framework branch): builds per-share series (`_per_share_series`), selects measure/level, derives growth, computes `fairValue` (with growth) and `noGrowthValue` (anchor), sets a **reliability tier** (1 reliable · 2 assumption-sensitive → no buy · 3 abstain).
- **Abstentions added (the 3 applied decisions):**
  - **Cross-listing** (reporting ≠ trading currency) → can't normalize in the trading basis → NO RELIABLE FV.
  - **Cash conversion:** measure fell back to net income AND recent FCF ≤ 0 (owner not receiving cash) → NO RELIABLE FV.
  - **Deep cyclical trough** (latest < 0.35× the level, volatile, <6y of data) → NO RELIABLE FV.
- **Output fields added:** `reliabilityTier`, `earningPower` (measure, normalizedLevel, growthAssumption, growthBasis, growthConfidence, growthReason, noGrowthValue, sensitivity, assumptionSensitive), `noGrowthValue`, `growthAssumption`, `growthBasis`, `assumptionSensitive`.
- **Tests:** `backend/tests/test_earning_power.py`, `backend/tests/test_valuation_area3.py`. Old superseded tests updated: `test_valuation_scenarios_phase2.py` (bear/base/bull retired → no-growth anchor + sensitivity), `test_valuation_fcf_phase2.py`, `test_valuation_phase1.py`, `test_valuation_cross_listing.py`.

**Backend suite:** `169 passed`; the only failures are the 3 pre-existing `test_market_analysis_bundle` (unrelated, documented — do not chase).

---

## Real-25 result (the actual engine, last cached close)
- **1 earnings BUY candidate:** Carrefour (undervalued, owner earnings/FCF, **0% growth** — does NOT depend on a growth assumption).
- **1 book discount:** Vonovia (below NAV, leverage caveat — not an auto-buy).
- **10× NO RELIABLE FAIR VALUE:** cross-listings (SNY, Novartis, Constellation), no cash conversion (Lufthansa, Barry Callebaut), no profit (Asana, Take-Two, Corsair), corrupt book (Berkshire), trough (Swatch).
- **Rest overvalued / significantly-overvalued**, mostly on the no-growth anchor.
- **Growth changes the verdict in exactly one case: Meta** (sig-overvalued @0% → fair @15% cap) → Tier 2, assumption-sensitive → **BUY prohibited**.
- **Verified:** no BUY depends on an aggressive/cap-bound growth assumption.

Review report (before/after, all columns): `https://claude.ai/code/artifact/3fa0d1a8-09ad-4af0-b8f5-63bd9b365236`

---

## TODO — tomorrow

### Area 4 — Buy-gate + separated concepts + frontend (NOT started)
1. **Buy-gate (backend `verdict.py` / `screener.py`):** a BUY/attractive verdict must require `reliableValue == true` AND `reliabilityTier == 1` AND `band == "undervalued"` (a genuine margin of safety) AND acceptable confidence. `assumptionSensitive` / tier 2 → never a buy. `discover_attractiveness` (currently `0.40·val + 0.30·quality + 0.20·return + 0.10·fit`) must not rate a *fair* quality name attractive — gate on real MoS.
2. **Separate the three concepts in the UI:** intrinsic value · confidence · margin of safety, never merged into one "Fair". Show the **no-growth anchor**, the growth assumption + basis + reason, cap-sensitivity, and "**Not a conservative buy**" for tier-2/cap-sensitive names (e.g. Meta panel: Value / Price / MoS 0% / Confidence low / Growth-sensitive / Decision: No).
3. **Render `NO RELIABLE FAIR VALUE`** on every surface (position page, screener, decisions, the price-vs-fair chart) — the chart must not draw a fair-value/zone line when `reliableValue == false`. Frontend must reflect the engine's decision, contain no valuation logic of its own.
4. **Book/NAV display:** label "below NAV / near NAV" (not green "undervalued"); surface the leverage/asset-mark caveat; never auto-buy below NAV.
5. Frontend fields now available from `value_analysis`: `valuationFramework`, `reliableValue`, `reliabilityReason`, `reliabilityTier`, `earningPower`, `noGrowthValue`, `growthAssumption`, `growthBasis`, `assumptionSensitive`, `bookNav`. (Old `scenarios`/`valuationRange` are now `null` for the earnings framework — replace that UI section with the sensitivity/no-growth display.)

### Then
- Full frontend `tsc` + `vite build`; visual check (run the app, screenshot SRAIL/SNY/META/VNA value analysis).
- Final diff review of the whole branch.
- **Only then commit** (branch off main already done; end commit messages with the required Co-Authored-By/Claude-Session trailers; PR body with the Generated-with trailer).

### Possible follow-up (not required)
- Cross-listing FX refinement: for non-ADR foreign listings (Novartis CHF/USD, Constellation CAD/USD) a single current-FX conversion of the final fair value could replace abstention; true ADRs (SNY) also need the ADR ratio. Currently we abstain (conservative) — revisit only if desired.

---

## How to run
```bash
# backend tests
cd backend && uv run pytest -q          # 169 pass; 3 pre-existing market_analysis_bundle fails are expected

# real engine on the 25 holdings (ad-hoc)
export DG_DB_PATH="$(pwd)/data/decisionguru.sqlite"
uv run python   # then call app.services.valuation.value_analysis(symbol, price, currency, data=<cached fundamentals>)
```
Cached fundamentals live in `backend/data/decisionguru.sqlite` (`fundamentals_cache`, `price_cache`, `instruments`). The 25 holdings are `SELECT symbol FROM instruments WHERE kind='stock'`.

## Key files
- `backend/app/services/valuation.py` — Areas 1–3 wired (routing, abstention, earning-power integration, output fields).
- `backend/app/services/earning_power.py` — Area 3 engine (new).
- `backend/tests/test_earning_power.py`, `test_valuation_area3.py`, `test_valuation_routing.py`, `test_valuation_price_independence.py` — new tests.
- Review artifacts: methodology + gates `https://claude.ai/code/artifact/e807fe0c-2748-4546-900d-a10bdf63556f` · methodology audit `https://claude.ai/code/artifact/1c3f6ce7-25f2-42b9-bb42-ec4b9373fe6a` · implementation tracker `https://claude.ai/code/artifact/9af1dc8c-3a6d-4231-bcc7-cf2a75eb84b6`.

**Nothing is committed. Preserve Areas 1–3. Resume at Area 4.**
