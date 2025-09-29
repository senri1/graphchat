
import '@xyflow/react/dist/style.css';
import type { ConversationNode } from '../lib/types';
import { clsx } from 'clsx';

interface ConversationTreeProps {
  nodes: ConversationNode[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

const nodeHeight = 84;
const nodeWidth = 240;
const verticalGap = 96;
const horizontalGap = 200;

const roleStyles: Record<string, string> = {
  user: 'bg-sky-500/20 border-sky-400 text-sky-100',
  assistant: 'bg-slate-700 border-slate-500 text-slate-100'
};

const formatTimestamp = (iso: string) => new Date(iso).toLocaleTimeString([], {
  hour: '2-digit',
  minute: '2-digit'
});

const ConversationTree = memo(({ nodes, selectedNodeId, onSelectNode }: ConversationTreeProps) => {
  const nodeLookup = useMemo(() => new Map(nodes.map((node) => [node.id, node] as const)), [nodes]);

  const { flowNodes, flowEdges } = useMemo(() => {
    const roots = nodes.filter((node) => node.parentId === null);
    const byParent = new Map<string | null, ConversationNode[]>();
    for (const node of nodes) {
      const bucket = byParent.get(node.parentId) ?? [];
      bucket.push(node);
      byParent.set(node.parentId, bucket);
    }
    for (const bucket of byParent.values()) {
      bucket.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }


    const assignPositions = (
      node: ConversationNode,
      depth: number,
      index: number,
      yOffset: number
    ) => {
      const y = yOffset + index * (nodeHeight + verticalGap);
      const x = depth * (nodeWidth + horizontalGap);
      flowNodes.push({
        id: node.id,
        type: 'default',
        position: { x, y },

        style: {
          width: nodeWidth,
          height: nodeHeight
        }
      });

      const children = byParent.get(node.id) ?? [];
      children.forEach((child, childIndex) => {
        flowEdges.push({
          id: `${node.id}-${child.id}`,
          source: node.id,
          target: child.id,
          type: 'smoothstep',
          animated: child.role === 'assistant'
        });
        assignPositions(child, depth + 1, childIndex, y);
      });
    };

    roots.forEach((root, rootIndex) => assignPositions(root, 0, rootIndex, rootIndex * (nodeHeight + verticalGap)));

    return { flowNodes, flowEdges };
  }, [nodes]);


  return (
    <div className="relative h-full w-full rounded-2xl border border-slate-700 bg-slate-900/60">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        minZoom={0.25}
        maxZoom={1.4}
        attributionPosition="top-right"
        proOptions={{ hideAttribution: true }}
        className="rounded-2xl"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable

      >
        <Background color="#1e293b" gap={32} size={1} />
        <MiniMap maskColor="rgba(15,23,42,0.7)" pannable zoomable />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      <div className="pointer-events-none absolute inset-0">
        {flowNodes.map((node) => {
          const original = nodeLookup.get(node.id);
          if (!original) return null;
          return (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelectNode(node.id)}
            className={clsx(
              'pointer-events-auto absolute flex h-[84px] w-[240px] flex-col rounded-2xl border px-4 py-3 text-left shadow-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              roleStyles[original.role],
              selectedNodeId === node.id && 'ring-2 ring-offset-2 ring-offset-slate-900 ring-sky-400'
            )}
            style={{
              transform: `translate(${node.position.x}px, ${node.position.y}px)`
            }}
          >
            <span className="text-xs uppercase tracking-wide text-slate-300">
              {original.role === 'user' ? 'You' : 'Assistant'} · {formatTimestamp(original.createdAt)}
            </span>
            <span className="clamp-3 mt-2 text-sm text-slate-50">
              {original.content}
            </span>
          </button>
        );
        })}
      </div>
    </div>
  );
});

ConversationTree.displayName = 'ConversationTree';

export default ConversationTree;
