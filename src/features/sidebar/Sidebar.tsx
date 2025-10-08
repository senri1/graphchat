import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Bars3Icon,
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  TrashIcon
} from "@heroicons/react/24/outline";
import { useActions, useAppState } from "../../state/store";
import { formatDistanceToNow } from "date-fns";

export default function Sidebar() {
  const state = useAppState();
  const actions = useActions();
  const [query, setQuery] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = state.ui.sidebarCollapsed;

  const chats = useMemo(() => {
    const list = state.chatOrder
      .map((id) => state.chats[id])
      .filter(Boolean)
      .filter((chat) =>
        chat.meta.title.toLowerCase().includes(query.trim().toLowerCase())
      );
    return list;
  }, [query, state.chatOrder, state.chats]);

  return (
    <aside
      className={`flex h-full flex-col border-r border-slate-800 bg-slate-950/95 backdrop-blur transition-all duration-200 ${collapsed ? "w-14" : "w-72"}`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-2 text-sm text-slate-100"
          onClick={() => actions.toggleSidebar()}
        >
          <Bars3Icon className="h-5 w-5" />
          {!collapsed && <span>Chats</span>}
        </button>
        {!collapsed && (
          <button
            type="button"
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
            onClick={() => {
              const id = actions.createChat();
              navigate(`/chat/${id}`);
            }}
          >
            <PlusIcon className="mr-1 inline h-4 w-4" /> New Chat
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="px-3 py-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            className="w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
          />
        </div>
      )}
      <nav className="flex-1 overflow-y-auto">
        <ul className="space-y-1 px-2 py-2">
          {chats.map((chat) => {
            const active = location.pathname.includes(chat.meta.id);
            let updatedLabel = "Updated just now";
            const updatedDate = new Date(chat.meta.updatedAt);
            if (!Number.isNaN(updatedDate.getTime())) {
              try {
                updatedLabel = `Updated ${formatDistanceToNow(updatedDate, { addSuffix: true })}`;
              } catch (error) {
                console.warn("Failed to format chat timestamp", error);
              }
            }
            return (
              <li key={chat.meta.id}>
                <Link
                  to={`/chat/${chat.meta.id}`}
                  className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition hover:bg-slate-800 ${
                    active ? "bg-slate-800 text-slate-100" : "text-slate-300"
                  }`}
                >
                  <div className="flex flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <ChatBubbleLeftRightIcon className="h-4 w-4" />
                      <span className="truncate">{chat.meta.title || "Untitled chat"}</span>
                    </span>
                    <span className="mt-1 text-xs text-slate-400">{updatedLabel}</span>
                  </div>
                  <button
                    type="button"
                    className="ml-2 rounded p-1 text-slate-500 hover:bg-slate-900 hover:text-red-400"
                    onClick={(event) => {
                      event.preventDefault();
                      actions.deleteChat(chat.meta.id);
                    }}
                    aria-label="Delete chat"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <button
        type="button"
        className="flex items-center justify-center gap-1 border-t border-slate-800 py-2 text-xs text-slate-400 hover:text-slate-200"
        onClick={() => actions.toggleSidebar()}
      >
        {collapsed ? (
          <>
            <ChevronRightIcon className="h-4 w-4" /> Expand
          </>
        ) : (
          <>
            <ChevronLeftIcon className="h-4 w-4" /> Collapse
          </>
        )}
      </button>
    </aside>
  );
}
