import { useCallback, useMemo, useState } from "react";
import { PlusIcon, MinusIcon, ArrowsPointingOutIcon } from "@heroicons/react/24/outline";
import { useActions, useAppState } from "../../state/store";
import NodeCard from "./NodeCard";
import EdgesLayer from "./EdgesLayer";
import { usePanZoom } from "./usePanZoom";
import type { ChatNode } from "../../state/types";
import { getAncestors } from "../../utils/tree";

interface CanvasViewProps {
  chatId: string;
}

export default function CanvasView({ chatId }: CanvasViewProps) {
  const state = useAppState();
  const actions = useActions();
  const chat = state.chats[chatId];
  const viewport = chat.meta.viewport;
  const [linkingFrom, setLinkingFrom] = useState<string | undefined>();
  const [linkingPoint, setLinkingPoint] = useState<{ x: number; y: number } | undefined>();

  const { handleWheel, handlePointerDown, handlePointerMove, handlePointerUp } = usePanZoom({
    viewport,
    onChange: (next) => actions.setViewport(chatId, next)
  });

  const nodes = chat.nodes;
  const selection = state.selection;

  const screenToWorld = useCallback(
    (x: number, y: number) => ({
      x: (x - viewport.x) / viewport.zoom,
      y: (y - viewport.y) / viewport.zoom
    }),
    [viewport.x, viewport.y, viewport.zoom]
  );

  const handleCanvasPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button === 0) {
        actions.clearSelection();
      }
      handlePointerDown(event.nativeEvent);
    },
    [actions, handlePointerDown]
  );

  const handleCanvasPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      handlePointerMove(event.nativeEvent);
      if (linkingFrom) {
        const point = screenToWorld(event.clientX, event.clientY);
        setLinkingPoint(point);
      }
    },
    [handlePointerMove, linkingFrom, screenToWorld]
  );

  const handleCanvasPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      handlePointerUp(event.nativeEvent);
      if (linkingFrom) {
        const world = screenToWorld(event.clientX, event.clientY);
        const newId = actions.createNode({
          chatId,
          parentId: linkingFrom,
          x: world.x,
          y: world.y,
          role: "assistant"
        });
        actions.selectNodes([newId]);
        setLinkingFrom(undefined);
        setLinkingPoint(undefined);
      }
    },
    [actions, chatId, handlePointerUp, linkingFrom, screenToWorld]
  );

  const handleStartLink = useCallback(
    (nodeId: string) => {
      setLinkingPoint(undefined);
      setLinkingFrom((current) => (current === nodeId ? undefined : nodeId));
    },
    []
  );

  const handleCompleteLink = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      actions.reparentNode(targetId, sourceId);
      setLinkingFrom(undefined);
      setLinkingPoint(undefined);
    },
    [actions]
  );

  const zoomIn = () => {
    actions.setViewport(chatId, { ...viewport, zoom: Math.min(viewport.zoom * 1.1, 2) });
  };
  const zoomOut = () => {
    actions.setViewport(chatId, { ...viewport, zoom: Math.max(viewport.zoom * 0.9, 0.25) });
  };
  const fitView = () => {
    const nodeList = Object.values(nodes);
    if (!nodeList.length) return;
    const minX = Math.min(...nodeList.map((n) => n.x));
    const minY = Math.min(...nodeList.map((n) => n.y));
    const maxX = Math.max(...nodeList.map((n) => n.x + n.width));
    const maxY = Math.max(...nodeList.map((n) => n.y + n.height));
    const padding = 200;
    const width = maxX - minX + padding;
    const height = maxY - minY + padding;
    const scaleX = window.innerWidth / width;
    const scaleY = window.innerHeight / height;
    const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.25), 2);
    actions.setViewport(chatId, {
      zoom: newZoom,
      x: -minX * newZoom + padding / 2,
      y: -minY * newZoom + padding / 2
    });
  };

  const sortedNodes = useMemo(() => Object.values(nodes) as ChatNode[], [nodes]);
  const activeSelectionId = selection.nodeIds[0];
  const activePath = useMemo(() => {
    if (!activeSelectionId) return new Set<string>();
    const path = getAncestors(nodes, activeSelectionId);
    return new Set(path.map((node) => node.id));
  }, [activeSelectionId, nodes]);

  return (
    <div className="relative flex-1 overflow-hidden" role="application">
      <div
        className="absolute inset-0"
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onWheel={(event) => handleWheel(event.nativeEvent)}
      >
        <div className="canvas-grid absolute inset-0" />
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: "0 0"
          }}
        >
          <EdgesLayer
            nodes={nodes}
            selectedEdge={selection.edge}
            onSelectEdge={(parentId, childId) => actions.selectEdge(parentId, childId)}
            activePath={activePath}
        />
        {sortedNodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            selected={selection.nodeIds.includes(node.id)}
            scale={viewport.zoom}
            linkingFrom={linkingFrom}
            onStartLink={handleStartLink}
            onCompleteLink={handleCompleteLink}
            inActivePath={activePath.has(node.id)}
          />
        ))}
          {linkingFrom && linkingPoint && nodes[linkingFrom] && (
            <svg className="pointer-events-none absolute inset-0">
              <line
                x1={nodes[linkingFrom].x + nodes[linkingFrom].width / 2}
                y1={nodes[linkingFrom].y + nodes[linkingFrom].height / 2}
                x2={linkingPoint.x}
                y2={linkingPoint.y}
                stroke="#38bdf8"
                strokeWidth={1.5}
              />
            </svg>
          )}
        </div>
      </div>
      <div className="pointer-events-auto absolute bottom-6 right-6 flex flex-col gap-2">
        <button
          type="button"
          className="rounded-full bg-slate-900/90 p-3 text-slate-200 shadow-lg hover:bg-slate-800"
          onClick={zoomIn}
          aria-label="Zoom in"
        >
          <PlusIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="rounded-full bg-slate-900/90 p-3 text-slate-200 shadow-lg hover:bg-slate-800"
          onClick={zoomOut}
          aria-label="Zoom out"
        >
          <MinusIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="rounded-full bg-slate-900/90 p-3 text-slate-200 shadow-lg hover:bg-slate-800"
          onClick={fitView}
          aria-label="Fit to content"
        >
          <ArrowsPointingOutIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
