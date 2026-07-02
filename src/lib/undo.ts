// Superhuman-style Z undo: every triage action (and each pending send)
// pushes its inverse. Entries own their side effects and toasts.

export interface UndoEntry {
  label: string;
  run: () => Promise<void>;
  /** Optional deadline (ms epoch) — e.g. the Undo Send window. */
  expiresAt?: number;
}

const stack: UndoEntry[] = [];

export function pushUndo(entry: UndoEntry) {
  stack.push(entry);
  if (stack.length > 30) stack.shift();
}

/** Runs the most recent live entry. Returns false when there's nothing left. */
export async function popUndo(): Promise<boolean> {
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.expiresAt && Date.now() > entry.expiresAt) continue;
    await entry.run();
    return true;
  }
  return false;
}
