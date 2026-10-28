import { ATTACHMENT_LIMITS, type AttachmentRef, type UploadedFile } from "@gentle-dot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatSize, type Uploader } from "./uploads.ts";

/** A file the user attached to the message they are writing. */
export interface PendingFile {
	id: string;
	file: File;
	/** Uploading: 0 to 1. */
	progress?: number;
	uploaded?: UploadedFile;
	/** It cannot be sent (over a limit); the user removes it. */
	refused?: string;
	/** The last upload failed; sending again retries it. */
	error?: string;
}

export interface AttachmentDraftStore {
	load(): Promise<File[]>;
	save(files: File[]): Promise<void>;
}

export interface AttachmentControls {
	files: PendingFile[];
	uploading: boolean;
	add(files: File[]): void;
	remove(id: string): void;
	/** Uploads what is not uploaded yet, one message folder for all; undefined when one failed. */
	upload(): Promise<AttachmentRef[] | undefined>;
	clear(): void;
	saving?: boolean;
	storageNote?: string;
	storageError?: string;
	retrySave?(): void;
}

let nextId = 0;

/** The files of the message being written (S31.1); undefined without an uploader. */
export function useAttachments(uploader?: Uploader, store?: AttachmentDraftStore): AttachmentControls | undefined {
	const [files, setFiles] = useState<PendingFile[]>([]);
	const [uploading, setUploading] = useState(false);
	const current = useRef(files);
	const live = useRef(true);
	const ready = useRef(!store);
	const writes = useRef(0);
	const sequence = useRef(0);
	const generation = useRef(0);
	const restoration = useRef(0);
	const [saving, setSaving] = useState(Boolean(store));
	const [storageNote, setStorageNote] = useState("");
	const [storageError, setStorageError] = useState("");
	const errorNow = useRef("");
	const replace = useCallback((next: PendingFile[]) => {
		current.current = next;
		if (live.current) setFiles(next);
	}, []);
	const restore = useCallback(async () => {
		if (!store) return;
		const attempt = ++restoration.current;
		const active = () => live.current && attempt === restoration.current;
		ready.current = false;
		setSaving(true);
		try {
			const restored = await store.load();
			if (!active()) return;
			replace(restored.map(file => ({ id: `a${++nextId}`, file })));
			ready.current = true; errorNow.current = ""; setStorageError("");
			setStorageNote(restored.length ? "Adjuntos recuperados. Revisa el historial." : "");
		} catch (error) {
			if (active()) { errorNow.current = (error as Error).message; setStorageError(errorNow.current); }
		} finally { if (active()) setSaving(false); }
	}, [store, replace]);
	useEffect(() => {
		live.current = true;
		generation.current++; writes.current = 0; ready.current = !store;
		errorNow.current = ""; setStorageError(""); setStorageNote("");
		setSaving(Boolean(store)); replace([]);
		void restore();
		return () => { live.current = false; restoration.current++; generation.current++; };
	}, [restore, replace, store]);
	const persist = useCallback((next: PendingFile[]) => {
		if (!store) return;
		const owner = generation.current;
		const active = () => live.current && owner === generation.current;
		const attempt = ++sequence.current;
		writes.current++; setSaving(true); setStorageNote("Guardando adjuntos en el iPhone…");
		void store.save(next.filter(file => !file.refused).map(file => file.file)).then(() => {
			if (active() && attempt === sequence.current) {
				errorNow.current = ""; setStorageError("");
				setStorageNote(next.length ? "Adjuntos guardados en el iPhone." : "");
			}
		}, error => {
			if (active() && attempt === sequence.current) {
				errorNow.current = error.message || "No se guardaron los adjuntos.";
				setStorageError(errorNow.current); setStorageNote("");
			}
		}).finally(() => { if (active()) { writes.current--; setSaving(writes.current > 0); } });
	}, [store]);

	const update = useCallback((id: string, change: (file: PendingFile) => PendingFile) => {
		replace(current.current.map((f) => (f.id === id ? change(f) : f)));
	}, [replace]);

	const add = useCallback((added: File[]) => {
		if (!ready.current) return;
		const next = [...current.current];
		for (const file of added) {
			const kept = next.filter((f) => !f.refused);
			const bytes = kept.reduce((sum, f) => sum + f.file.size, 0);
			const item: PendingFile = { id: `a${++nextId}`, file };
			if (kept.length >= ATTACHMENT_LIMITS.files) {
				item.refused = `Too many files: up to ${ATTACHMENT_LIMITS.files} files per message.`;
			} else if (file.size > ATTACHMENT_LIMITS.fileBytes) {
				item.refused = `Too large: up to ${formatSize(ATTACHMENT_LIMITS.fileBytes)} per file.`;
			} else if (bytes + file.size > ATTACHMENT_LIMITS.messageBytes) {
				item.refused = `Too large together: up to ${formatSize(ATTACHMENT_LIMITS.messageBytes)} per message.`;
			}
			next.push(item);
		}
		replace(next); persist(next);
	}, [replace, persist]);

	const remove = useCallback((id: string) => {
		if (!ready.current) return;
		const next = current.current.filter((f) => f.id !== id);
		replace(next); persist(next);
	}, [replace, persist]);

	const clear = useCallback(() => {
		if (!ready.current) return;
		replace([]); persist([]);
	}, [replace, persist]);
	const retrySave = useCallback(() => { if (ready.current) persist(current.current); else void restore(); }, [persist, restore]);

	const upload = useCallback(async (): Promise<AttachmentRef[] | undefined> => {
		if (!uploader || !ready.current || writes.current || errorNow.current) return undefined;
		const list = current.current;
		if (list.some((f) => f.refused)) return undefined;
		setUploading(true);
		let uploadId = list.find((f) => f.uploaded)?.uploaded?.uploadId;
		const refs: AttachmentRef[] = [];
		let failed = false;
		try {
			for (const item of list) {
				let done = item.uploaded;
				if (!done) {
					update(item.id, ({ error: _error, ...f }) => ({ ...f, progress: 0 }));
					try {
						done = await uploader(item.file, {
							...(uploadId ? { uploadId } : {}),
							onProgress: (progress) => update(item.id, (f) => ({ ...f, progress })),
						});
						const uploaded = done;
						update(item.id, ({ progress: _progress, ...f }) => ({ ...f, uploaded }));
					} catch (error) {
						failed = true;
						const message = (error as Error).message || "The upload did not work.";
						update(item.id, ({ progress: _progress, ...f }) => ({ ...f, error: message }));
						continue;
					}
				}
				uploadId ??= done.uploadId;
				refs.push({ uploadId: done.uploadId, name: done.name });
			}
		} finally {
			setUploading(false);
		}
		return failed ? undefined : refs;
	}, [uploader, update]);

	return useMemo(
		() => (uploader ? { files, uploading, add, remove, upload, clear, ...(store ? { saving, storageNote, storageError, retrySave } : {}) } : undefined),
		[uploader, files, uploading, add, remove, upload, clear, store, saving, storageNote, storageError, retrySave],
	);
}
