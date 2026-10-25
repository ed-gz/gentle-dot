import { expect, it } from "vitest";
import approvalGuard, { bindWorkspaceDelegation, workspaceToolPermission } from "../src/extensions/approval-guard.ts";
import { humanOnlyQuestion } from "../src/orchestration/questions.ts";
import { workflowPrompt } from "../src/extensions/dot-workflows.ts";

const cwd = process.cwd();
const permission = (command: string) => workspaceToolPermission({ toolName: "bash", input: { command }, cwd });
it("S20 produces trusted metadata for the real heredoc append", () => {
 const grant = permission("cat >> odd/tasks/release-store-local-polish.md <<'EOF'\nL7 billing-view/token-view checks\nEOF");
 expect(grant).toMatchObject({ category: "workspace-tool", decision: "local" });
 expect(humanOnlyQuestion({ kind: "confirm", workflowPermission: grant, title: "billing token", message: "billing-view/token-view" })).toBe(false);
});
it.each(["git push origin develop", "gh pr create --title release --body ready", "git merge origin/main", "npm run deploy"])("S20 makes %s eligible for instruction judgment, not the local fast path", command => {
 const grant = permission(command);
 expect(grant).toMatchObject({ decision: "instruction" });
 expect(humanOnlyQuestion({ kind: "confirm", workflowPermission: grant })).toBe(false);
});
it.each(["cat .env.local", "cat .ssh/id_ed25519", "gh auth token", "printenv", "printenv GITHUB_TOKEN", "env -0", "echo $GITHUB_TOKEN", "gh pr merge --admin", "git commit --no-verify", "git push --force origin main", "git reset --hard origin/main", `rm -rf ${cwd}`, "rm -rf ~", "rm -rf $HOME", "rm -rf $PWD", "git commit -m '[skip ci]'", "npm run deploy -- --skip-ci"])("S20 keeps hard block %s human-only even for todo", command => {
 expect(permission(command)).toBeUndefined();
});
it.each(["echo '--admin'", "echo '$GITHUB_TOKEN'", "gh pr create --body '--admin' --title token", "cat >> odd/tasks/log.md <<'EOF'\ngh auth token; rm -rf ~; --admin\nEOF"])("S20 literal content in %s does not create a hard block", command => {
 expect(permission(command)).toBeDefined();
});
it.each(["billing-view.ts", "token-view.ts", "src/token.ts"])("S20 incidental filename %s is not a credential", path => {
 expect(workspaceToolPermission({ toolName: "write", input: { path, content: "billing token" }, cwd })).toBeDefined();
});
it("S20 guard publication exception exists only while the exact adapter UI is enrolled", async () => {
 let handler: (event: unknown, context: unknown) => Promise<unknown>;
 approvalGuard({ on: (name: string, fn: typeof handler) => { if (name === "tool_call") handler = fn; }, registerTool() {}, getAllTools: () => [] } as never);
 const ui = {};
 let active = true;
 const call = { toolName: "bash", input: { command: "gh pr create --title release --body ready" } };
 expect(await handler!(call, { ui, cwd })).toMatchObject({ block: true });
 bindWorkspaceDelegation(ui, () => active);
 expect(await handler!(call, { ui, cwd })).toBeUndefined();
 expect(await handler!(call, { ui: {}, cwd })).toMatchObject({ block: true });
 expect(await handler!({ toolName: "bash", input: { command: "gh auth token" } }, { ui, cwd })).toMatchObject({ block: true });
 active = false;
 expect(await handler!(call, { ui, cwd })).toMatchObject({ block: true });
});

it("S20 model prompt uses the verified instruction, not a universal publication veto", () => {
 const prompt = workflowPrompt({ mode: "session", authorizedInstruction: "PRs y develop sí; deploy no", sessions: [] } as never);
 expect(prompt).toContain("PRs y develop sí; deploy no");
 expect(prompt).not.toContain("siempre necesita respuesta humana directa");
 expect(prompt).toContain("migración");
});
