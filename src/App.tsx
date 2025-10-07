import { useEffect } from "react";
import { Routes, Route, useNavigate, useParams } from "react-router-dom";
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

  useEffect(() => {
    if (!chatId) {
      if (state.chatOrder.length) {
        navigate(`/chat/${state.chatOrder[0]}`, { replace: true });
      }
      return;
    }

    const chatExists = Boolean(state.chats[chatId]);
    if (!chatExists) {
      if (state.chatOrder.length) {
        navigate(`/chat/${state.chatOrder[0]}`, { replace: true });
      }
      return;
    }

    if (state.activeChatId !== chatId) {
      actions.setActiveChat(chatId);
    }
  }, [actions, chatId, navigate, state.activeChatId, state.chatOrder, state.chats]);

  if (!chatId || !state.chats[chatId]) {
    return <div className="flex-1" />;
  }

  return <CanvasView chatId={chatId} />;
}

function AppRoutes() {
  const navigate = useNavigate();
  const actions = useActions();
  const state = useAppState();

  useEffect(() => {
    if (!state.chatOrder.length) {
      const id = actions.createChat();
      navigate(`/chat/${id}`, { replace: true });
      return;
    }
    if (!state.activeChatId) {
      navigate(`/chat/${state.chatOrder[0]}`, { replace: true });
    }
  }, [actions, navigate, state.activeChatId, state.chatOrder]);

  useKeyboardShortcuts();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas-dark text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <Routes>
          <Route path="/chat/:chatId" element={<ChatRoute />} />
          <Route path="*" element={<div className="flex-1" />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return <AppRoutes />;
}
