// Experiment only: run the existing TUI adapter against a real RPC UI. This is not
// installed by the daemon and must not be used as a production RPC adapter.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDotSession } from "../../src/extensions/dot-session.ts";

export default function probe(pi: ExtensionAPI) {
	const shim = new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "on") return Reflect.get(target, property, receiver);
			return (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) =>
				target.on(name as never, ((event: unknown, ctx: ExtensionContext) => {
					if (name !== "session_start") return callback(event, ctx);
					const tuiView = new Proxy(ctx, { get: (obj, key, recv) => key === "mode" ? "tui" : Reflect.get(obj, key, recv) });
					return callback(event, tuiView);
				}) as never);
		},
	});
	createDotSession(shim);
	pi.on("session_start", async (_event, ctx) => {
		// The first real RPC dialog is resolved through the guarded consumer.
		setTimeout(async () => {
			const result = await ctx.ui.confirm("First", "Original details");
			ctx.ui.notify(`probe-confirm:${result}`);
			const legacy = await ctx.ui.confirm("Second", "Legacy desktop");
			ctx.ui.notify(`probe-legacy:${legacy}`);
			const sessionId = ctx.sessionManager.getSessionId();
			const emit = (text: string) => pi.events.emit("herdr-connect:question:request", {
				sessionId, id: "same-id", questions: [{ id: "one", question: text, multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
			});
			emit("original");
			// The test triggers the replacement after reading the first snapshot.
			void ctx.ui.input("Replace probe question").then(() => {
				pi.events.emit("herdr-connect:question:closed", { sessionId, id: "same-id" });
				emit("changed");
			});
			pi.events.on("herdr-connect:question:answer", (value: unknown) => {
				if (typeof value === "object" && value !== null) Reflect.set(value, "accepted", true);
				ctx.ui.notify("probe-questionnaire-consumed");
			});
		}, 500);
	});
}
