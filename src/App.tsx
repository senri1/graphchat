import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WorldEngine, type WorldEngineDebug } from './engine/WorldEngine';
import TextNodeEditor from './components/TextNodeEditor';

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const [debug, setDebug] = useState<WorldEngineDebug | null>(null);
  const [ui, setUi] = useState(() => ({ selectedNodeId: null as string | null, editingNodeId: null as string | null, editingText: '' }));
  const [viewport, setViewport] = useState(() => ({ w: 1, h: 1 }));

  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const engine = new WorldEngine({ canvas });
    engine.onDebug = setDebug;
    engine.onUiState = setUi;
    engine.start();
    engineRef.current = engine;
    setUi(engine.getUiState());

    const resize = () => {
      const rect = container.getBoundingClientRect();
      setViewport({ w: rect.width, h: rect.height });
      engine.resize(rect.width, rect.height);
    };

    const ro = new ResizeObserver(() => resize());
    ro.observe(container);
    resize();

    return () => {
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (ui.editingNodeId) return;
      if (!engineRef.current) return;

      const active = document.activeElement as HTMLElement | null;
      const canvas = canvasRef.current;
      const isTypingTarget =
        !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (isTypingTarget) return;
      if (active && active !== document.body && active !== document.documentElement && active !== canvas) return;

      if (e.key === 'Enter') {
        engineRef.current.beginEditingSelectedNode();
        e.preventDefault();
        return;
      }

      if (e.key === 'Escape') {
        engineRef.current.clearSelection();
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ui.editingNodeId]);

  const editorAnchor = ui.editingNodeId ? engineRef.current?.getNodeScreenRect(ui.editingNodeId) ?? null : null;
  const editorTitle = ui.editingNodeId ? engineRef.current?.getNodeTitle(ui.editingNodeId) ?? null : null;
  const editorZoom = debug?.zoom ?? engineRef.current?.camera.zoom ?? 1;

  return (
    <div className="app" ref={containerRef}>
      <canvas className="stage" ref={canvasRef} />
      {ui.editingNodeId ? (
        <TextNodeEditor
          nodeId={ui.editingNodeId}
          title={editorTitle}
          initialValue={ui.editingText}
          anchorRect={editorAnchor}
          viewport={viewport}
          zoom={editorZoom}
          onCommit={(next) => engineRef.current?.commitEditing(next)}
          onCancel={() => engineRef.current?.cancelEditing()}
        />
      ) : null}
      <div
        className="controls"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <input
          ref={pdfInputRef}
          className="controls__fileInput"
          type="file"
          accept="application/pdf"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!file) return;
            void engineRef.current?.importPdfFromFile(file);
          }}
        />
        <button className="controls__btn" type="button" onClick={() => pdfInputRef.current?.click()}>
          Import PDF
        </button>
        <button className="controls__btn" type="button" onClick={() => engineRef.current?.spawnLatexStressTest(50)}>
          +50 nodes
        </button>
        <button className="controls__btn" type="button" onClick={() => engineRef.current?.spawnLatexStressTest(200)}>
          +200 nodes
        </button>
        <button className="controls__btn" type="button" onClick={() => engineRef.current?.clearStressNodes()}>
          Reset
        </button>
      </div>
      <div className="hud">
        <div style={{ fontWeight: 650, marginBottom: 2 }}>GraphChatV1</div>
        <div style={{ opacity: 0.9 }}>
          {debug
            ? `zoom ${debug.zoom.toFixed(2)} • cam ${debug.cameraX.toFixed(1)}, ${debug.cameraY.toFixed(1)} • ${debug.interacting ? 'interacting' : 'idle'}`
            : 'starting…'}
        </div>
      </div>
    </div>
  );
}
