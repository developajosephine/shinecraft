// Tiny toast store: toast('Saved') from anywhere, <Toasts /> renders them.
export interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'bad' | 'info';
}

let items: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, tone: ToastItem['tone'] = 'ok'): void {
  const item = { id: ++nextId, text, tone };
  items = [...items, item];
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== item.id);
    emit();
  }, 2800);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const currentToasts = () => items;
