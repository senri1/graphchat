import { useEffect, useRef } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useActions, useAppState } from "./state/store";
import Sidebar from "./features/sidebar/Sidebar";
import CanvasView from "./features/canvas/CanvasView";
import TopBar from "./components/TopBar";
import { useKeyboardShortcuts } from "./features/keyboard/useKeyboardShortcuts";

function ChatRoute() {
  const { chatId } = useParams<{ chatId: string }>();
  const navigate = useNavigate();
  const state = useAppState();
  const actions = useActions();
  const hasSeededRef = useRef(false);

  const explicitChat = chatId && state.chats[chatId] ? chatId : undefined;
  const activeChat =
    state.activeChatId && state.chats[state.activeChatId]
      ? state.activeChatId
      : undefined;
  const fallbackChatId = explicitChat ?? activeChat ?? state.chatOrder[0];

  useEffect(() => {
    if (!state.chatOrder.length && !hasSeededRef.current) {
      hasSeededRef.current = true;
      const newId = actions.createChat();
      navigate(`/chat/${newId}`, { replace: true });
      return;
    }

    if (fallbackChatId && state.activeChatId !== fallbackChatId) {
      actions.setActiveChat(fallbackChatId);
    }

    if (!chatId && fallbackChatId) {
      navigate(`/chat/${fallbackChatId}`, { replace: true });
    }
  }, [actions, chatId, fallbackChatId, navigate, state.activeChatId, state.chatOrder.length]);

  const chat = fallbackChatId ? state.chats[fallbackChatId] : undefined;

  useEffect(() => {
    if (!fallbackChatId || !chat) return;
    if (Object.keys(chat.nodes).length > 0) return;
    const { viewport } = chat.meta;
    const hasWindow = typeof window !== "undefined";
    const worldX = hasWindow
      ? (window.innerWidth / 2 - viewport.x) / viewport.zoom - 140
      : 240;
    const worldY = hasWindow
      ? (window.innerHeight / 2 - viewport.y) / viewport.zoom - 80
      : 160;
    actions.createNode({ chatId: fallbackChatId, x: worldX, y: worldY });
  }, [actions, chat, fallbackChatId]);

  if (!fallbackChatId || !chat) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Loading chat…
      </div>
    );
  }

  return <CanvasView chatId={fallbackChatId} />;
}

function AppRoutes() {
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas-dark text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <Routes>
          <Route path="/" element={<ChatRoute />} />
          <Route path="/chat/:chatId" element={<ChatRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return <AppRoutes />;
}
