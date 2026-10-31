import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { IconX } from './Icons';

/** Matches the CSS exit animation (.modal-backdrop[data-state="closing"]); reduced motion closes at once. */
const EXIT_MS = 200;
export function prefersReducedMotion(): boolean { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

const CloseContext = createContext<() => void>(() => {});
/** Closes the surrounding dialog through its exit animation. */
export function useModalClose(): () => void { return useContext(CloseContext); }

export function Modal({ title, onClose, children, width = 560, footer, className }: { title: string; onClose: () => void; children: ReactNode; width?: number;
  footer?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClose);
  useEffect(() => { latest.current = onClose; }, [onClose]);
  const requestClose = useCallback(() => setClosing(true), []);
  useEffect(() => {
    if (!closing) return;
    if (prefersReducedMotion()) { latest.current(); return; }
    const timer = setTimeout(() => latest.current(), EXIT_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); requestClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, [requestClose]);
  return (
    <CloseContext.Provider value={requestClose}>
      <div className="modal-backdrop" data-state={closing ? 'closing' : 'open'} onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
        <div className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} tabIndex={-1}>
          <header className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={requestClose} aria-label="Close"><IconX size={16} /></button>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-foot">{footer}</footer>}
        </div>
      </div>
    </CloseContext.Provider>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Equal-width options with a thumb that slides between them on the snappy spring. */
export function Segmented<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean }) {
  const index = Math.max(0, options.findIndex(option => option.value === value));
  return (
    <div className="segmented" role="radiogroup" style={{ '--count': options.length, '--index': index } as CSSProperties}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map(option => (
        <button key={String(option.value)} role="radio" aria-checked={option.value === value} disabled={disabled}
          className={option.value === value ? 'is-active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span className="switch-track" />
    </label>
  );
}
