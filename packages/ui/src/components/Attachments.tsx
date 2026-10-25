import type { PendingFile } from "../useAttachments.ts";
import { AttachmentChip } from "./AttachmentChip.tsx";

/** The composer owns removal; each keyed chip owns its local preview lifetime. */
export function Attachments({ files, locked, remove, removeLabel }: {
 files: PendingFile[];
 locked: boolean;
 remove(id: string): void;
 removeLabel?: string | undefined;
}) {
 if (!files.length) return null;
 return <ul className="attachment-chips attachment-preview-row" aria-label="Files to send">
  {files.map((file) => <AttachmentChip key={file.id} file={file} locked={locked} remove={() => remove(file.id)} removeLabel={removeLabel} />)}
 </ul>;
}
