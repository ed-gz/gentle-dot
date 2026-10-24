import { EDITOR_ACTIVITY_EVENT } from "./companion-activity.ts";
import { measureEditor } from "./editor-geometry.ts";

interface Editor {
	onChange?: (text: string) => void;
	handleInput(data: string): void;
	dispose?(): unknown;
}
interface Events {
	emit(channel: string, data: unknown): void;
	on(channel: string, callback: (data: unknown) => void): () => void;
}

/** Installed at editor construction, never by replacing a live editor or reading its draft. */
export function installEditorActivityBridge(editor: Editor, events: Events, sessionId: string) {
	const descriptor = Object.getOwnPropertyDescriptor(editor, "onChange");
	if (descriptor && (!descriptor.configurable || descriptor.get || descriptor.set)) return () => {};
	const input = editor.handleInput;
	const dispose = editor.dispose;
	let change = editor.onChange;
	let insideInput = 0;
	let lastChange = -Infinity;
	let live = true;
	const emit = (kind: "ready" | "changed" | "disposed") => {
		try {
			events.emit(EDITOR_ACTIVITY_EVENT, { sessionId, kind });
		} catch {
			/* Observation never changes editor behavior. */
		}
	};
	const wrap = (callback: Editor["onChange"]) =>
		function (this: Editor, ...args: [string]) {
			if (live && insideInput > 0 && Date.now() - lastChange >= 200) {
				lastChange = Date.now();
				emit("changed");
			}
			// Capture each assigned callback, so another extension can wrap the previous
			// onChange without creating a cycle through this accessor. Never inspect arguments.
			return callback?.apply(this, args);
		};
	let changed = wrap(change);
	const get = () => changed;
	Object.defineProperty(editor, "onChange", {
		configurable: true,
		enumerable: descriptor?.enumerable ?? true,
		get,
		set(value: Editor["onChange"]) {
			change = value;
			changed = wrap(value);
		},
	});
	const handleInput = function (this: Editor, ...args: [string]) {
		insideInput++;
		try {
			return input.apply(this, args);
		} finally {
			insideInput--;
		}
	};
	editor.handleInput = handleInput;
	const measure = () => {
		if (!live) return;
		try {
			events.emit(`${EDITOR_ACTIVITY_EVENT}:geometry`, { sessionId, geometry: measureEditor(editor) });
		} catch {
			/* Optional observer. */
		}
	};
	// The probe is already bounded by the focused-session activity poll; no extra timer/render.
	const unsubscribe = events.on(`${EDITOR_ACTIVITY_EVENT}:probe`, (value) => {
		if (
			live &&
			value !== null &&
			typeof value === "object" &&
			Reflect.get(value, "sessionId") === sessionId
		) {
			emit("ready");
			measure();
		}
	});
	const close = () => {
		if (!live) return;
		live = false;
		unsubscribe();
		if (editor.handleInput === handleInput) editor.handleInput = input;
		if (Object.getOwnPropertyDescriptor(editor, "onChange")?.get === get)
			Object.defineProperty(editor, "onChange", {
				configurable: true,
				enumerable: descriptor?.enumerable ?? true,
				writable: true,
				value: change,
			});
		if (editor.dispose === wrappedDispose) editor.dispose = dispose;
		emit("disposed");
	};
	const wrappedDispose = function (this: Editor) {
		close();
		return dispose?.call(this);
	};
	editor.dispose = wrappedDispose;
	emit("ready");
	return close;
}
