# GraphChatV1

GraphChatV1 is a UI for visualizing branching conversations and context.

## Quickest way to start using it (pre-release)

1. Go to **Releases** on the right side of the repo page.
2. Download the installer for your OS:
   - Windows: `.exe`
   - macOS: `.dmg`
3. Install and open GraphChatV1.

Note: pre-release installers are currently unsigned, so your OS may show a security prompt.

## Running in browser (useful for phone/tablet testing)

### Prerequisite software

- A modern browser (Chrome, Edge, Safari)
- `npm` (only if you want to run the browser build locally from source)
- Provider API key(s) for AI features (BYO keys)

### Start in browser (local dev)

```bash
cd graphchatv1
npm install
npm run dev
```

Then open the local URL shown in the terminal (typically `http://localhost:5173`).

### Browser mode notes

- GraphChat calls provider APIs from the browser (BYO API key).
- Anthropic browser requests require `anthropic-dangerous-direct-browser-access: true` (GraphChat sets this automatically).
- Optional proxy for local dev: Vite can proxy `/api/openai/v1/*` and `/api/anthropic/v1/*` in `npm run dev` / `npm run preview`.
  - Set `VITE_OPENAI_API_BASE_URL=/api/openai/v1` and/or `VITE_ANTHROPIC_API_BASE_URL=/api/anthropic/v1` in `.env.local`.
- Local LaTeX compile with `latexmk` is a desktop feature.

## Running in desktop / standalone mode

### Prerequisite software

- For installer use (`.dmg` / `.exe`): no `npm` required.
- For desktop run from source: Node.js + `npm`.
- For local LaTeX compile in LaTeX nodes: TeX toolchain with both `latexmk` and `synctex` available on `PATH`.
  - macOS: MacTeX
  - Windows: MiKTeX or TeX Live

At startup in desktop mode, GraphChat checks for `latexmk` and `synctex` and shows guidance if missing.

### Start in desktop mode (from installer)

1. Download `.dmg` (macOS) or `.exe` (Windows) from **Releases**.
2. Install and launch GraphChatV1.

### Start in desktop mode (from source)

```bash
cd graphchatv1
npm install
npm run dev
# in a second terminal:
npm run electron:dev
```

In desktop mode, LaTeX nodes use local compilation via Electron IPC + `latexmk` and render PDF in the node editor.

## First things to try

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

### Verify Markdown/LaTeX in a text node

- Double-click a text node (or press `Enter`) to edit.
- Type Markdown plus math delimiters:
  - Inline: `\(e^{i\pi}+1=0\)`
  - Display: `\[\int_0^1 x^2 dx = \frac{1}{3}\]`

## API keys

For local dev, create `graphchatv1/.env.local`:

```bash
OPENAI_API_KEY=...
GEMINI_API_KEY=...
XAI_API_KEY=...
ANTHROPIC_API_KEY=...
```

In desktop mode you can also set provider keys in-app:

- `Settings -> Models -> API keys`
- Keys saved there override `.env.local` values

## Desktop data location

In desktop mode, open `Settings -> Data -> Storage location` to:

- Choose a custom location for GraphChat-managed data (workspace/chats/attachments/payloads)
- Optionally move existing data when switching location
- Reset back to the default location

## Build installers

```bash
cd graphchatv1
npm install
npm run dist:mac   # builds .dmg on macOS
npm run dist:win   # builds NSIS .exe installer
# optional: remove old artifacts first
npm run dist:mac:fresh
npm run dist:win:fresh
# verify packaged artifacts before sharing
npm run release:verify
# copy only publishable installers to release/public
npm run release:collect
```

Artifacts are written to `release/`.

Notes:

- These builds are unsigned by default (good for local testing, not public distribution)
- Packaging requires network access on first run so `electron-builder` can fetch Electron binaries
- `release:verify` scans `dist/` + `release/` for secret-like tokens and local absolute paths
- `release:collect` stages only `.dmg` / `.exe` installers into `release/public`

