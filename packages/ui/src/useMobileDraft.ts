import { useCallback, useEffect, useRef, useState } from "react";
import { type MobileDraftSnapshot, mobileBridge } from "./mobile.ts";

interface DraftSession {
	key: string;
	text: string;
	revision: number;
	savedRevision: number;
	queuedRevision: number;
	storageRevision?: string;
	writeEpoch: number;
	restoreEpoch: number;
	conflict: boolean;
	live: boolean;
	queue: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	flush(): void;
}

function validSnapshot(value: MobileDraftSnapshot): boolean {
	return (
		!!value &&
		typeof value.text === "string" &&
		value.text.length <= 65_536 &&
		typeof value.revision === "string" &&
		value.revision.length > 0 &&
		value.revision.length <= 128
	);
}

/** Native-only text recovery. Never stores a draft in web localStorage or sends it to an agent. */
export function useMobileDraft(key?: string) {
	const bridge = mobileBridge();
	const read = bridge?.readDraft;
	const write = bridge?.saveDraft;
	const enabled = !!key && !!read && !!write;
	const active = useRef<DraftSession | undefined>(undefined);
	const [value, setValue] = useState({ key: "", text: "" });
	const [note, setNote] = useState<string>();
	useEffect(() => {
		if (!enabled || !key || !read || !write) return;
		const session: DraftSession = {
			key,
			text: "",
			revision: 0,
			savedRevision: 0,
			queuedRevision: -1,
			writeEpoch: 0,
			restoreEpoch: 0,
			conflict: false,
			live: true,
			queue: Promise.resolve(),
			flush: () => {},
		};
		active.current = session;
		setValue({ key, text: "" });
		setNote(undefined);
		const current = () => session.live && active.current === session;
		const snapshot = async () => {
			const result = await read(key);
			if (!validSnapshot(result)) throw new Error("Invalid draft");
			return result;
		};
		const adopt = (restored: MobileDraftSnapshot) => {
			session.storageRevision = restored.revision;
			session.text = restored.text;
			session.savedRevision = session.revision;
			session.conflict = false;
			if (current()) {
				setValue({ key, text: session.text });
				setNote(undefined);
			}
		};
		// A first edit may arrive before the encrypted read. Keep that edit, but wait
		// for the native revision before attempting its compare-and-set save.
		session.queue = snapshot().then(
			(restored) => {
				session.storageRevision = restored.revision;
				if (session.revision === 0) adopt(restored);
			},
			() => {
				if (current()) setNote("No se pudo recuperar el borrador guardado en este dispositivo.");
			},
		);
		session.flush = () => {
			clearTimeout(session.timer);
			if (
				session.conflict ||
				session.revision === session.savedRevision ||
				session.revision === session.queuedRevision
			)
				return;
			const revision = session.revision,
				text = session.text,
				epoch = session.writeEpoch;
			session.queuedRevision = revision;
			// JS serialization preserves this editor's order; native CAS also protects
			// against the independent editor in the other Android WebView.
			session.queue = session.queue
				.catch(() => {})
				.then(async () => {
					if (epoch !== session.writeEpoch) return;
					try {
						if (session.storageRevision === undefined) session.storageRevision = (await snapshot()).revision;
						const result = await write(key, text, session.storageRevision);
						if (!validSnapshot(result) || typeof result.applied !== "boolean")
							throw new Error("Invalid draft save");
						session.storageRevision = result.revision;
						if (result.applied) {
							session.savedRevision = revision;
							if (current()) setNote(undefined);
						} else {
							// Do not retry queued edits/clears against a newer draft: that could
							// erase text written in the other WebView or resurrect a sent draft.
							session.writeEpoch++;
							session.queuedRevision = -1;
							session.conflict = session.text !== result.text;
							if (!session.conflict) session.savedRevision = session.revision;
							if (current() && session.conflict)
								setNote(
									"El borrador cambió en la otra ventana. Tu texto sigue aquí; vuelve a editarlo para guardarlo.",
								);
						}
					} catch {
						if (session.queuedRevision === revision) session.queuedRevision = -1;
						if (current())
							setNote(
								"No se pudo guardar este borrador en el dispositivo. Sigue disponible mientras la app esté abierta.",
							);
					}
				});
		};
		const restore = async () => {
			const revision = session.revision,
				epoch = ++session.restoreEpoch;
			// A pause save may still be pending when this Activity resumes. Wait for
			// it instead of skipping recovery forever. New typing always wins a read.
			await session.queue;
			if (!current() || session.revision !== revision || epoch !== session.restoreEpoch) return;
			// A conflicting nonempty edit exists only in this WebView. Keep it and
			// the conflict notice until the user edits again; recovery must not lose it.
			if (session.revision !== session.savedRevision && (!session.conflict || session.text)) return;
			try {
				const restored = await snapshot();
				if (!current() || session.revision !== revision || epoch !== session.restoreEpoch) return;
				adopt(restored);
			} catch {
				if (current() && session.revision === revision && epoch === session.restoreEpoch)
					setNote("No se pudo recuperar el borrador guardado en este dispositivo.");
			}
		};
		const visibility = () => {
			if (document.hidden) session.flush();
			else void restore();
		};
		window.addEventListener("pagehide", session.flush);
		window.addEventListener("gentledot-pause", session.flush);
		window.addEventListener("gentledot-resume", restore);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			session.live = false;
			session.flush();
			clearTimeout(session.timer);
			window.removeEventListener("pagehide", session.flush);
			window.removeEventListener("gentledot-pause", session.flush);
			window.removeEventListener("gentledot-resume", restore);
			document.removeEventListener("visibilitychange", visibility);
			if (active.current === session) active.current = undefined;
		};
	}, [enabled, key, read, write]);
	const onText = useCallback(
		(text: string) => {
			const session = active.current;
			if (!session || session.key !== key) return;
			session.text = text;
			session.revision++;
			// Composer also clears after an accepted Send. That clear must not erase
			// a conflicting draft that belongs to the other WebView.
			if (text) session.conflict = false;
			setValue({ key: session.key, text });
			clearTimeout(session.timer);
			if (!text) session.flush();
			else session.timer = setTimeout(session.flush, 300);
		},
		[key],
	);
	return enabled ? { text: value.key === key ? value.text : "", onText, note } : undefined;
}
