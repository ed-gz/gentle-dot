import { useState } from "react";
import { useAttachmentPreview } from "../attachment-preview.ts";
import { formatSize } from "../uploads.ts";
import type { PendingFile } from "../useAttachments.ts";
import { PaperclipIcon } from "./icons.tsx";
import { AttachmentPreview } from "./AttachmentPreview.tsx";
import "../attachments.css";

export function AttachmentChip({ file, locked, remove, removeLabel = "Quitar" }: {
 file: PendingFile;
 locked: boolean;
 remove(): void;
 removeLabel?: string | undefined;
}) {
 const name = file.file.name;
 const url = useAttachmentPreview(file.file);
 const [failedUrl, setFailedUrl] = useState<string>();
 const thumbnail = url && url !== failedUrl;
 const problem = file.refused ?? file.error;
 return <li className={`attachment-chip attachment-draft${thumbnail ? " attachment-image" : ""}${problem ? " attachment-chip-error" : ""}`}>
  {thumbnail ? <>
   <AttachmentPreview key={url} url={url} name={name} onError={() => setFailedUrl(url)} />
   <span className="visually-hidden" aria-hidden="true">{name}</span>
  </> : <>
   <span className="attachment-file-icon" aria-hidden="true"><PaperclipIcon /></span>
   <span className="chip-name" title={name}>{name}</span>
   <span className="chip-size">{formatSize(file.file.size)}</span>
  </>}
  <button type="button" className="chip-remove" aria-label={`${removeLabel} ${name}`} disabled={locked} onClick={remove}>×</button>
  {file.progress !== undefined ? <progress className="chip-progress" aria-label={`Uploading ${name}`} max={1} value={file.progress} /> : null}
  {problem ? <span className="chip-error" role="alert">{problem}</span> : null}
 </li>;
}
