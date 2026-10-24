import { expect, it } from "vitest";
import { humanOnlyQuestion } from "../src/orchestration/questions.ts";

const workspace = {provider:"dot-session/v1",category:"workspace-tool",scope:"project-workspace",tool:"read"};
it.each([undefined, {}, {provider:"extension",category:"workspace-tool",scope:"project-workspace",tool:"read"}, {...workspace,scope:"anywhere"}, {...workspace,tool:"smtp"}])("requires an explicit adapter-owned safe category: %j", workflowPermission => {
 expect(humanOnlyQuestion({kind:"confirm",title:"Allow operation?",workflowPermission})).toBe(true);
});
it.each(["read","edit","write","bash"])("allows the explicit workspace tool permission contract: %s", tool => {
 expect(humanOnlyQuestion({kind:"confirm",title:"Allow local operation?",workflowPermission:{...workspace,tool}})).toBe(false);
});
it.each(["SMTP delivery", "send email", "publish artifact", "git push", "connector access", "payment", "credential access"])("preview restrictions narrow even a recognized category: %s", message => {
 expect(humanOnlyQuestion({kind:"confirm",title:"Allow local operation?",message,workflowPermission:workspace})).toBe(true);
});
it("allows the bound native review category, never a generic review-looking prompt", () => {
 const dialog={kind:"select",title:"Review consent",options:[{id:"granted",label:"Review once"}]};
 expect(humanOnlyQuestion(dialog)).toBe(true);
 expect(humanOnlyQuestion({...dialog,workflowPermission:{provider:"dot-session/v1",category:"native-review-consent"}})).toBe(false);
});
