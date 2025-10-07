import { useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useActions, useAppState } from "../../state/store";

export function useKeyboardShortcuts() {
  const actions = useActions();
  const state = useAppState();
  const selection = state.selection;
  const activeChat = state.activeChatId ? state.chats[state.activeChatId] : undefined;

  useHotkeys(
    ["ctrl+z", "meta+z"],
    (event) => {
      event.preventDefault();
      actions.undo();
    },
    [actions]
  );

  useHotkeys(
    ["ctrl+shift+z", "meta+shift+z", "ctrl+y", "meta+y"],
    (event) => {
      event.preventDefault();
      actions.redo();
    },
    [actions]
  );

  useHotkeys(
    "delete",
    () => {
      if (selection.edge) {
        actions.deleteEdge(selection.edge.parentId, selection.edge.childId);
      } else if (selection.nodeIds.length) {
        actions.deleteNode(selection.nodeIds[0], "subtree");
      }
    },
    [actions, selection]
  );

  useHotkeys(
    ["ctrl+d", "meta+d"],
    (event) => {
      if (!activeChat || !selection.nodeIds.length) return;
      event.preventDefault();
      const created: string[] = [];
      selection.nodeIds.forEach((id) => {
        const node = activeChat.nodes[id];
        if (!node) return;
        const newId = actions.createNode({
          chatId: activeChat.meta.id,
          parentId: node.parentId,
          role: node.role,
          x: node.x + 40,
          y: node.y + 40,
          autoFocus: false
        });
        actions.resizeNode(newId, node.width, node.height);
        actions.updateNodeText(newId, node.text);
        actions.setNodeStatus(newId, node.status);
        created.push(newId);
      });
      if (created.length) {
        actions.selectNodes(created);
      }
    },
    [actions, activeChat, selection.nodeIds]
  );

  useHotkeys(
    "esc",
    () => {
      actions.clearSelection();
      actions.setEditingNode(undefined);
    },
    [actions]
  );

  useHotkeys(
    ["up", "down", "left", "right"],
    (event, handler) => {
      if (!selection.nodeIds.length || !activeChat) return;
      const delta = event.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      switch (handler.keys?.join("+")) {
        case "up":
          dy = -delta;
          break;
        case "down":
          dy = delta;
          break;
        case "left":
          dx = -delta;
          break;
        case "right":
          dx = delta;
          break;
        default:
          break;
      }
      if (dx !== 0 || dy !== 0) {
        event.preventDefault();
        actions.moveNodes(selection.nodeIds, dx, dy);
      }
    },
    [actions, activeChat, selection.nodeIds]
  );

  useHotkeys(
    "n",
    (event) => {
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      event.preventDefault();
      const chatId = state.activeChatId;
      if (!chatId) return;
      const viewport = state.chats[chatId].meta.viewport;
      actions.createNode({
        chatId,
        x: viewport.x,
        y: viewport.y,
        role: "user"
      });
    },
    [actions, state]
  );

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const toast = document.createElement("div");
        toast.textContent = "State saved";
        toast.className =
          "fixed bottom-6 right-6 rounded-md bg-slate-900 px-4 py-2 text-sm text-slate-200 shadow-lg";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1200);
      }
    };
    document.addEventListener("keydown", handleSave);
    return () => document.removeEventListener("keydown", handleSave);
  }, []);
}
