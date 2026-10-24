import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LIVE_INPUT_STATUS = "gentle-dot-live-input";
export const LIVE_INPUT_WAKE = "gentle-dot-live-input-wake";

/**
 * The supervisor invokes this command only AFTER Pi acknowledges a human RPC
 * steer as queued. Keep that native queue: it owns message order and images.
 * Interrupt only inference, never a tool batch or an approval dialog.
 */
export function registerLiveInput(pi: ExtensionAPI): void {
	let inference = false;
	let toolBatch = false;
	let promptOpen = false;
	let generation = 0;
	let handoff: { generation: number } | undefined;
	const tools = new Set<string>();
	const cancel = (ctx: ExtensionContext) => {
		generation++;
		handoff = undefined;
		ctx.ui.setStatus(LIVE_INPUT_STATUS, undefined);
	};
	const reset = (_event: unknown, ctx: ExtensionContext) => {
		cancel(ctx);
		inference = false;
		toolBatch = false;
		promptOpen = false;
		tools.clear();
	};

	pi.registerCommand("dot-live-input", {
		description: "Internal chat handoff control",
		handler: async (args, ctx) => {
			if (args.trim() === "cancel") {
				cancel(ctx);
				return;
			}
			if (
				args.trim() !== "interrupt" ||
				ctx.mode !== "rpc" ||
				handoff ||
				!inference ||
				toolBatch ||
				tools.size > 0 ||
				promptOpen ||
				ctx.isIdle() ||
				!ctx.hasPendingMessages() ||
				!ctx.signal ||
				ctx.signal.aborted
			)
				return;

			const current = { generation };
			handoff = current;
			ctx.ui.setStatus(LIVE_INPUT_STATUS, "interrupting");
			// No await between the local phase check and abort: a tool cannot start
			// in the gap. The command context, unlike ordinary hooks, exposes the
			// true idle barrier, including every extension's settlement/ACK work.
			ctx.abort();
			try {
				await ctx.waitForIdle();
				if (handoff !== current || generation !== current.generation) return;
				if (!ctx.isIdle() || !ctx.hasPendingMessages()) {
					cancel(ctx);
					return;
				}
				// A silent wake starts a fresh loop, whose first action drains native
				// steering. It introduces no user text and grants no new authority.
				pi.sendMessage({ customType: LIVE_INPUT_WAKE, content: [], display: false }, { triggerTurn: true });
			} catch (error) {
				if (handoff === current) cancel(ctx);
				throw error;
			}
		},
	});

	pi.on("agent_start", (_event, ctx) => {
		if (handoff) cancel(ctx);
		inference = false;
		toolBatch = false;
		tools.clear();
	});
	pi.on("context", (event) => {
		inference = !toolBatch && tools.size === 0;
		// The wake is lifecycle bookkeeping, not a message to the model. Remove
		// it on every request, including after reopening the saved conversation.
		return {
			messages: event.messages.filter(
				(message) => message.role !== "custom" || message.customType !== LIVE_INPUT_WAKE,
			),
		};
	});
	pi.on("turn_start", () => {
		toolBatch = false;
		inference = false;
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			toolBatch = event.message.content.some((part) => part.type === "toolCall");
			inference = !toolBatch && tools.size === 0;
		}
	});
	pi.on("message_update", (event) => {
		if (
			event.message.role === "assistant" &&
			event.message.content.some((part) => part.type === "toolCall")
		) {
			toolBatch = true;
			inference = false;
		}
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") inference = false;
	});
	pi.on("tool_call", () => {
		toolBatch = true;
		inference = false;
	});
	pi.on("tool_execution_start", (event) => {
		tools.add(event.toolCallId);
		inference = false;
	});
	pi.on("tool_execution_end", (event) => {
		tools.delete(event.toolCallId);
	});
	pi.on("ui_prompt_start", () => {
		promptOpen = true;
	});
	pi.on("ui_prompt_end", () => {
		promptOpen = false;
	});
	pi.on("agent_end", () => {
		inference = false;
	});
	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_before_tree", reset);
	pi.on("session_shutdown", reset);
}

export default registerLiveInput;
