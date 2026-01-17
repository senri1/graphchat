import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';
import 'katex/dist/katex.min.css';
import 'katex/dist/contrib/copy-tex.mjs';

function installBrowserZoomBlockers(): void {
  if (typeof window === 'undefined') return;

  const w = window as any;
  if (w.__gcBrowserZoomBlockersInstalled) return;
  w.__gcBrowserZoomBlockersInstalled = true;

  const opts: AddEventListenerOptions = { passive: false, capture: true };

  const onWheel = (e: WheelEvent) => {
    // Trackpad pinch zoom is typically delivered as `wheel` with `ctrlKey=true` (Chrome/Edge).
    // Prevent browser/page zoom so the app can own zoom behavior.
    if (e.ctrlKey) e.preventDefault();
  };

  const onGesture = (e: Event) => {
    // Safari can dispatch gesture* events for trackpad pinch zoom.
    e.preventDefault();
  };

  window.addEventListener('wheel', onWheel, opts);
  window.addEventListener('gesturestart', onGesture as any, opts);
  window.addEventListener('gesturechange', onGesture as any, opts);
  window.addEventListener('gestureend', onGesture as any, opts);
  document.addEventListener('gesturestart', onGesture as any, opts);
  document.addEventListener('gesturechange', onGesture as any, opts);
  document.addEventListener('gestureend', onGesture as any, opts);
}

installBrowserZoomBlockers();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
