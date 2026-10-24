import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { runGh } from "../src/github-issues.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it.each([false, true])("spawns gh with argv, no shell and no authentication/stderr capture (capture=%s)", async capture => {
	const child = Object.assign(new EventEmitter(), {stdout: capture ? new EventEmitter() : null, kill: vi.fn()});
	vi.mocked(spawn).mockReturnValueOnce(child as never);
	const args = capture ? ["issue", "create", "--repo", "owner/repo", "--title", "Bug", "--body", "Details"] : ["auth", "status", "--active", "--hostname", "github.com"];
	const pending = runGh(args, capture);
	expect(spawn).toHaveBeenLastCalledWith("gh", args, expect.objectContaining({shell:false,stdio:["ignore",capture?"pipe":"ignore","ignore"]}));
	child.stdout?.emit("data", Buffer.from("https://github.com/owner/repo/issues/1\n"));
	child.emit("close", 0);
	expect(await pending).toEqual(capture ? {code:0,stdout:"https://github.com/owner/repo/issues/1\n"} : {code:0});
});
