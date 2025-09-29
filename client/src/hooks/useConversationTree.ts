import { useCallback, useState } from 'react';
import { nanoid } from 'nanoid';
import type { ConversationNode, MessageRole } from '../lib/types';
import { mockNodes } from '../lib/mockData';

interface CreateNodeOptions {
  parentId: string | null;
  role: MessageRole;
  content: string;
}

export const useConversationTree = () => {
  const [nodes, setNodes] = useState<ConversationNode[]>(mockNodes);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node-2');

  const createNode = useCallback(({ parentId, role, content }: CreateNodeOptions) => {
    let newNode: ConversationNode | null = null;
    setNodes((prev) => {
      newNode = {
        id: nanoid(),
        parentId,
        role,
        content,
        createdAt: new Date().toISOString(),
        conversationId: prev[0]?.conversationId ?? 'conv-1'
      };
      return [...prev, newNode];
    });
    return newNode!;
  }, []);

  return {
    nodes,
    selectedNodeId,
    setSelectedNodeId,
    createNode
  };
};
