import { expect, it, vi } from "vitest";
import { GitHubIssues } from "../src/github-issues.ts";
import {decide} from "../src/extensions/approval-guard.ts";

it.each(["gh issue create --repo owner/repo --title bug --body details", "gh auth token", "gh auth status --show-token"])("blocks CLI bypass/token disclosure: %s", command => {
 expect(decide({toolName:"bash",input:{command},cwd:"/work"},{protectedPaths:[]}).action).toBe("block");
});

it.each([
 'gh --repo owner/repo issue create --title x --body y',
 'CLI=gh; "$CLI" issue create --repo owner/repo --title x --body y',
 '"gh" api -X POST repos/owner/repo/issues -f title=x',
 'gh --hostname github.com api repos/owner/repo/issues/1 --method PATCH -f body=x',
 'gh api repos/owner/repo/issues -f title=x',
])("blocks alternative GitHub publication commands: %s", command => {
 expect(decide({toolName:"bash",input:{command},cwd:"/work"},{protectedPaths:[]}).action).toBe("block");
});

it("requires a real confirmation, never a model supplied flag", async () => {
 const run = vi.fn();
 const issues = new GitHubIssues({ run, approve: async () => false });
 expect(await issues.dispatch({ action: "create", repo: "owner/repo", title: "Bug", body: "Details", confirmed: true })).toEqual({ created: false });
 expect(run).not.toHaveBeenCalled();
});
it("creates only the exact approved argv and returns only the issue URL", async () => {
 const run = vi.fn(async () => ({ code: 0, stdout: "https://github.com/owner/repo/issues/12\n" }));
 const approve = vi.fn(async () => true);
 const issues = new GitHubIssues({ run, approve });
 expect(await issues.dispatch({ action: "create", repo: "owner/repo", title: "Bug $(echo no)", body: "Details", labels: ["bug"] })).toEqual({ created: true, url: "https://github.com/owner/repo/issues/12" });
 expect(run).toHaveBeenCalledWith(["issue", "create", "--repo", "owner/repo", "--title", "Bug $(echo no)", "--body", "Details", "--label", "bug"], true, undefined);
 expect(approve).toHaveBeenCalledOnce();
});
it.each([{repo: "--help"}, {repo: "a/b/c"}, {title: "x".repeat(257)}, {body: "x".repeat(16001)}, {labels: ["arbitrary"]}])("rejects malformed and oversized input before confirmation: %j", async extra => {
 const run = vi.fn(); const approve = vi.fn();
 const issues = new GitHubIssues({run, approve});
 await expect(issues.dispatch({action:"create", repo:"owner/repo",title:"Bug",body:"Details",...extra})).rejects.toThrow();
 expect(approve).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
it("auth detection discards all output and never requests tokens", async () => {
 const run = vi.fn(async () => ({code:1, stdout:"PRIVATE"}));
 const issues = new GitHubIssues({run, approve:async()=>true});
 expect(await issues.dispatch({action:"status"})).toEqual({available:true, authenticated:false});
 expect(run).toHaveBeenCalledWith(["auth","status","--active","--hostname","github.com"], false, undefined);
});
it("reports missing gh distinctly without auth output", async () => {
 const issues=new GitHubIssues({run:async()=>({code:1,missing:true}),approve:async()=>true});
 expect(await issues.dispatch({action:"status"})).toEqual({available:false,authenticated:false});
});
it("does not publish after approval if the request has been cancelled", async()=>{
 const abort=new AbortController(); const run=vi.fn();
 const issues=new GitHubIssues({run,approve:async()=>{abort.abort();return true;}});
 expect(await issues.dispatch({action:"create",repo:"owner/repo",title:"Bug",body:"Details"},abort.signal)).toEqual({created:false});
 expect(run).not.toHaveBeenCalled();
});
it("fails closed on confirmation timeout", async () => {
 const run=vi.fn(); const issues=new GitHubIssues({run,approve:async()=>{throw new Error("timeout");}});
 expect(await issues.dispatch({action:"create",repo:"owner/repo",title:"Bug",body:"Details"})).toEqual({created:false});
 expect(run).not.toHaveBeenCalled();
});
