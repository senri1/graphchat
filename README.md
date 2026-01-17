# GraphChatV1 (web-first)

This is the start of a performance-first rewrite: an imperative world engine renders to a single `<canvas>`, while React is used only for lightweight UI overlays.

## Run

```bash
cd graphchatv1
npm install
npm run dev
```

## Controls (current skeleton)

- Drag to pan
- Pinch (touch) to zoom
- Trackpad pinch (Chrome/Edge): `ctrl` + wheel

## Verify Markdown/LaTeX (current text node)

- On load, an editor panel opens for the sample text node.
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
