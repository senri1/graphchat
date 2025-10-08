export type Role = "user" | "assistant" | "note";
export type NodeStatus = "draft" | "sending" | "done" | "error";

export interface ChatNode {
  id: string;
  chatId: string;
  role: Role;
  parentId?: string;
  children: string[];
  text: string;
  createdAt: string;
  updatedAt: string;
  status: NodeStatus;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface ChatTreeMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  viewport: ViewportState;
  theme: "dark" | "light" | "system";
  version: number;
}

export interface Chat {
  meta: ChatTreeMeta;
  nodes: Record<string, ChatNode>;
}

export interface SelectionState {
  nodeIds: string[];
  edge?: { parentId: string; childId: string };
}

export interface UIState {
  sidebarCollapsed: boolean;
  gridSnap: boolean;
  dragging: boolean;
  editingNodeId?: string;
}

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

export interface AppState {
  chats: Record<string, Chat>;
  chatOrder: string[];
  activeChatId?: string;
  selection: SelectionState;
  ui: UIState;
}

export interface StoreState {
  history: HistoryState<AppState>;
  actions: StoreActions;
}

export interface StoreActions {
  setActiveChat: (chatId: string) => void;
  createChat: () => string;
  renameChat: (chatId: string, title: string) => void;
  deleteChat: (chatId: string) => void;
  createNode: (options: {
    chatId: string;
    parentId?: string;
    role?: Role;
    x: number;
    y: number;
    autoFocus?: boolean;
  }) => string;
  updateNodeText: (nodeId: string, text: string) => void;
  setNodeStatus: (nodeId: string, status: NodeStatus) => void;
  moveNodes: (nodeIds: string[], dx: number, dy: number) => void;
  setNodePosition: (nodeId: string, x: number, y: number) => void;
  resizeNode: (nodeId: string, width: number, height: number) => void;
  reparentNode: (nodeId: string, parentId?: string, index?: number) => void;
  deleteNode: (nodeId: string, mode: "subtree" | "promoteChildren") => void;
  deleteEdge: (parentId: string, childId: string) => void;
  selectNodes: (nodeIds: string[]) => void;
  selectEdge: (parentId: string, childId: string) => void;
  clearSelection: () => void;
  setViewport: (chatId: string, viewport: ViewportState) => void;
  toggleSidebar: () => void;
  toggleGridSnap: () => void;
  setEditingNode: (nodeId?: string) => void;
  undo: () => void;
  redo: () => void;
  importData: (state: AppState) => void;
}

export interface SerializedState {
  schemaVersion: number;
  chats: Record<string, Chat>;
  chatOrder: string[];
  activeChatId?: string;
}
