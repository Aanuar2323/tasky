/**
 * Modal.tsx — Ventana flotante genérica (overlay)
 *
 * Componente reutilizable que muestra una ventana modal sobre la
 * aplicación principal con animaciones fluidas.
 */

import type { ReactNode } from 'react';

export function Modal({
  title,
  open,
  onClose,
  children,
  widthClass = 'w-[920px]',
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop */}
      <button
        className="absolute inset-0 h-full w-full cursor-default"
        style={{
          background: 'oklch(15% 0 0 / 0.35)',
          backdropFilter: 'blur(8px)',
        }}
        onClick={onClose}
        aria-label="Cerrar modal"
      />

      {/* Modal */}
      <div
        className={`ui-drawer relative max-h-[88vh] w-full ${widthClass} overflow-hidden motion-pop`}
        style={{ animationDelay: '40ms' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{
            borderBottom: '1px solid var(--ui-line)',
            background: 'oklch(100% 0 0 / 0.9)',
          }}
        >
          <h2
            className="text-sm font-semibold text-[color:var(--ui-text)]"
            style={{ fontFamily: 'var(--font-body)', letterSpacing: '-0.01em' }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            className="ui-button ui-button--ghost"
            style={{ minHeight: '2rem', borderRadius: '10px', padding: '0.4rem 0.7rem' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="overflow-auto" style={{ maxHeight: 'calc(88vh - 60px)' }}>
          {children}
        </div>
      </div>
    </div>
  );
}