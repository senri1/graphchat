import type { AppState } from "../state/types";

const DOWNLOAD_NAME = "branch-export.branch.json";
const SCHEMA_VERSION = 1;

export function exportChats(state: AppState) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    chats: state.chats,
    chatOrder: state.chatOrder,
    activeChatId: state.activeChatId
  } satisfies AppState & { schemaVersion: number };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = DOWNLOAD_NAME;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importChats(callback: (state: AppState) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.branch.json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const json = JSON.parse(text);
    if (json.schemaVersion !== SCHEMA_VERSION) {
      console.warn("Unsupported schema version", json.schemaVersion);
    }
    callback({
      chats: json.chats ?? {},
      chatOrder: json.chatOrder ?? [],
      activeChatId: json.activeChatId,
      selection: { nodeIds: [] },
      ui: {
        sidebarCollapsed: false,
        gridSnap: true,
        dragging: false,
        editingNodeId: undefined
      }
    });
  };
  input.click();
}
