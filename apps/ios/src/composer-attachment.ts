type Item = { id: string; title: string; files: { id: string; name: string; type: string; size: number }[] };

export function mountComposerAttachment(root: HTMLElement, io: { read: (workId: string, fileId: string) => Promise<Blob | undefined> }) {
  let epoch = 0, thumbnailURL: string | undefined, dialogURL: string | undefined;
  let remove = () => {};
  const dialog = document.createElement('dialog');
  dialog.className = 'attachment-dialog'; dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Foto adjunta');
  const enlarged = document.createElement('img'); enlarged.alt = 'Foto adjunta ampliada';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cerrar';
  const discard = document.createElement('button'); discard.type = 'button'; discard.textContent = 'Quitar del mensaje';
  dialog.append(enlarged, close, discard); document.body.append(dialog);
  function releaseDialog() { if (dialogURL) URL.revokeObjectURL(dialogURL); dialogURL = undefined; enlarged.removeAttribute('src'); }
  dialog.addEventListener('cancel', releaseDialog);
  close.addEventListener('click', () => { releaseDialog(); dialog.close(); });
  discard.addEventListener('click', () => { releaseDialog(); dialog.close(); remove(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === close) { event.preventDefault(); discard.focus(); }
    else if (!event.shiftKey && document.activeElement === discard) { event.preventDefault(); close.focus(); }
  });
  function show(item: Item | undefined) {
    const current = ++epoch;
    if (dialog.open) dialog.close();
    releaseDialog();
    if (thumbnailURL) URL.revokeObjectURL(thumbnailURL);
    thumbnailURL = undefined; root.replaceChildren();
    if (!item) return;
    const file = item.files.find(value => value.type.startsWith('image/'));
    const removeButton = document.createElement('button'); removeButton.type = 'button'; removeButton.textContent = 'Quitar';
    removeButton.setAttribute('aria-label', file ? 'Quitar la foto del mensaje' : 'Quitar el material del mensaje');
    removeButton.addEventListener('click', () => remove());
    root.append(removeButton);
    if (!file) return;
    void io.read(item.id, file.id).then(blob => {
      if (!blob || current !== epoch) return;
      const typed = blob.type ? blob : new Blob([blob], { type: file.type });
      thumbnailURL = URL.createObjectURL(typed);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'attachment-thumbnail'; button.setAttribute('aria-label', 'Ampliar foto adjunta');
      const img = document.createElement('img'); img.src = thumbnailURL; img.alt = 'Foto adjunta'; button.append(img); root.prepend(button);
      button.addEventListener('click', () => { dialogURL = URL.createObjectURL(typed); enlarged.src = dialogURL; dialog.showModal(); close.focus(); });
    }).catch(() => {});
  }
  return { show, onRemove(cb: () => void) { remove = cb; } };
}
