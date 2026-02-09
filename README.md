# GraphChatV1 (web-first)

This is the start of a performance-first rewrite: an imperative world engine renders to a single `<canvas>`, while React is used only for lightweight UI overlays.

## Run

```bash
cd graphchatv1
npm install
npm run dev
```

## Run (desktop / standalone with local LaTeX compile)

Requirements:
- Install a TeX toolchain with `latexmk` available on `PATH` (for macOS this is typically MacTeX).

Then run:

```bash
cd graphchatv1
npm install
npm run dev
# in a second terminal:
npm run electron:dev
```

In desktop mode, LaTeX nodes use local compilation via Electron IPC + `latexmk` and render PDF in the node editor.

## Build installers (Electron)

```bash
cd graphchatv1
npm install
npm run dist:mac   # builds .dmg on macOS
npm run dist:win   # builds NSIS .exe installer
```

Artifacts are written to `release/`.

Notes:
- These builds are unsigned by default (good for local testing, not public distribution).
- Packaging requires network access on first run so `electron-builder` can fetch Electron binaries.

## Desktop data location

In desktop mode, open `Settings -> Data -> Storage location` to:
- Choose a custom location for GraphChat-managed data (workspace/chats/attachments/payloads).
- Optionally move existing data when switching location.
- Reset back to the default location.

## OpenAI (local dev)

Create `graphchatv1/.env.local`:

```bash
OPENAI_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

### Provider API access (browser vs proxy)

GraphChat calls provider APIs from the browser (BYO API key).

- Anthropic requires the `anthropic-dangerous-direct-browser-access: true` header for CORS browser requests (GraphChat sets this automatically).
- Optional proxy: Vite can proxy `/api/openai/v1/*` and `/api/anthropic/v1/*` in `npm run dev` / `npm run preview`. To use it, set `VITE_OPENAI_API_BASE_URL=/api/openai/v1` and/or `VITE_ANTHROPIC_API_BASE_URL=/api/anthropic/v1` in `.env.local`.

## Controls (current skeleton)

- Drag to pan
- Pinch (touch) to zoom
- Trackpad pinch (Chrome/Edge): `ctrl` + wheel
- Tool: `Select` / `Draw` (pen always draws)
- Move node: drag a node
- Resize node: drag a corner handle
- Edit node: double-click / `Enter` (commit with click-outside / Done, cancel with `Esc`)
- Import PDF: click `Import PDF` (creates a new PDF node)
- New LaTeX node: click `+LaTeX`, write `.tex` on the left, click `Compile`, and preview PDF on the right
- Ink: draw on the canvas (world ink) or inside an ink node; `New Ink Node` creates another; `Clear Ink` clears world ink

## One-time import from graphchatgem

1) In `graphchatgem`, export/download your chat(s) to a `*.graphchat.json` file.

2) Convert it to a graphchatv1 archive:

```bash
cd graphchatv1
node scripts/convert-graphchatgem-archive.js /path/to/export.graphchat.json
```

This writes a sibling `*.graphchatv1.json` file (graphchatv1’s importer requires `format: "graphchatv1"`).

3) In `graphchatv1`, use the app’s Import to load the generated `*.graphchatv1.json`.

## Verify Markdown/LaTeX (current text node)

- Double-click the sample text node (or press `Enter`) to edit.
- Type Markdown plus math delimiters:
  - Inline: `\(e^{i\pi}+1=0\)`
  - Display: `\[\int_0^1 x^2 dx = \frac{1}{3}\]`

## Stress test (hundreds of nodes)

- Use the buttons under the HUD: `+50 nodes`, `+200 nodes`, `Reset`
- While panning/zooming, nodes may show a placeholder; after you stop, they re-raster and sharpen.

## Code map

- `graphchatv1/src/engine/WorldEngine.ts`: render loop + camera + input wiring
- `graphchatv1/src/engine/Camera.ts`: world↔screen transforms
- `graphchatv1/src/engine/InputController.ts`: Pointer Events + wheel → camera updates
- `graphchatv1/src/engine/raster/textRaster.ts`: Markdown/KaTeX → SVG `<foreignObject>` → `ImageBitmap`
- `graphchatv1/src/engine/pdf/pdfjs.ts`: pdf.js loader + worker setup
