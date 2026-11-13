import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { JobStatus } from '@washlog/shared';
import type { LocalRecord } from './db';
import { STATUS_LABEL } from './labels';
import { currentToasts, subscribeToasts } from './toast';

const ICONS = {
  car: ['M5 11l1.6-4.6A2 2 0 0 1 8.5 5h7a2 2 0 0 1 1.9 1.4L19 11', 'M3 11h18v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M7 17v2', 'M17 17v2', 'M7 14h.01', 'M17 14h.01'],
  box: ['M21 8l-9-5-9 5v8l9 5 9-5z', 'M3 8l9 5 9-5', 'M12 13v8'],
  sync: ['M20 11a8 8 0 0 0-14.9-3', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.9 3', 'M20 20v-4h-4'],
  alert: ['M12 3l10 18H2z', 'M12 10v5', 'M12 18h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  check: ['M5 12l5 5 9-10'],
  chevron: ['M9 6l6 6-6 6'],
  back: ['M15 6l-6 6 6 6'],
  offline: ['M3 3l18 18', 'M8.5 16.5a5 5 0 0 1 7 0', 'M5 13a10 10 0 0 1 4-2.6', 'M19 13a10 10 0 0 0-3-2.2', 'M12 20h.01'],
  cloud: ['M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9.5a4.3 4.3 0 0 1-.5 8.5z', 'M9.5 13.5l2 2 3.5-4'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  bug: ['M8 9a4 4 0 0 1 8 0v7a4 4 0 0 1-8 0z', 'M4 13h4', 'M16 13h4', 'M5 7l3 3', 'M19 7l-3 3', 'M5 20l3-3', 'M19 20l-3-3'],
  drop: ['M12 3c-4 5-6 8-6 11a6 6 0 0 0 12 0c0-3-2-6-6-11z'],
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function StatusChip({ status }: { status: JobStatus }) {
  return <span className={`chip st-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function SyncBadge({ record, conflicted }: { record: LocalRecord; conflicted: boolean }) {
  const state = record.pending ? 'pending' : conflicted ? 'conflict' : 'synced';
  const label = { pending: 'Not synced yet', conflict: 'Had a conflict', synced: 'Synced' }[state];
  return (
    <span className={`badge ${state}`}>
      <Icon name={state === 'synced' ? 'check' : state === 'pending' ? 'clock' : 'alert'} size={13} />
      {label}
    </span>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Tap-to-select tiles: faster than a dropdown when there are only a handful of options. */
export function Tiles<T extends string>(props: {
  label: string;
  options: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <fieldset className="tiles">
      <legend>{props.label}</legend>
      <div className="tile-grid" style={{ gridTemplateColumns: `repeat(${props.columns ?? props.options.length}, 1fr)` }}>
        {props.options.map((o) => (
          <button
            type="button"
            key={o.value}
            className={`tile ${o.value === props.value ? 'on' : ''}`}
            aria-pressed={o.value === props.value}
            onClick={() => props.onChange(o.value)}
          >
            <span>{o.label}</span>
            {o.hint && <small>{o.hint}</small>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Bottom sheet dialog. Closes on Escape or a tap outside. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, currentToasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <Icon name={t.tone === 'bad' ? 'alert' : 'check'} size={16} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
