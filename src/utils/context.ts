import type { Chat, ChatNode } from "../state/types";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export function pathMessages(chat: Chat, upToNodeId: string): Message[] {
  const nodes = chat.nodes;
  const path: ChatNode[] = [];
  let current = nodes[upToNodeId];
  while (current) {
    path.push(current);
    if (!current.parentId) break;
    current = nodes[current.parentId];
  }
  return path
    .reverse()
    .filter((node) => node.role === "user" || node.role === "assistant")
    .map((node) => ({ role: node.role as Message["role"], content: node.text }));
}
