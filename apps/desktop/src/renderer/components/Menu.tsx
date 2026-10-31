import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { IconCheck } from './Icons';

// Anchored popovers for the composer and header. They hold no state of their own beyond open/closed:
// every item acts through the store, and an unavailable item stays focusable so its reason can be read.

const ITEMS = '[role="menuitem"], [role="menuitemradio"]';

export interface TriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'menu' | 'dialog';
  'aria-controls'?: string;
}

export function Popover({ label, role = 'menu', placement = 'bottom-start', className, trigger, children }: {
  label: string; role?: 'menu' | 'dialog'; placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'; className?: string;
  trigger: (props: TriggerProps) => ReactNode; children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => { setOpen(false); button.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const root = panel.current;
    const first = root?.querySelector<HTMLElement>('[aria-checked="true"]') ?? root?.querySelector<HTMLElement>(`${ITEMS}, input, button`);
    first?.focus();
    const outside = (event: MouseEvent): void => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab' && role === 'menu') { setOpen(false); return; }
    if (role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <span className="popover-anchor" ref={anchor}>
      {trigger({
        ref: button, onClick: () => setOpen(value => !value), 'aria-expanded': open, 'aria-haspopup': role, ...(open ? { 'aria-controls': id } : {}),
        onKeyDown: event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } },
      })}
      {open && (
        <div id={id} ref={panel} role={role} aria-label={label} className={`popover popover-${placement}${className ? ` ${className}` : ''}`} onKeyDown={onPanelKey}>
          {children(close)}
        </div>
      )}
    </span>
  );
}

/** One row of a menu. `unavailable` keeps it focusable and announced, with the reason as its hint. */
export function MenuItem({ icon, label, hint, checked, unavailable, badge, onSelect }: {
  icon?: ReactNode; label: ReactNode; hint?: ReactNode; checked?: boolean; unavailable?: boolean; badge?: ReactNode; onSelect?: () => void;
}) {
  return (
    <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked} aria-disabled={unavailable || undefined}
      tabIndex={-1} className={`menu-item${unavailable ? ' is-unavailable' : ''}${checked ? ' is-checked' : ''}`}
      onClick={() => { if (!unavailable) onSelect?.(); }}>
      {icon && <span className="menu-item-icon">{icon}</span>}
      <span className="menu-item-text">
        <span className="menu-item-label">{label}</span>
        {hint && <span className="menu-item-hint">{hint}</span>}
      </span>
      {badge}
      {checked !== undefined && <span className="menu-item-check">{checked && <IconCheck size={14} />}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu-label" role="presentation">{children}</div>;
}
export function MenuSeparator() { return <div className="menu-sep" role="separator" />; }
