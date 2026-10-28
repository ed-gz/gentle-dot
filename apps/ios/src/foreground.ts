/** Keep the current turn alive while iOS suspends its WebView. Never start a
 * new inference, tool or approval behind another app. Aborting still settles. */
export async function waitForForeground(signal: AbortSignal, page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document): Promise<void> {
  signal.throwIfAborted();
  if (!page.hidden) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      page.removeEventListener('visibilitychange', visible);
      signal.removeEventListener('abort', cancel);
    };
    const visible = () => { if (!page.hidden) { cleanup(); resolve(); } };
    const cancel = () => { cleanup(); reject(signal.reason); };
    page.addEventListener('visibilitychange', visible);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else visible();
  });
  signal.throwIfAborted();
}
