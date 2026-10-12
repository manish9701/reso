import { useSyncExternalStore } from 'react';

export interface Settings {
  reduced: boolean;
  muted: boolean;
}

const _state: Settings = {
  reduced: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  muted: false,
};

// NOTE: the snapshot object is replaced (never mutated) so useSyncExternalStore
// subscribers reliably re-render on every toggle.
let state: Settings = _state;

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

export function getSettings(): Settings {
  return state;
}

export function toggleReduced() {
  state = { ...state, reduced: !state.reduced };
  emit();
}

export function toggleMuted() {
  state = { ...state, muted: !state.muted };
  emit();
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSettings,
  );
}
