import { useEffect, useRef, type ReactNode } from 'react';
import { IconX } from './Icons';

export function Modal({ title, onClose, children, width = 560, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} tabIndex={-1}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconX size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
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

export function Segmented<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup">
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
