import { useCallback, useEffect, useRef } from "react";
import type { ViewportState } from "../../state/types";

interface PanZoomOptions {
  viewport: ViewportState;
  onChange: (next: ViewportState) => void;
}

export function usePanZoom({ viewport, onChange }: PanZoomOptions) {
  const stateRef = useRef(viewport);
  const isPanning = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const spacePressed = useRef(false);

  useEffect(() => {
    stateRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePressed.current = true;
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePressed.current = false;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const { offsetX, offsetY, deltaY } = event;
        const zoomFactor = Math.exp(-deltaY / 500);
        const current = stateRef.current;
        const newZoom = Math.min(Math.max(current.zoom * zoomFactor, 0.25), 2);
        const scale = newZoom / current.zoom;
        const newX = offsetX - (offsetX - current.x) * scale;
        const newY = offsetY - (offsetY - current.y) * scale;
        onChange({ x: newX, y: newY, zoom: newZoom });
      }
    },
    [onChange]
  );

  const handlePointerDown = useCallback((event: PointerEvent) => {
    const allowPan =
      event.button === 1 ||
      (event.button === 0 && (event.shiftKey || spacePressed.current)) ||
      event.altKey;
    if (!allowPan) {
      return;
    }
    event.preventDefault();
    isPanning.current = true;
    last.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!isPanning.current) return;
      event.preventDefault();
      const dx = event.clientX - last.current.x;
      const dy = event.clientY - last.current.y;
      last.current = { x: event.clientX, y: event.clientY };
      const current = stateRef.current;
      onChange({ x: current.x + dx, y: current.y + dy, zoom: current.zoom });
    },
    [onChange]
  );

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  return { handleWheel, handlePointerDown, handlePointerMove, handlePointerUp };
}
