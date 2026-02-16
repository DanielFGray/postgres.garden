export interface InitialDataUpdate {
  user: InitialDataUser | null;
}

type InitialDataListener = (update: InitialDataUpdate) => void;

const listeners = new Set<InitialDataListener>();

export function emitInitialDataUpdate(update: InitialDataUpdate): void {
  for (const listener of listeners) {
    listener(update);
  }
}

export function onInitialDataUpdate(
  listener: InitialDataListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
