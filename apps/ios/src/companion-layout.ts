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
  let focusFrame = 0;
  function revealComposerFocus() {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (root.dataset.keyboard !== 'true' || !(focused instanceof HTMLElement) || !composer.contains(focused)) return;
      // Reveal the scrolling voice region as a whole; a long button inside it
      // may exceed the viewport and must not push the region behind the clip.
      const voice = focused.closest<HTMLElement>('.voice-context');
      if (voice) {
        const region = voice.getBoundingClientRect(), button = focused.getBoundingClientRect();
        if (button.height > region.height || button.top < region.top) voice.scrollTop += button.top - region.top;
        else if (button.bottom > region.bottom - 1) voice.scrollTop += button.bottom - region.bottom + 1;
      }
      const visible = voice ?? focused;
      const bounds = composer.getBoundingClientRect(), target = visible.getBoundingClientRect();
      if (target.bottom > bounds.bottom) composer.scrollTop += target.bottom - bounds.bottom;
      else if (target.top < bounds.top) composer.scrollTop -= bounds.top - target.top;
    });
  }
  function update() {
    updateText();
    if (!viewport || Math.abs(viewport.scale - 1) > .02) {
      root.style.removeProperty('--app-height'); root.style.removeProperty('--app-offset-top'); root.dataset.keyboard = 'false'; return;
    }
    root.style.setProperty('--app-height', `${viewport.height}px`);
    // iOS may pan the visual viewport as well as resize it for the keyboard.
    // Keep the shell within that visible rectangle even if WKWebView scrolls the page.
    root.style.setProperty('--app-offset-top', `${Math.max(0, viewport.pageTop)}px`);
    const focused = document.activeElement;
    const editing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable);
    const threshold = editing && window.innerWidth > window.innerHeight ? Math.min(120, window.innerHeight * .2) : 120;
    root.dataset.keyboard = String(window.innerHeight - viewport.height > threshold);
    revealComposerFocus();
  }
  let layoutFrame = 0;
  const composerSize = new ResizeObserver(() => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => { updateText(); root.style.setProperty('--composer-height', `${composer.offsetHeight + 8}px`); revealComposerFocus(); });
  });
  composer.addEventListener('focusin', revealComposerFocus);
  composerSize.observe(composer);
  const header = document.querySelector('.masthead'); if (header) composerSize.observe(header);
  viewport?.addEventListener('resize', update); viewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update); window.addEventListener('scroll', update); update();
  return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); window.removeEventListener('resize', update); window.removeEventListener('scroll', update); composer.removeEventListener('focusin', revealComposerFocus); composerSize.disconnect(); cancelAnimationFrame(layoutFrame); cancelAnimationFrame(focusFrame); };
}
