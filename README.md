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

## Code map

- `graphchatv1/src/engine/WorldEngine.ts`: render loop + camera + input wiring
- `graphchatv1/src/engine/Camera.ts`: world↔screen transforms
- `graphchatv1/src/engine/InputController.ts`: Pointer Events + wheel → camera updates

