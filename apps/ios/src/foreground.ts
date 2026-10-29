import { appForegroundPage, type createForegroundPage } from './foreground-page.ts';

/** Keep the current turn alive while iOS suspends its WebView. Never start a
 * new inference, tool or approval behind another app. Aborting still settles. */
export async function waitForForeground(signal: AbortSignal, page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document,
  gate: Pick<ReturnType<typeof createForegroundPage>, 'isSuspended' | 'subscribe'> | undefined = typeof document !== 'undefined' && page === document ? appForegroundPage : undefined): Promise<void> {
  signal.throwIfAborted();
  const active = () => !page.hidden && !gate?.isSuspended();
  if (active()) return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const cleanup = () => {
      page.removeEventListener('visibilitychange', visible);
      signal.removeEventListener('abort', cancel);
      unsubscribe();
    };
    const visible = () => { if (active()) { cleanup(); resolve(); } };
    const cancel = () => { cleanup(); reject(signal.reason); };
    page.addEventListener('visibilitychange', visible);
    unsubscribe = gate?.subscribe(visible) ?? unsubscribe;
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else visible();
  });
  signal.throwIfAborted();
}
