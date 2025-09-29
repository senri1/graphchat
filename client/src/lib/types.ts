export type MessageRole = 'user' | 'assistant';

export interface ConversationNode {
  id: string;
  parentId: string | null;
  role: MessageRole;
  content: string;
  createdAt: string;
  conversationId: string;
}

export interface Conversation {
  id: string;
  title: string;
  rootId: string | null;
  createdAt: string;
}
