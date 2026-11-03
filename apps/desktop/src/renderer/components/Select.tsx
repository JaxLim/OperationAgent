import { useState } from 'react';
import type { ReactNode } from 'react';
import { MenuItem, Popover } from './Menu';
import { IconChevronDown, IconSearch } from './Icons';

export interface SelectOption<T extends string> { value: T; label: string; icon?: ReactNode; hint?: string; keywords?: string }

/** A dropdown whose list can be filtered by typing; arrow keys move from the search box into the list. */
export function SearchSelect<T extends string>({ label, value, options, onChange, searchPlaceholder, empty, disabled }: {
  label: string; value: T; options: readonly SelectOption<T>[]; onChange: (value: T) => void; searchPlaceholder: string; empty: string; disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const current = options.find(option => option.value === value);
  const q = query.trim().toLowerCase();
  const shown = options.filter(option => !q || `${option.label} ${option.keywords ?? ''}`.toLowerCase().includes(q));
  return (
    <Popover label={label} placement="bottom-start" className="popover-select" trigger={props => (
      <button {...props} type="button" className="select-trigger" aria-label={`${label}: ${current?.label ?? value}`} disabled={disabled}
        onClick={() => { setQuery(''); props.onClick(); }}>
        {current?.icon}<span className="ellipsis">{current?.label ?? value}</span><IconChevronDown size={13} />
      </button>
    )}>
      {close => (
        <>
          <label className="select-search">
            <IconSearch size={14} />
            <input data-autofocus value={query} placeholder={searchPlaceholder} aria-label={searchPlaceholder} onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && shown[0]) { event.preventDefault(); onChange(shown[0].value); close(); }
              }} />
          </label>
          <div className="select-list">
            {shown.map(option => (
              <MenuItem key={option.value} checked={option.value === value} icon={option.icon} label={option.label} hint={option.hint}
                onSelect={() => { onChange(option.value); close(); }} />
            ))}
            {shown.length === 0 && <div className="select-empty">{empty}</div>}
          </div>
        </>
      )}
    </Popover>
  );
}
