/** Coordinate WebKit's page and visibility events. Either can arrive first;
 * a single suspension produces one foreground recovery after both gates open. */
export function createForegroundPage() {
  let suspended = false, pending = false, suppressDuplicate = false;
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    isSuspended: () => suspended,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pagehide() { suspended = true; pending = true; suppressDuplicate = false; changed(); },
    pageshow(persisted: boolean, hidden: boolean): boolean {
      // A non-cached page that was hidden is unloading. A new document owns
      // its own coordinator; do not revive this one on a stray event.
      if (suspended && !persisted) { changed(); return false; }
      suspended = false;
      const resume = persisted && !hidden && pending;
      if (resume) { pending = false; suppressDuplicate = true; }
      changed(); return resume;
    },
    visibility(hidden: boolean): boolean {
      if (hidden) { pending = true; suppressDuplicate = false; changed(); return false; }
      if (suspended) { changed(); return false; }
      if (pending) { pending = false; suppressDuplicate = false; changed(); return true; }
      if (suppressDuplicate) { suppressDuplicate = false; changed(); return false; }
      // Preserve explicit refresh events when there was no pagehide cycle.
      changed();
      return true;
    },
  };
}

/** Shared by the app renderer and the local agent's foreground fence. */
export const appForegroundPage = createForegroundPage();
