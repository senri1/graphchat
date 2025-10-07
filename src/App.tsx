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
  const chat = chatId ? state.chats[chatId] : undefined;

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

  if (!chatId || !chat) {
    return <div className="flex-1" />;
  }

  return <CanvasView chatId={chatId} />;
}

function RootRedirect() {
  const navigate = useNavigate();
  const actions = useActions();
  const state = useAppState();
  const { activeChatId, chatOrder } = state;

  useEffect(() => {
    let targetId = activeChatId && chatOrder.includes(activeChatId) ? activeChatId : undefined;

    if (!chatOrder.length) {
      targetId = actions.createChat();
    } else if (!targetId) {
      targetId = chatOrder[0];
      actions.setActiveChat(targetId);
    }

    if (targetId) {
      navigate(`/chat/${targetId}`, { replace: true });
    }
  }, [actions, activeChatId, chatOrder, navigate]);

  return (
    <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
      Loading chat…
    </div>
  );
}

function AppRoutes() {
  useKeyboardShortcuts();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas-dark text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/chat/:chatId" element={<ChatRoute />} />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  return <AppRoutes />;
}
