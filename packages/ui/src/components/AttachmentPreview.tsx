import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageViewer } from "./ImageViewer.tsx";
import "../shared-files.css";

/** Reuse the shared-files viewer without downloading or uploading a draft. */
export function AttachmentPreview({ url, name, onError }: { url: string; name: string; onError(): void }) {
 const [expanded, setExpanded] = useState(false);
 const trigger = useRef<HTMLButtonElement>(null);
 const close = useCallback(() => setExpanded(false), []);
 const restoreFocus = useCallback(() => trigger.current?.focus({ preventScroll: true }), []);
 return <>
  <button ref={trigger} type="button" className="attachment-thumbnail" aria-label={`Ver ${name}`} onClick={() => setExpanded(true)}>
   <img src={url} alt={name} width={64} height={64} onError={onError} />
  </button>
  {expanded ? createPortal(<ImageViewer url={url} name={name} close={close} restoreFocus={restoreFocus} />, trigger.current?.closest(".chat") ?? document.body) : null}
 </>;
}
