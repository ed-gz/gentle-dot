// Test-only transport: the production daemon does not load this fixture.
import { createServer } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRpcDialogGuard } from "../../src/extensions/rpc-dialog-guard.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const guard = installRpcDialogGuard(ctx.ui, () => ctx.sessionManager.getSessionId());
		const server = createServer(socket => {
			let buffer = "";
			socket.on("data", data => {
				buffer += String(data);
				if (!buffer.includes("\n")) return;
				const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
				const result = request.method === "snapshot" ? { question: guard.snapshot() } : { accepted: guard.answer(request.params) };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
		});
		server.listen(process.env.RPC_GUARD_TEST_SOCKET!);
		setTimeout(async () => {
			ctx.ui.notify(`first:${await ctx.ui.confirm("Review", "original content")}`);
			ctx.ui.notify(`legacy:${await ctx.ui.confirm("Legacy", "desktop response")}`);
			ctx.ui.notify(`choice:${await ctx.ui.select("Choose", ["A", "B"])}`);
		}, 500);
	});
}
