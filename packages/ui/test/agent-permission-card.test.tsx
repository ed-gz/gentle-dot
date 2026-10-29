import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SessionPendingQuestion } from "../src/components/SessionDetails.tsx";
import type { AgentApproval, AgentSession } from "../src/orchestration.ts";
import { AgentPermissionCard } from "../src/components/AgentPermissionCard.tsx";

it("keeps an unbound legacy question visible but disables phone answers", async () => {
 const send=vi.fn(async()=>true), approval:AgentApproval={id:'q',paneId:'p',sessionId:'s',title:'Permiso',message:'Contenido',action:'confirm',kind:'confirm',answerable:true,createdAt:'',expiresAt:''};
 const controls={act:send,busy:false,refresh:vi.fn(),requiresReviewedApproval:true};
 const {rerender}=render(<AgentPermissionCard approval={approval} controls={controls} disabled={false}/>);
 expect(screen.getByText(/responde en la laptop/)).toBeVisible();expect(screen.getByRole('button',{name:'Permitir'})).toBeDisabled();expect(screen.getByRole('button',{name:'Rechazar'})).toBeDisabled();expect(send).not.toHaveBeenCalled();
 rerender(<AgentPermissionCard approval={{...approval,questionRevision:'a'.repeat(64)}} controls={controls} disabled={false}/>);
 await userEvent.click(screen.getByRole('button',{name:'Permitir'}));expect(send).toHaveBeenCalledOnce();
});

it.each([
 { action: "review-consent" },
 { consentBinding: "opaque-provider-binding" },
 { workflowPermission: { category: "native-review-consent" } },
 { requiresConfirmation: true },
 { options: [{id:"yes",label:"Continuar\nEffect: Authorizes this candidate"}] },
 { options: [{id:"yes",label:"Continuar",description:"Authorizes this candidate"}] },
 { options: [{id:"yes",label:"Continuar",effect:"Authorizes this candidate"}] },
 { options: [{id:"yes",label:"Continuar",consequence:"Authorizes this candidate"}] },
])("requires explicit submission and accepted delivery for consent/effect metadata %j", async metadata => {
 let acknowledge!: (accepted: boolean) => void;
 const send = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
 const approval: AgentApproval = {id:"consent",paneId:"p",sessionId:"s",title:"Review",message:"Exact candidate",action:"question",kind:"select",answerable:true,createdAt:"",expiresAt:"",options:[{id:"yes",label:"Continuar"}],...metadata};
 render(<AgentPermissionCard approval={approval} controls={{act:send,busy:false,refresh:vi.fn()}} disabled={false}/>);
 expect(screen.getByRole("button", {name:"Enviar respuesta"})).toBeDisabled();
 await userEvent.click(screen.getByRole("radio", {name:/Continuar/}));
 expect(send).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole("button", {name:"Enviar respuesta"}));
 expect(send).toHaveBeenCalledExactlyOnceWith({action:"answer",paneId:"p",sessionId:"s",requestId:"consent",optionId:"yes"});
 expect(screen.queryByText("Respuesta enviada")).not.toBeInTheDocument();
 expect(screen.getByRole("button", {name:"Enviar respuesta"})).toBeDisabled();
 await act(async () => acknowledge(true));
 expect(screen.getByText("Respuesta enviada")).toBeVisible();
});

it.each(["git push", "Permiso de seguridad"])("answers %s from the session with exact identities and surfaces refusals", async title => {
 const send = vi.fn(async () => false);
 const session: AgentSession = {paneId:"phone-pane",sessionId:"s1",terminalId:"t",workspaceId:"w",label:"Proyecto",state:"blocked",connected:true,managed:true};
 const {rerender} = render(<SessionPendingQuestion session={session} conversation={{sessionId:"s1",status:"waiting",messages:[],question:{id:"q1",kind:"confirm",title,answerable:true}}} controls={{act:send,busy:false,refresh:vi.fn()}} disabled={false}/>);
 await userEvent.click(screen.getByRole("button",{name:"Permitir"}));
 expect(send).toHaveBeenCalledExactlyOnceWith({action:"answer",paneId:"phone-pane",sessionId:"s1",requestId:"q1",approved:true});
 await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/No se pudo/));
 rerender(<SessionPendingQuestion session={session} conversation={{sessionId:"s1",status:"waiting",messages:[],question:{id:"q1",kind:"confirm",title,answerable:true}}} controls={{act:send,busy:false,error:"Esta solicitud ya se respondió o cambió. Actualiza la sesión.",refresh:vi.fn()}} disabled={false}/>);
 expect(screen.getByRole("alert")).toHaveTextContent("Esta solicitud ya se respondió o cambió");
});
