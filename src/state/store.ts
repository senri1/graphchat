import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import { produce } from "immer";
import type {
  AppState,
  Chat,
  ChatNode,
  StoreActions,
  StoreState,
  ViewportState
} from "./types";
import { clamp } from "../utils/math";
import { isDescendant } from "../utils/tree";

const SCHEMA_VERSION = 1;
const STORAGE_KEY = "branch.v1";
const STORAGE_TEST_KEY = "__branch_storage_test__";

const fallbackStorage = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    }
  } satisfies Storage;
})();

function resolveStorage(): Storage {
  if (typeof window === "undefined") {
    return fallbackStorage;
  }
  try {
    window.localStorage.setItem(STORAGE_TEST_KEY, "1");
    window.localStorage.removeItem(STORAGE_TEST_KEY);
    return window.localStorage;
  } catch (error) {
    console.warn(
      "Branch: falling back to in-memory storage because localStorage is unavailable.",
      error
    );
    return fallbackStorage;
  }
}

function isValidDate(value?: string) {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

const initialViewport: ViewportState = {
  x: 0,
  y: 0,
  zoom: 0.9
};

function createChatWithRoot() {
  const chat = createChatMeta();
  const rootNode = createNodeSkeleton({
    chatId: chat.meta.id,
    x: 240,
    y: 160,
    role: "user"
  });
  chat.nodes[rootNode.id] = rootNode;
  return { chat, rootId: rootNode.id };
}

const initialChat = createChatWithRoot();

const emptyState: AppState = {
  chats: { [initialChat.chat.meta.id]: initialChat.chat },
  chatOrder: [initialChat.chat.meta.id],
  activeChatId: initialChat.chat.meta.id,
  selection: { nodeIds: [initialChat.rootId] },
  ui: {
    sidebarCollapsed: false,
    gridSnap: true,
    dragging: false,
    editingNodeId: initialChat.rootId
  }
};

const bootState = sanitizeAppState(emptyState);

function createChatMeta(): Chat {
  const id = nanoid();
  const now = new Date().toISOString();
  return {
    meta: {
      id,
      title: "Untitled chat",
      createdAt: now,
      updatedAt: now,
      viewport: { ...initialViewport },
      theme: "dark",
      version: SCHEMA_VERSION
    },
    nodes: {}
  };
}

function pushHistory(state: StoreState, next: AppState): StoreState {
  const maxHistory = 100;
  const past = state.history.past.slice(-maxHistory + 1);
  return {
    ...state,
    history: {
      past: [...past, state.history.present],
      present: next,
      future: []
    }
  };
}

function applyUpdate(state: StoreState, recipe: (draft: AppState) => void): StoreState {
  const next = produce(state.history.present, (draft) => {
    recipe(draft);
    draft.selection.edge = undefined;
  });
  return pushHistory(state, next);
}

function ensureChat(state: AppState, chatId: string): Chat {
  const chat = state.chats[chatId];
  if (!chat) {
    throw new Error(`Chat ${chatId} not found`);
  }
  return chat;
}

function createNodeSkeleton(params: {
  chatId: string;
  parentId?: string;
  role?: ChatNode["role"];
  x: number;
  y: number;
}): ChatNode {
  const id = nanoid();
  const now = new Date().toISOString();
  return {
    id,
    chatId: params.chatId,
    role: params.role ?? (params.parentId ? "assistant" : "user"),
    parentId: params.parentId,
    children: [],
    text: "",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    x: params.x,
    y: params.y,
    width: 280,
    height: 160
  };
}

function sanitizeAppState(state: AppState): AppState {
  return produce(state, (draft) => {
    if (!draft.ui) {
      draft.ui = {
        sidebarCollapsed: false,
        gridSnap: true,
        dragging: false,
        editingNodeId: undefined
      };
    }

    draft.ui.sidebarCollapsed = Boolean(draft.ui.sidebarCollapsed);
    draft.ui.gridSnap = draft.ui.gridSnap ?? true;
    draft.ui.dragging = false;

    const filteredOrder = draft.chatOrder.filter((id) => draft.chats[id]);
    draft.chatOrder = filteredOrder;

    for (const id of Object.keys(draft.chats)) {
      if (!draft.chatOrder.includes(id)) {
        draft.chatOrder.push(id);
      }
    }

    if (!draft.chatOrder.length) {
      const { chat, rootId } = createChatWithRoot();
      draft.chats = { [chat.meta.id]: chat };
      draft.chatOrder = [chat.meta.id];
      draft.activeChatId = chat.meta.id;
      draft.selection = { nodeIds: [rootId] };
      draft.ui.editingNodeId = rootId;
      draft.ui.sidebarCollapsed = false;
      draft.ui.gridSnap = true;
      draft.selection.edge = undefined;
      return;
    }

    if (!draft.activeChatId || !draft.chats[draft.activeChatId]) {
      draft.activeChatId = draft.chatOrder[0];
    }

    const nowIso = new Date().toISOString();

    for (const chatId of draft.chatOrder) {
      const chat = draft.chats[chatId];
      if (!chat) continue;

      if (!chat.meta.title) {
        chat.meta.title = "Untitled chat";
      }

      if (!isValidDate(chat.meta.createdAt)) {
        chat.meta.createdAt = nowIso;
      }
      if (!isValidDate(chat.meta.updatedAt)) {
        chat.meta.updatedAt = chat.meta.createdAt;
      }

      chat.meta.viewport = chat.meta.viewport ?? { ...initialViewport };
      if (!Number.isFinite(chat.meta.viewport.x)) chat.meta.viewport.x = 0;
      if (!Number.isFinite(chat.meta.viewport.y)) chat.meta.viewport.y = 0;
      if (!Number.isFinite(chat.meta.viewport.zoom)) {
        chat.meta.viewport.zoom = initialViewport.zoom;
      } else {
        chat.meta.viewport.zoom = clamp(chat.meta.viewport.zoom, 0.25, 2);
      }

      let nodeIds = Object.keys(chat.nodes);
      if (!nodeIds.length) {
        const rootNode = createNodeSkeleton({
          chatId: chat.meta.id,
          x: 240,
          y: 160,
          role: "user"
        });
        chat.nodes[rootNode.id] = rootNode;
        nodeIds = [rootNode.id];
        chat.meta.updatedAt = rootNode.updatedAt;
      }

      for (const nodeId of nodeIds) {
        const node = chat.nodes[nodeId];
        if (!node) continue;
        if (!isValidDate(node.createdAt)) {
          node.createdAt = nowIso;
        }
        if (!isValidDate(node.updatedAt)) {
          node.updatedAt = node.createdAt;
        }
        if (!Number.isFinite(node.x)) node.x = 0;
        if (!Number.isFinite(node.y)) node.y = 0;
        node.width = clamp(node.width ?? 280, 180, 1200);
        node.height = clamp(node.height ?? 160, 80, 1000);
        if (node.parentId && !chat.nodes[node.parentId]) {
          node.parentId = undefined;
        }
      }

      for (const node of Object.values(chat.nodes)) {
        node.children = node.children.filter((childId) => chat.nodes[childId]);
      }
    }

    const activeChat = draft.activeChatId ? draft.chats[draft.activeChatId] : undefined;

    if (draft.selection.edge) {
      const { parentId, childId } = draft.selection.edge;
      if (!activeChat || !activeChat.nodes[parentId] || !activeChat.nodes[childId]) {
        draft.selection.edge = undefined;
      }
    }

    if (!draft.selection) {
      draft.selection = { nodeIds: [] };
    }

    const validSelection = activeChat
      ? Array.from(
          new Set(draft.selection.nodeIds.filter((id) => Boolean(activeChat.nodes[id])))
        )
      : [];

    if (validSelection.length) {
      draft.selection.nodeIds = validSelection;
    } else if (activeChat) {
      const firstNode = Object.keys(activeChat.nodes)[0];
      draft.selection = firstNode ? { nodeIds: [firstNode] } : { nodeIds: [] };
    } else {
      draft.selection = { nodeIds: [] };
    }

    if (draft.selection.nodeIds.length) {
      if (
        !draft.ui.editingNodeId ||
        !draft.selection.nodeIds.includes(draft.ui.editingNodeId)
      ) {
        draft.ui.editingNodeId = draft.selection.nodeIds[0];
      }
    } else {
      draft.ui.editingNodeId = undefined;
    }
  });
}

const useStore = create<StoreState>()(
  persist(
    (set, get) => {
      const actions: StoreActions = {
        setActiveChat: (chatId) => {
          set((state) =>
            produce(state, (draft) => {
              if (!draft.history.present.chats[chatId]) return;
              draft.history.present.activeChatId = chatId;
            })
          );
        },
        createChat: () => {
          const { chat, rootId } = createChatWithRoot();
          set((state) => {
            const next = produce(state.history.present, (draft) => {
              draft.chats[chat.meta.id] = chat;
              draft.chatOrder.unshift(chat.meta.id);
              draft.activeChatId = chat.meta.id;
              draft.selection = { nodeIds: [rootId] };
              draft.ui.editingNodeId = rootId;
            });
            return pushHistory(state, next);
          });
          return chat.meta.id;
        },
        renameChat: (chatId, title) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = ensureChat(draft, chatId);
              chat.meta.title = title || "Untitled chat";
              chat.meta.updatedAt = new Date().toISOString();
            })
          );
        },
        deleteChat: (chatId) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              if (!draft.chats[chatId]) return;
              delete draft.chats[chatId];
              draft.chatOrder = draft.chatOrder.filter((id) => id !== chatId);
              if (draft.activeChatId === chatId) {
                draft.activeChatId = draft.chatOrder[0];
              }
              draft.selection = { nodeIds: [] };
            })
          );
        },
        createNode: ({ chatId, parentId, role, x, y, autoFocus = true }) => {
          const node = createNodeSkeleton({ chatId, parentId, role, x, y });
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = ensureChat(draft, chatId);
              chat.nodes[node.id] = node;
              if (parentId) {
                const parent = chat.nodes[parentId];
                if (parent) {
                  parent.children.push(node.id);
                }
              }
              chat.meta.updatedAt = new Date().toISOString();
              if (autoFocus) {
                draft.selection = { nodeIds: [node.id] };
                draft.ui.editingNodeId = node.id;
              }
            })
          );
          return node.id;
        },
        updateNodeText: (nodeId, text) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              for (const chat of Object.values(draft.chats)) {
                const node = chat.nodes[nodeId];
                if (node) {
                  node.text = text;
                  node.updatedAt = new Date().toISOString();
                  chat.meta.updatedAt = node.updatedAt;
                  if (!chat.meta.title || chat.meta.title === "Untitled chat") {
                    chat.meta.title = text.slice(0, 60) || "Untitled chat";
                  }
                  break;
                }
              }
            })
          );
        },
        setNodeStatus: (nodeId, status) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              for (const chat of Object.values(draft.chats)) {
                const node = chat.nodes[nodeId];
                if (node) {
                  node.status = status;
                  node.updatedAt = new Date().toISOString();
                  break;
                }
              }
            })
          );
        },
        moveNodes: (nodeIds, dx, dy) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const activeChat = draft.activeChatId && draft.chats[draft.activeChatId];
              if (!activeChat) return;
              for (const id of nodeIds) {
                const node = activeChat.nodes[id];
                if (node) {
                  node.x += dx;
                  node.y += dy;
                }
              }
            })
          );
        },
        setNodePosition: (nodeId, x, y) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = draft.activeChatId && draft.chats[draft.activeChatId];
              if (!chat) return;
              const node = chat.nodes[nodeId];
              if (!node) return;
              node.x = x;
              node.y = y;
            })
          );
        },
        resizeNode: (nodeId, width, height) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = draft.activeChatId && draft.chats[draft.activeChatId];
              if (!chat) return;
              const node = chat.nodes[nodeId];
              if (!node) return;
              node.width = clamp(width, 180, 1200);
              node.height = clamp(height, 80, 1000);
            })
          );
        },
        reparentNode: (nodeId, parentId, index) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = draft.activeChatId && draft.chats[draft.activeChatId];
              if (!chat) return;
              const node = chat.nodes[nodeId];
              if (!node) return;
              if (parentId && isDescendant(chat.nodes, parentId, nodeId)) {
                return;
              }
              const oldParent = node.parentId ? chat.nodes[node.parentId] : undefined;
              if (oldParent) {
                oldParent.children = oldParent.children.filter((id) => id !== node.id);
              }
              if (!parentId) {
                node.parentId = undefined;
              } else {
                const newParent = chat.nodes[parentId];
                if (!newParent) return;
                node.parentId = parentId;
                if (index === undefined || index >= newParent.children.length) {
                  newParent.children.push(node.id);
                } else {
                  newParent.children.splice(index, 0, node.id);
                }
              }
            })
          );
        },
        deleteNode: (nodeId, mode) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = draft.activeChatId && draft.chats[draft.activeChatId];
              if (!chat) return;
              const node = chat.nodes[nodeId];
              if (!node) return;
              const removeSubtree = (id: string) => {
                const current = chat.nodes[id];
                if (!current) return;
                for (const childId of current.children) {
                  removeSubtree(childId);
                }
                delete chat.nodes[id];
              };
              const parent = node.parentId ? chat.nodes[node.parentId] : undefined;
              if (mode === "subtree") {
                removeSubtree(nodeId);
              } else if (parent) {
                const index = parent.children.indexOf(nodeId);
                parent.children.splice(index, 1);
                for (const childId of node.children) {
                  const child = chat.nodes[childId];
                  if (child) {
                    child.parentId = parent.id;
                    parent.children.splice(index, 0, childId);
                  }
                }
                delete chat.nodes[nodeId];
              } else {
                removeSubtree(nodeId);
              }
              draft.selection = { nodeIds: [] };
            })
          );
        },
        deleteEdge: (parentId, childId) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = draft.activeChatId && draft.chats[draft.activeChatId];
              if (!chat) return;
              const parent = chat.nodes[parentId];
              const child = chat.nodes[childId];
              if (!parent || !child) return;
              parent.children = parent.children.filter((id) => id !== childId);
              child.parentId = undefined;
              draft.selection = { nodeIds: [childId] };
            })
          );
        },
        selectNodes: (nodeIds) => {
          set((state) =>
            produce(state, (draft) => {
              draft.history.present.selection = { nodeIds };
            })
          );
        },
        selectEdge: (parentId, childId) => {
          set((state) =>
            produce(state, (draft) => {
              draft.history.present.selection = {
                nodeIds: [],
                edge: { parentId, childId }
              };
            })
          );
        },
        clearSelection: () => {
          set((state) =>
            produce(state, (draft) => {
              draft.history.present.selection = { nodeIds: [] };
            })
          );
        },
        setViewport: (chatId, viewport) => {
          set((state) =>
            applyUpdate(state, (draft) => {
              const chat = draft.chats[chatId];
              if (!chat) return;
              chat.meta.viewport = {
                x: viewport.x,
                y: viewport.y,
                zoom: clamp(viewport.zoom, 0.25, 2)
              };
            })
          );
        },
        toggleSidebar: () => {
          set((state) =>
            produce(state, (draft) => {
              draft.history.present.ui.sidebarCollapsed = !draft.history.present.ui.sidebarCollapsed;
            })
          );
        },
        toggleGridSnap: () => {
          set((state) =>
            produce(state, (draft) => {
              draft.history.present.ui.gridSnap = !draft.history.present.ui.gridSnap;
            })
          );
        },
        setEditingNode: (nodeId) => {
          set((state) =>
            produce(state, (draft) => {
              draft.history.present.ui.editingNodeId = nodeId;
            })
          );
        },
        undo: () => {
          set((state) => {
            if (!state.history.past.length) return state;
            const previous = state.history.past[state.history.past.length - 1];
            const past = state.history.past.slice(0, -1);
            const future = [state.history.present, ...state.history.future];
            return {
              ...state,
              history: { past, present: previous, future }
            };
          });
        },
        redo: () => {
          set((state) => {
            if (!state.history.future.length) return state;
            const [next, ...rest] = state.history.future;
            return {
              ...state,
              history: {
                past: [...state.history.past, state.history.present],
                present: next,
                future: rest
              }
            };
          });
        },
        importData: (appState) => {
          set((state) => pushHistory(state, sanitizeAppState(appState)));
        }
      };

      return {
        history: {
          past: [],
          present: bootState,
          future: []
        },
        actions
      };
    },
    {
      name: STORAGE_KEY,
      version: SCHEMA_VERSION,
      storage: createJSONStorage<StoreState>(() => resolveStorage()),
      partialize: (state) => ({
        history: {
          past: [],
          present: state.history.present,
          future: []
        }
      }),
      merge: (persistedState, currentState) => {
        if (!persistedState) return currentState;
        const parsed = persistedState as Partial<StoreState> & {
          chats?: AppState["chats"];
          chatOrder?: AppState["chatOrder"];
          activeChatId?: AppState["activeChatId"];
        };

        let present = parsed.history?.present;
        if (!present) {
          present = {
            chats: parsed.chats ?? {},
            chatOrder: parsed.chatOrder ?? [],
            activeChatId: parsed.activeChatId,
            selection: { nodeIds: [] },
            ui: {
              sidebarCollapsed: false,
              gridSnap: true,
              dragging: false,
              editingNodeId: undefined
            }
          };
        }

        const sanitized = sanitizeAppState(present);

        return {
          history: { past: [], present: sanitized, future: [] },
          actions: currentState.actions
        };
      }
    }
  )
);

export const useAppState = () => useStore((state) => state.history.present);
export const useActions = () => useStore((state) => state.actions);
export const useHistory = () => useStore((state) => state.history);

export default useStore;
