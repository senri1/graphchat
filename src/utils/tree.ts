import type { ChatNode } from "../state/types";

export function isDescendant(nodes: Record<string, ChatNode>, ancestorId: string, nodeId: string): boolean {
  const visited = new Set<string>();
  const stack: string[] = [ancestorId];
  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    if (currentId === nodeId) return true;
    const node = nodes[currentId];
    if (node) {
      stack.push(...node.children);
    }
  }
  return false;
}

export function getAncestors(nodes: Record<string, ChatNode>, nodeId: string): ChatNode[] {
  const path: ChatNode[] = [];
  let current = nodes[nodeId];
  while (current) {
    path.push(current);
    if (!current.parentId) break;
    current = nodes[current.parentId];
  }
  return path;
}

export function getRoots(nodes: Record<string, ChatNode>): ChatNode[] {
  return Object.values(nodes).filter((node) => !node.parentId);
}
