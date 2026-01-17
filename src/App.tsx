import React, { useLayoutEffect, useRef, useState } from 'react';
import { WorldEngine, type WorldEngineDebug } from './engine/WorldEngine';
import TextNodeEditor from './components/TextNodeEditor';

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const [debug, setDebug] = useState<WorldEngineDebug | null>(null);
  const [ui, setUi] = useState(() => ({ selectedNodeId: null as string | null, editingNodeId: null as string | null, editingText: '' }));

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

  return (
    <div className="app" ref={containerRef}>
      <canvas className="stage" ref={canvasRef} />
      {ui.editingNodeId ? (
        <TextNodeEditor
          value={ui.editingText}
          onChange={(next) => engineRef.current?.setEditingText(next)}
          onClose={() => engineRef.current?.clearSelection()}
        />
      ) : null}
      <div
        className="controls"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
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
