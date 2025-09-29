import type { Conversation, ConversationNode } from './types';

export const mockConversation: Conversation = {
  id: 'conv-1',
  title: 'Prototype Conversation',
  rootId: 'node-1',
  createdAt: new Date().toISOString()
};

export const mockNodes: ConversationNode[] = [
  {
    id: 'node-1',
    parentId: null,
    role: 'user',
    content: 'How can we visualise branching AI conversations?',
    createdAt: new Date().toISOString(),
    conversationId: 'conv-1'
  },
  {
    id: 'node-2',
    parentId: 'node-1',
    role: 'assistant',
    content: 'We could render them as a tree where each branch represents a fork.',
    createdAt: new Date().toISOString(),
    conversationId: 'conv-1'
  },
  {
    id: 'node-3',
    parentId: 'node-2',
    role: 'user',
    content: 'Show me how a branching follow-up might work.',
    createdAt: new Date().toISOString(),
    conversationId: 'conv-1'
  },
  {
    id: 'node-4',
    parentId: 'node-2',
    role: 'user',
    content: 'What about mobile responsiveness?',
    createdAt: new Date().toISOString(),
    conversationId: 'conv-1'
  }
];
