# Slice 3 — Branding + responsive

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`). No automated tests — verify with `npm run build --workspace frontend` and by resizing the running app (owner tests).

**Goal:** Give DecisionGuru a real favicon/app icon and make the app usable on mobile — a burger-drawer sidebar and a responsive pass so nothing overflows the viewport.

**Architecture:** Generate raster icons with a committed PIL script (no SVG rasterizer available) into `frontend/public/`, plus a hand-authored `favicon.svg` and a web manifest, wired into `index.html`. Convert the fixed desktop sidebar into an off-canvas drawer below the `lg` breakpoint, driven by a small store flag, with a mobile top bar, a backdrop, and body-scroll-lock. Then a targeted responsive pass (wide tables scroll in their own container, filter bars wrap, content padding scales).

**Tech Stack:** Vite static `public/`, PIL (backend venv) for raster generation, React + Tailwind. Dark mode only.

## Global Constraints
- Tailwind only; dark mode only; modals not page redirects; Conventional Commits.
- No automated tests. Verify: frontend build clean + manual resize. Icon must read at 16px and use the brand palette (azure `#4EA1FF`, gold `#E5B769`, ground `#0A0E15`).
- Commit trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_012qvEytzsTQKRG9fzDezv6X`.

---

## Task 1: Brand icon + favicon assets

**Files:**
- Create: `frontend/public/favicon.svg`, `frontend/public/favicon.ico`, `frontend/public/apple-touch-icon.png`, `frontend/public/icon-192.png`, `frontend/public/icon-512.png`, `frontend/public/icon-512-maskable.png`, `frontend/public/site.webmanifest`
- Create: `scripts/make_icons.py` (committed generator, reproducible)
- Modify: `frontend/index.html` (`<head>` links)

**Interfaces:** static assets only.

- [ ] **Step 1: Write `scripts/make_icons.py`**

Draws the mark — a dark rounded tile with an ascending azure "value" line and a gold peak node (the app's actual-vs-counterfactual motif, legible small) — and exports every raster size + a multi-size `.ico`.
```python
"""Generate DecisionGuru brand icons with PIL (no SVG rasterizer in this env).
Run: cd backend && uv run python ../scripts/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public"
OUT.mkdir(parents=True, exist_ok=True)

GROUND = (10, 14, 21, 255)     # #0A0E15
TILE = (17, 23, 37, 255)       # #111725
AZURE = (78, 161, 255, 255)    # #4EA1FF
GOLD = (229, 183, 105, 255)    # #E5B769


def draw(size: int, maskable: bool = False) -> Image.Image:
    S = size * 4  # supersample
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 0 if maskable else int(S * 0.06)
    radius = int(S * (0.22 if not maskable else 0.0))
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=TILE)
    # ascending value line (azure), zig up to a gold peak node
    m = S * 0.20
    pts = [(m, S - m), (S * 0.42, S * 0.56), (S * 0.60, S * 0.66), (S - m, m)]
    d.line(pts, fill=AZURE, width=max(2, int(S * 0.055)), joint="curve")
    # gold counterfactual baseline (faint dashed feel via short segments)
    y = S - m
    x = m
    while x < S - m:
        d.line([(x, y), (min(x + S * 0.06, S - m), y)], fill=GOLD, width=max(1, int(S * 0.02)))
        x += S * 0.11
    # gold peak node
    r = S * 0.055
    px, py = S - m, m
    d.ellipse([px - r, py - r, px + r, py + r], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    draw(180).save(OUT / "apple-touch-icon.png")
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    draw(512, maskable=True).save(OUT / "icon-512-maskable.png")
    ico = draw(256)
    ico.save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the generator**
```bash
cd /home/neuadmin/Documents/DecitionGuru/backend && uv run python ../scripts/make_icons.py
```
Expected: `icons written to .../frontend/public`; the 6 raster files exist.

- [ ] **Step 3: Hand-author `frontend/public/favicon.svg`**
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#111725"/>
  <g stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M13 51 H51" stroke="#E5B769" stroke-width="2.4" stroke-dasharray="4 4"/>
    <path d="M13 51 L27 36 L39 42 L51 15" stroke="#4EA1FF" stroke-width="4.2"/>
  </g>
  <circle cx="51" cy="15" r="4.2" fill="#E5B769"/>
</svg>
```

- [ ] **Step 4: `frontend/public/site.webmanifest`**
```json
{
  "name": "DecisionGuru",
  "short_name": "DecisionGuru",
  "description": "Swiss tax-aware investment counterfactual analyzer",
  "theme_color": "#0A0E15",
  "background_color": "#0A0E15",
  "display": "standalone",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 5: Wire into `index.html` `<head>`**
```html
    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#0A0E15" />
```

- [ ] **Step 6: Build + commit**
```bash
npm run build --workspace frontend   # expect: dist/ contains the public assets
git add scripts/make_icons.py frontend/public frontend/index.html
git commit -m "feat(branding): DecisionGuru app icon + favicon/manifest assets"
```

---

## Task 2: Mobile burger navigation

**Files:**
- Modify: `frontend/src/store.ts` (add `navOpen` + setters)
- Modify: `frontend/src/App.tsx` (mobile top bar + drawer wrapper + backdrop)
- Modify: `frontend/src/components/Sidebar.tsx` (responsive classes + close-on-navigate)

**Interfaces:**
- Produces: store `navOpen: boolean`, `setNavOpen(v)`.

- [ ] **Step 1: Store flag**

In `store.ts` `AppState`, add `navOpen: boolean;` and `setNavOpen: (v: boolean) => void;`. In the creator, add `navOpen: false,` and `setNavOpen: (navOpen) => set({ navOpen }),`.

- [ ] **Step 2: Sidebar becomes drawer-aware**

Change the `<aside>` className to be static at `lg+` and an off-canvas fixed drawer below it, driven by `navOpen`, and close the drawer whenever a destination is chosen. Read `navOpen`/`setNavOpen` from the store:
```tsx
  const { view, setView, openModal, navOpen, setNavOpen } = useApp();
  const go = (fn: () => void) => { fn(); setNavOpen(false); };
```
`<aside>` className:
```tsx
    <aside className={clsx(
      'w-60 shrink-0 bg-bg-elev border-r border-hairline flex flex-col h-full z-40',
      'fixed inset-y-0 left-0 transition-transform lg:static lg:translate-x-0',
      navOpen ? 'translate-x-0' : '-translate-x-full',
    )}>
```
Wrap the nav/action handlers with `go(...)`: `onClick={() => go(() => setView(n.view))}`, the bell `go(() => setView('alerts'))`, Comparison/Import/Add/Settings `go(() => openModal({...}))`.

- [ ] **Step 3: App shell — top bar + backdrop**

In `App.tsx`, read `navOpen`/`setNavOpen`, lock body scroll when open, and render a mobile header + backdrop:
```tsx
  const navOpen = useApp((s) => s.navOpen);
  const setNavOpen = useApp((s) => s.setNavOpen);
  useEffect(() => {
    document.body.style.overflow = navOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [navOpen]);
```
Layout:
```tsx
  return (
    <div className="flex h-full bg-bg text-text">
      <Sidebar />
      {navOpen && (
        <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setNavOpen(false)} aria-hidden />
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden flex items-center gap-3 px-4 h-14 border-b border-hairline bg-bg-elev">
          <button className="p-1.5 -ml-1.5 text-text-muted hover:text-text" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
            <Menu size={20} />
          </button>
          <span className="font-display text-base font-semibold">Decision<span className="text-azure">Guru</span></span>
        </header>
        <main className="flex-1 overflow-y-auto">
          {/* ...existing view switch unchanged... */}
        </main>
      </div>
      <ModalHost />
    </div>
  );
```
Import `Menu` from `lucide-react`.

- [ ] **Step 4: Build + commit**
```bash
npm run build --workspace frontend
git add frontend/src/store.ts frontend/src/App.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(nav): mobile burger drawer for the sidebar with backdrop + scroll lock"
```

---

## Task 3: Responsive polish

**Files:**
- Modify: `frontend/src/index.css` (guard against horizontal body scroll)
- Modify: wide tables in `frontend/src/views/Dashboard.tsx`, `Screener.tsx`, `Watchlist.tsx` (wrap in an `overflow-x-auto` container if not already)

**Interfaces:** none.

- [ ] **Step 1: Prevent page-level horizontal scroll**

In `index.css` (global layer), ensure:
```css
html, body, #root { height: 100%; }
body { overflow-x: hidden; }
```
(Add only what's missing — do not duplicate existing rules.)

- [ ] **Step 2: Wrap wide tables**

For each of Dashboard / Screener / Watchlist, confirm the main `<table>` sits inside a container with `overflow-x-auto`. If a table is a direct child of a padded section, wrap it:
```tsx
<div className="overflow-x-auto -mx-2 px-2">
  <table className="...">...</table>
</div>
```
Only change tables that currently overflow; leave already-wrapped ones.

- [ ] **Step 3: Build + commit**
```bash
npm run build --workspace frontend
git add frontend/src/index.css frontend/src/views/Dashboard.tsx frontend/src/views/Screener.tsx frontend/src/views/Watchlist.tsx
git commit -m "fix(responsive): no page-level horizontal scroll; wide tables scroll in-container"
```

---

## Self-review notes
- **Coverage:** favicon/app icon (§23), mobile burger nav (§25), responsive tables + no-overflow (§24, §27). Charts already use responsive containers (recharts `ResponsiveContainer`); filter drawers on mobile are a further polish noted for follow-up if the owner wants it.
- **No SVG rasterizer** in env → icons drawn with PIL; `favicon.svg` hand-authored for crisp scaling; both share the exact brand palette.
- **Dark-only preserved** (tile + palette are dark).
- **Accessibility:** burger has `aria-label`; backdrop click + drawer close on navigate; body scroll locked while open.
