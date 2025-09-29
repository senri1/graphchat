import { useMemo } from 'react';
import BranchComposer from './components/BranchComposer.tsx';
import ConversationTree from './components/ConversationTree.tsx';
import NodeContextPanel from './components/NodeContextPanel.tsx';
import { useConversationTree } from './hooks/useConversationTree.ts';
import type { ConversationNode } from './lib/types.ts';

const buildAncestorPath = (nodes: ConversationNode[], nodeId: string | null): ConversationNode[] => {
  if (!nodeId) return [];
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const path: ConversationNode[] = [];
  let current = byId.get(nodeId) ?? null;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) ?? null : null;
  }
  return path;
};

const App = () => {
  const { nodes, selectedNodeId, setSelectedNodeId, createNode } = useConversationTree();

  const selectedPath = useMemo(() => buildAncestorPath(nodes, selectedNodeId), [nodes, selectedNodeId]);
  const handleBranchSubmit = async (message: string) => {
    if (!selectedNodeId) return;
    const userNode = createNode({
      parentId: selectedNodeId,
      role: 'user',
      content: message
    });

    createNode({
      parentId: userNode.id,
      role: 'assistant',
      content: 'Assistant reply placeholder. Integrate with backend to fetch a real response.'
    });

    setSelectedNodeId(userNode.id);
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-slate-800 bg-slate-950/80 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-white">GraphChat</h1>
            <p className="text-sm text-slate-400">
              Branching conversations visualised as an interactive tree. Optimised for desktop and mobile.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-sky-500 hover:text-sky-200"
          >
            New conversation
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:px-6">
        <section className="grid flex-1 grid-cols-1 gap-6 xl:grid-cols-[2fr_1fr]">
          <div className="flex min-h-[420px] flex-col gap-4">
            <div className="relative flex-1 overflow-hidden">
              <ConversationTree
                nodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            </div>
            <BranchComposer disabled={!selectedNodeId} onSubmit={handleBranchSubmit} />
          </div>
          <div className="flex min-h-[320px] flex-col">
            <NodeContextPanel path={selectedPath} />
          </div>
        </section>
        <section className="grid grid-cols-1 gap-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-300 md:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Why a tree?</h2>
            <p className="mt-2 leading-relaxed">
              Linear transcripts make it hard to explore alternatives. GraphChat lets you branch from any message so you can
              compare ideas side-by-side while keeping shared context intact.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Mobile-friendly design</h2>
            <p className="mt-2 leading-relaxed">
              Pan, pinch, and zoom through the conversation tree on touch devices. Controls and layouts adapt down to small
              screens so you can stay productive on the go.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
