import { memo } from "react";
import type { ChatNode } from "../../state/types";

interface EdgeLayerProps {
  nodes: Record<string, ChatNode>;
  selectedEdge?: { parentId: string; childId: string };
  onSelectEdge: (parentId: string, childId: string) => void;
  activePath?: Set<string>;
}

function anchorPoint(parent: ChatNode, child: ChatNode) {
  const parentCenter = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
  const childCenter = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
  const dx = childCenter.x - parentCenter.x;
  const dy = childCenter.y - parentCenter.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx > absDy) {
    const parentX = dx > 0 ? parent.x + parent.width : parent.x;
    const childX = dx > 0 ? child.x : child.x + child.width;
    return {
      source: { x: parentX, y: parentCenter.y },
      target: { x: childX, y: childCenter.y }
    };
  }

  const parentY = dy > 0 ? parent.y + parent.height : parent.y;
  const childY = dy > 0 ? child.y : child.y + child.height;
  return {
    source: { x: parentCenter.x, y: parentY },
    target: { x: childCenter.x, y: childY }
  };
}

function EdgesLayerComponent({ nodes, selectedEdge, onSelectEdge, activePath }: EdgeLayerProps) {
  const edges = Object.values(nodes)
    .filter((node) => node.parentId)
    .map((node) => ({ parent: nodes[node.parentId!], child: node }));

  return (
    <svg className="absolute inset-0 h-full w-full" data-testid="edges-layer">
      <defs>
        <marker
          id="arrowhead"
          markerWidth="6"
          markerHeight="6"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L0,6 L6,3 z" fill="rgba(148, 163, 184, 0.9)" />
        </marker>
      </defs>
      {edges.map(({ parent, child }) => {
        if (!parent) return null;
        const { source, target } = anchorPoint(parent, child);
        const isSelected =
          selectedEdge &&
          selectedEdge.parentId === parent.id &&
          selectedEdge.childId === child.id;
        const inActivePath = activePath?.has(parent.id) && activePath?.has(child.id);
        return (
          <g key={`${parent.id}-${child.id}`}>
            <path
              d={`M ${source.x} ${source.y} L ${target.x} ${target.y}`}
              stroke={isSelected ? "#38bdf8" : inActivePath ? "#34d399" : "rgba(148, 163, 184, 0.6)"}
              strokeWidth={isSelected || inActivePath ? 2.5 : 1.8}
              fill="none"
              markerEnd="url(#arrowhead)"
              className="cursor-pointer"
              onClick={(event) => {
                event.stopPropagation();
                onSelectEdge(parent.id, child.id);
              }}
            />
          </g>
        );
      })}
    </svg>
  );
}

const EdgesLayer = memo(EdgesLayerComponent);
export default EdgesLayer;
