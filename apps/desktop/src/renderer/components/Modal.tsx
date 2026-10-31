import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { IconX } from './Icons';

/** Matches the CSS exit animation (.modal-backdrop[data-state="closing"]); reduced motion closes at once. */
const EXIT_MS = 200;
export function prefersReducedMotion(): boolean { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

const CloseContext = createContext<() => void>(() => {});
/** Closes the surrounding dialog through its exit animation. */
export function useModalClose(): () => void { return useContext(CloseContext); }

/** Open dialogs, innermost last: only the top one answers Escape and keeps Tab focus inside itself. */
const stack: symbol[] = [];
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, width = 560, footer, className, onEscape, hideHeader }: { title: string; onClose: () => void;
  children: ReactNode; width?: number | string; footer?: ReactNode; className?: string;
  /** Lets the dialog consume Escape first (for example to clear a search); return true when handled. */
  onEscape?: () => boolean; hideHeader?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClose);
  const escape = useRef(onEscape);
  useEffect(() => { latest.current = onClose; escape.current = onEscape; }, [onClose, onEscape]);
  const requestClose = useCallback(() => setClosing(true), []);
  useEffect(() => {
    if (!closing) return;
    if (prefersReducedMotion()) { latest.current(); return; }
    const timer = setTimeout(() => latest.current(), EXIT_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  useEffect(() => {
    const self = Symbol(title);
    stack.push(self);
    const previous = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (stack.at(-1) !== self) return;
      if (event.key === 'Escape') {
        event.stopPropagation(); event.preventDefault();
        if (!escape.current?.()) requestClose();
      } else if (event.key === 'Tab' && ref.current) {
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.offsetParent !== null);
        if (!items.length) return;
        const first = items[0]!; const last = items.at(-1)!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); stack.splice(stack.indexOf(self), 1); previous?.focus(); };
    // The title only names the entry; the dialog registers once for its lifetime.
  }, [requestClose]);
  return (
    <CloseContext.Provider value={requestClose}>
      <div className="modal-backdrop" data-state={closing ? 'closing' : 'open'} onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
        <div className={`modal${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} tabIndex={-1}>
          {!hideHeader && (
            <header className="modal-head">
              <h2>{title}</h2>
              <button className="icon-btn" onClick={requestClose} aria-label="Close"><IconX size={16} /></button>
            </header>
          )}
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-foot">{footer}</footer>}
        </div>
      </div>
    </CloseContext.Provider>
  );
}

export type Scope = 'global' | 'device';
const SCOPE_LABEL: Record<Scope, string> = { global: 'Default for all chats', device: 'This app' };
export function Row({ label, hint, children, scope, id }: { label: string; hint?: ReactNode; children: ReactNode; scope?: Scope; id?: string }) {
  return (
    <div className="setting-row" id={id}>
      <div className="setting-text">
        <div className="setting-label">{label}{scope && <span className={`scope-tag scope-${scope}`}>{SCOPE_LABEL[scope]}</span>}</div>
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
