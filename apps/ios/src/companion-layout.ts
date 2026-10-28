/** Bounds use the rendered hit target, not the source texture or a CSS scale. */
export function companionBounds(stage: { width: number; height: number }, rig: { width: number; height: number }, inset = 4) {
  return { x: Math.max(0, (stage.width - rig.width) / 2 - inset), y: Math.max(0, (stage.height - rig.height) / 2 - inset) };
}
export function constrainCompanion(position: { x: number; y: number }, bounds: { x: number; y: number }) {
  return { x: Math.max(-bounds.x, Math.min(bounds.x, position.x)), y: Math.max(-bounds.y, Math.min(bounds.y, position.y)) };
}
/** Pin only the unzoomed visual viewport. Pinch zoom keeps the document navigable. */
export function mountPhoneViewport(composer: HTMLElement) {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  function updateText() { root.dataset.largeText = String(parseFloat(getComputedStyle(root).fontSize) >= 22); }
  function update() {
    updateText();
    if (!viewport || Math.abs(viewport.scale - 1) > .02) {
      root.style.removeProperty('--app-height'); root.style.removeProperty('--app-offset-top'); root.dataset.keyboard = 'false'; return;
    }
    root.style.setProperty('--app-height', `${viewport.height}px`);
    // iOS may pan the visual viewport as well as resize it for the keyboard.
    // Keep the shell within that visible rectangle even if WKWebView scrolls the page.
    root.style.setProperty('--app-offset-top', `${Math.max(0, viewport.pageTop)}px`);
    root.dataset.keyboard = String(window.innerHeight - viewport.height > 120);
  }
  let layoutFrame = 0;
  const composerSize = new ResizeObserver(() => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => { updateText(); root.style.setProperty('--composer-height', `${composer.offsetHeight + 8}px`); });
  });
  composerSize.observe(composer);
  const header = document.querySelector('.masthead'); if (header) composerSize.observe(header);
  viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update); window.addEventListener('scroll', update); update();
  return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); window.removeEventListener('scroll', update); composerSize.disconnect(); cancelAnimationFrame(layoutFrame); };
}
