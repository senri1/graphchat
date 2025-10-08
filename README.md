# Branch · Tree Chat Frontend

A single-page React + TypeScript application that implements the Branch conversation canvas described in the Tree-Chat Frontend Spec. The app lets you create and manage multiple chats, each rendered as a forest of draggable, resizable nodes on an infinite canvas with pan/zoom, linking, import/export, and undo/redo.

## Getting Started

```bash
pnpm install
pnpm dev
```

Visit http://localhost:5173 to interact with the app.

## Scripts

- `pnpm dev` – start Vite dev server.
- `pnpm build` – build production bundle.
- `pnpm preview` – preview production build.
- `pnpm lint` – run ESLint with the provided config.
- `pnpm test` – execute unit tests with Vitest (placeholder; add tests in `src/__tests__`).

## Key Features

- Collapsible sidebar listing chats with search, creation, and deletion controls.
- Infinite canvas with dotted grid background, smooth pan/zoom, and viewport controls.
- Node cards for user, assistant, and note roles with inline editing, resizing, and status badges.
- Drag-and-drop linking and branching, active-path highlighting, and tree invariant enforcement.
- LocalStorage persistence with schema versioning, import/export helpers, and undo/redo history.

Refer to the source in `src/` for additional details on the state model and UI components.
