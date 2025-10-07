import { ArrowDownTrayIcon, ArrowUpTrayIcon, SwatchIcon } from "@heroicons/react/24/outline";
import { useAppState, useActions } from "../state/store";
import { exportChats, importChats } from "../utils/persistence";

export default function TopBar() {
  const state = useAppState();
  const actions = useActions();
  const activeChat = state.activeChatId ? state.chats[state.activeChatId] : undefined;

  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-4 py-2 backdrop-blur">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Branch</h1>
        {activeChat ? (
          <p className="text-xs text-slate-400">{activeChat.meta.title}</p>
        ) : (
          <p className="text-xs text-slate-400">Create a chat to begin</p>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
          onClick={() => importChats(actions.importData)}
        >
          <ArrowDownTrayIcon className="h-4 w-4" />
          Import
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
          onClick={() => exportChats(state)}
        >
          <ArrowUpTrayIcon className="h-4 w-4" />
          Export
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
          onClick={() => actions.toggleGridSnap()}
        >
          <SwatchIcon className="h-4 w-4" />
          {state.ui.gridSnap ? "Snap" : "Free"}
        </button>
      </div>
    </header>
  );
}
