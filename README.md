# graphchat
GraphChat is a prototype interface for exploring branching conversations with large language models. Each exchange is
visualised as a node in a tree so you can fork the discussion from any earlier point and compare outcomes side-by-side.

## Technology stack

- **Frontend:** React 18 with TypeScript, Vite, Tailwind CSS for utility-first styling, and React Flow (`@xyflow/react`)
  for the interactive conversation tree.
- **State management & data fetching:** React Query (`@tanstack/react-query`) – currently used for future backend
  integration.
- **Utilities:** `clsx` for conditional class names and `nanoid` for generating node IDs.

## Getting started

```bash
cd client
npm install
npm run dev
```

### Running on Windows

1. Install a recent [Node.js LTS build](https://nodejs.org/) for Windows. The installer includes `npm`.
2. Open **PowerShell** (or **Command Prompt**) and navigate to the project directory, for example:
   ```powershell
   cd path\to\graphchat\client
   ```
3. Restore dependencies and start the development server:
   ```powershell
   npm install
   npm run dev
   ```
4. Visit the printed local URL (typically `http://localhost:5173`) in your browser. Vite automatically reloads when you
   save changes.

The development server listens on port `5173` by default. Use a modern desktop or mobile browser to pan, zoom, and branch
the conversation tree. If you are working in an offline or firewalled environment, installing dependencies from npm may
require additional configuration.
