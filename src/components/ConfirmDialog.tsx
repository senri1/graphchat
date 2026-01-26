import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDanger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog(props: Props) {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const open = props.open;
  const onCancel = props.onCancel;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => cancelBtnRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  const portalTarget = typeof document !== 'undefined' ? document.body : null;
  if (!open || !portalTarget) return null;

  return createPortal(
    <div className="confirmOverlay" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="confirmOverlay__backdrop" onMouseDown={props.onCancel} />
      <div
        className="confirmDialog"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <div className="confirmDialog__title">{props.title}</div>
        {props.message ? <div className="confirmDialog__message">{props.message}</div> : null}
        <div className="confirmDialog__actions">
          <button className="settingsBtn" type="button" onClick={props.onCancel} ref={cancelBtnRef}>
            {props.cancelLabel || 'Cancel'}
          </button>
          <button
            className={`settingsBtn ${props.confirmDanger ? 'settingsBtn--danger' : ''}`}
            type="button"
            onClick={props.onConfirm}
          >
            {props.confirmLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
