import type { ConversationNode } from '../lib/types';

interface NodeContextPanelProps {
  path: ConversationNode[];
}

const roleLabel: Record<string, string> = {
  user: 'You',
  assistant: 'Assistant'
};

const NodeContextPanel = ({ path }: NodeContextPanelProps) => {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/60">
      <div className="border-b border-slate-700 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Context</h2>
        <p className="mt-1 text-xs text-slate-400">
          The selected message inherits everything in this path when requesting a new assistant reply.
        </p>
      </div>
      <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {path.map((node) => (
          <div key={node.id} className="rounded-xl border border-slate-700/60 bg-slate-800/60 px-3 py-2 text-sm text-slate-100">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {roleLabel[node.role]}
            </span>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-100">{node.content}</p>
          </div>
        ))}
        {path.length === 0 && (
          <p className="text-sm text-slate-400">
            Select a node to inspect the conversation context.
          </p>
        )}
      </div>
    </div>
  );
};

export default NodeContextPanel;
