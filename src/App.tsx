import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { useActions, useAppState } from "./state/store";
import Sidebar from "./features/sidebar/Sidebar";
import CanvasView from "./features/canvas/CanvasView";
import TopBar from "./components/TopBar";
import { useKeyboardShortcuts } from "./features/keyboard/useKeyboardShortcuts";

function DefaultChatRedirect() {
  const state = useAppState();
  const actions = useActions();
  const [seededChatId, setSeededChatId] = useState<string | undefined>();

  const fallbackChatId =
    state.activeChatId && state.chats[state.activeChatId]
      ? state.activeChatId
      : state.chatOrder.find((id) => state.chats[id]);

  useEffect(() => {
    if (fallbackChatId) return;
    if (seededChatId) return;
    if (state.chatOrder.length) return;
    const newId = actions.createChat();
    setSeededChatId(newId);
  }, [actions, fallbackChatId, seededChatId, state.chatOrder.length]);

  const targetChatId = fallbackChatId ?? seededChatId;

  useEffect(() => {
    if (!targetChatId) return;
    if (state.activeChatId === targetChatId) return;
    actions.setActiveChat(targetChatId);
  }, [actions, state.activeChatId, targetChatId]);

  if (!targetChatId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Preparing chat…
      </div>
    );
  }

  return <Navigate to={`/chat/${targetChatId}`} replace />;
}

function ChatRoute() {
  const { chatId } = useParams<{ chatId: string }>();
  const state = useAppState();
  const actions = useActions();
  const [seededChatId, setSeededChatId] = useState<string | undefined>();

  const chat = chatId ? state.chats[chatId] : undefined;
  const fallbackChatId = state.chatOrder.find((id) => state.chats[id]);

  useEffect(() => {
    if (!chatId) return;
    if (chat) return;
    if (seededChatId) return;
    if (state.chatOrder.length) return;
    const newId = actions.createChat();
    setSeededChatId(newId);
  }, [actions, chat, chatId, seededChatId, state.chatOrder.length]);

  useEffect(() => {
    if (!chatId || !chat) return;
    if (state.activeChatId === chatId) return;
    actions.setActiveChat(chatId);
  }, [actions, chat, chatId, state.activeChatId]);

  useEffect(() => {
    if (!chatId || !chat) return;
    if (Object.keys(chat.nodes).length > 0) return;
    const { viewport } = chat.meta;
    const hasWindow = typeof window !== "undefined";
    const worldX = hasWindow
      ? (window.innerWidth / 2 - viewport.x) / viewport.zoom - 140
      : 240;
    const worldY = hasWindow
      ? (window.innerHeight / 2 - viewport.y) / viewport.zoom - 80
      : 160;
    actions.createNode({ chatId, x: worldX, y: worldY });
  }, [actions, chat, chatId]);

  if (!chatId) {
    return <DefaultChatRedirect />;
  }

  if (!chat) {
    const target = seededChatId ?? fallbackChatId;
    if (target && target !== chatId) {
      return <Navigate to={`/chat/${target}`} replace />;
    }
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        Loading chat…
      </div>
    );
  }

  return <CanvasView chatId={chatId} />;
}

function AppRoutes() {
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas-dark text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <Routes>
          <Route path="/" element={<DefaultChatRedirect />} />
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
