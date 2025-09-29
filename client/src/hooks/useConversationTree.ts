import { useCallback, useState } from 'react';
import { nanoid } from 'nanoid';
import type { ConversationNode, MessageRole } from '../lib/types';

interface CreateNodeOptions {
  parentId: string | null;
  role: MessageRole;
  content: string;
}

export const useConversationTree = () => {
  const [nodes, setNodes] = useState<ConversationNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string>(() => nanoid());

  const createNode = useCallback(({ parentId, role, content }: CreateNodeOptions) => {
    let newNode: ConversationNode | null = null;
    setNodes((prev) => {
      newNode = {
        id: nanoid(),
        parentId,
        role,
        content,
        createdAt: new Date().toISOString(),
        conversationId
      };
      return [...prev, newNode];
    });
    return newNode!;
  }, [conversationId]);

  const resetConversation = useCallback(() => {
    setConversationId(nanoid());
    setNodes([]);
    setSelectedNodeId(null);
  }, []);

  return {
    nodes,
    selectedNodeId,
    setSelectedNodeId,
    createNode,
    resetConversation
  };
};
