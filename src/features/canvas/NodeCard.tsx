import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowsPointingOutIcon,
  EllipsisHorizontalIcon,
  PlusSmallIcon
} from "@heroicons/react/24/outline";
import type { ChatNode } from "../../state/types";
import { useActions, useAppState } from "../../state/store";
import { snap } from "../../utils/math";
import { pathMessages } from "../../utils/context";

interface NodeCardProps {
  node: ChatNode;
  selected: boolean;
  scale: number;
  linkingFrom?: string;
  onStartLink: (nodeId: string) => void;
  onCompleteLink: (sourceId: string, targetId: string) => void;
  inActivePath?: boolean;
}

export default function NodeCard({
  node,
  selected,
  scale,
  linkingFrom,
  onStartLink,
  onCompleteLink,
  inActivePath
}: NodeCardProps) {
  const actions = useActions();
  const state = useAppState();
  const gridSnap = state.ui.gridSnap;
  const chat = state.chats[node.chatId];
  if (!chat) {
    return null;
  }
  const viewport = chat.meta.viewport;
  const [isDragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ width: node.width, height: node.height, x: 0, y: 0 });

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("textarea")) return;
      event.preventDefault();
      dragOffset.current = {
        x: event.clientX - node.x * scale - viewport.x,
        y: event.clientY - node.y * scale - viewport.y
      };
      setDragging(true);
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [node.x, node.y, scale, viewport.x, viewport.y]
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      event.preventDefault();
      const x = (event.clientX - dragOffset.current.x - viewport.x) / scale;
      const y = (event.clientY - dragOffset.current.y - viewport.y) / scale;
      actions.setNodePosition(
        node.id,
        gridSnap ? snap(x, 8) : x,
        gridSnap ? snap(y, 8) : y
      );
    },
    [actions, gridSnap, isDragging, node.id, scale, viewport.x, viewport.y]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      event.preventDefault();
      setDragging(false);
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    },
    [isDragging]
  );

  const handleResizeDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeStart.current = {
      width: node.width,
      height: node.height,
      x: event.clientX,
      y: event.clientY
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }, [node.height, node.width]);

  const handleResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!(event.target as HTMLElement).hasPointerCapture(event.pointerId)) return;
      event.preventDefault();
      const dx = (event.clientX - resizeStart.current.x) / scale;
      const dy = (event.clientY - resizeStart.current.y) / scale;
      actions.resizeNode(node.id, resizeStart.current.width + dx, resizeStart.current.height + dy);
    },
    [actions, node.id, scale]
  );

  const handleResizeUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  }, []);

  const handleAskAi = useCallback(() => {
    const messages = pathMessages(chat, node.id);
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const childId = actions.createNode({
      chatId: node.chatId,
      parentId: node.id,
      x: node.x,
      y: node.y + node.height + 180,
      role: "assistant",
      autoFocus: false
    });
    actions.setNodeStatus(childId, "sending");
    const mock = `Here is a continuation based on the context:\n${prompt}`;
    let index = 0;
    const interval = window.setInterval(() => {
      index += 8;
      actions.updateNodeText(childId, mock.slice(0, index));
      if (index >= mock.length) {
        window.clearInterval(interval);
        actions.setNodeStatus(childId, "done");
      }
    }, 50);
  }, [actions, chat, node]);

  const roleStyles: Record<ChatNode["role"], string> = {
    user: "bg-slate-800/80 border border-slate-600",
    assistant: "bg-slate-700/80 border border-slate-500",
    note: "bg-slate-600/80 border border-slate-400"
  };

  return (
    <div
      role="group"
      className={`absolute flex flex-col rounded-xl p-0 text-slate-100 shadow-lg transition-all ${roleStyles[node.role]} ${
        selected
          ? "ring-2 ring-sky-400"
          : inActivePath
            ? "ring-2 ring-emerald-500/50"
            : "ring-1 ring-slate-800/60"
      }`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        transformOrigin: "top left"
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button === 0) {
          actions.selectNodes([node.id]);
        }
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (linkingFrom && linkingFrom !== node.id) {
          event.stopPropagation();
          onCompleteLink(linkingFrom, node.id);
        }
      }}
    >
      <div
        className="flex cursor-move select-none items-center justify-between rounded-t-xl bg-slate-950/60 px-3 py-2 text-xs uppercase tracking-wide"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[10px] font-semibold">
          {node.role}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded bg-slate-800/80 p-1 hover:bg-sky-500/30"
            aria-label="Add child"
            onClick={(event) => {
              event.stopPropagation();
              actions.createNode({
                chatId: node.chatId,
                parentId: node.id,
                x: node.x + node.width + 40,
                y: node.y + node.height + 40,
                role: node.role === "user" ? "assistant" : "user"
              });
            }}
          >
            <PlusSmallIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded bg-slate-800/80 p-1 hover:bg-slate-700"
            aria-label="Start link"
            onClick={(event) => {
              event.stopPropagation();
              onStartLink(node.id);
            }}
          >
            <ArrowsPointingOutIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded bg-slate-800/80 p-1 hover:bg-slate-700"
            aria-haspopup="menu"
          >
            <EllipsisHorizontalIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
      <textarea
        aria-multiline
        className="flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-slate-100 focus:outline-none"
        value={node.text}
        placeholder={node.role === "assistant" ? "Assistant response" : "Enter message"}
        onChange={(event) => actions.updateNodeText(node.id, event.target.value)}
        onFocus={() => actions.setEditingNode(node.id)}
        onBlur={() => actions.setEditingNode(undefined)}
      />
      <div className="flex items-center justify-between border-t border-slate-700/60 px-3 py-1 text-[10px] uppercase tracking-wide text-slate-400">
        <span>{node.status}</span>
        <span>{node.text.length} chars</span>
      </div>
      {node.role !== "assistant" && (
        <button
          type="button"
          className="mx-3 mb-2 rounded-md border border-slate-600 bg-slate-800/80 px-3 py-1 text-xs uppercase tracking-wide text-slate-200 hover:bg-slate-700"
          onClick={handleAskAi}
        >
          Ask AI
        </button>
      )}
      <button
        type="button"
        className="absolute bottom-1 right-1 h-5 w-5 cursor-se-resize rounded bg-slate-900/70 p-1 text-slate-300"
        aria-label="Resize"
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
      >
        <ArrowsPointingOutIcon className="h-3 w-3" />
      </button>
    </div>
  );
}
