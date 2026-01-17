import React, { useLayoutEffect, useRef, useState } from 'react';
import { WorldEngine, type WorldEngineDebug } from './engine/WorldEngine';

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<WorldEngine | null>(null);
  const [debug, setDebug] = useState<WorldEngineDebug | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const engine = new WorldEngine({ canvas });
    engine.onDebug = setDebug;
    engine.start();
    engineRef.current = engine;

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
