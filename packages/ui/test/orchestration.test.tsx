import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Send } from "../src/components/types.ts";
import { OrchestrationPanel } from "../src/components/OrchestrationPanel.tsx";
import type { AgentConversation, OrchestrationClient, OrchestrationSnapshot } from "../src/orchestration.ts";
import { useOrchestration, type OrchestrationControls } from "../src/useOrchestration.ts";
import { AgentVoiceContext } from "../src/useAgentVoice.ts";
import { initialState } from "../src/store.ts";

beforeEach(() => localStorage.removeItem("gentle-dot:session-outbox:v1"));

it("preserves a session draft when discovery temporarily loses the pane", async () => {
	const { controls, client, view } = setup({ ...snapshot, approvals: [] });
	fireEvent.click(screen.getByRole("button", { name: /Release/ }));
	await screen.findByText("The checks passed.");
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "Borrador aún sin enviar" } });
	view.rerender(<OrchestrationPanel controls={{ ...controls, snapshot: { ...controls.snapshot!, sessions: [] } }} client={client} mobile capriMobile />);
	expect(screen.queryByLabelText("Continuar esta sesión")).not.toBeInTheDocument();
	view.rerender(<OrchestrationPanel controls={controls} client={client} mobile capriMobile />);
	expect(await screen.findByLabelText("Continuar esta sesión")).toHaveValue("Borrador aún sin enviar");
});

it("never carries a vanished session draft to a replacement in the same pane", async () => {
	const { controls, client, view } = setup({ ...snapshot, approvals: [] });
	fireEvent.click(screen.getByRole("button", { name: /Release/ }));
	await screen.findByText("The checks passed.");
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "Solo para la primera sesión" } });
	const replacement = { ...controls.snapshot!, sessions: controls.snapshot!.sessions.map(session => ({ ...session, sessionId: "s2" })) };
	view.rerender(<OrchestrationPanel controls={{ ...controls, snapshot: replacement }} client={client} mobile capriMobile />);
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("");
	view.rerender(<OrchestrationPanel controls={controls} client={client} mobile capriMobile />);
	expect(await screen.findByLabelText("Continuar esta sesión")).toHaveValue("Solo para la primera sesión");
});

it("keeps a persisted attachment send uncertain when only matching text is available", async () => {
 const at = Date.now()-60_000;
 localStorage.setItem("gentle-dot:session-outbox:v1", JSON.stringify([{id:"restored-send",identity:"p1:s1",text:"Dos bugs a resolver",payload:JSON.stringify(["Dos bugs a resolver",null,"steer"]),createdAt:at,status:"unconfirmed",baseline:[],attachmentNames:["uno.png","dos.png"]}]));
 const {view} = setup({...snapshot,approvals:[]}, {sessionId:"s1",status:"idle",question:null,
  deliveries:[{id:"restored-send",status:"unconfirmed",preview:"Dos bugs a resolver",deliverAs:"steer",acceptedAt:new Date(at).toISOString()}],
  messages:[
   {id:"u-images",role:"user",timestamp:new Date(at+1000).toISOString(),content:[{type:"text",text:'Dos bugs a resolver\n\n<attachments>\n{"name":"uno.png"}\n{"name":"dos.png"}\n</attachments>'}]},
   {id:"a-images",role:"assistant",timestamp:new Date(at+2000).toISOString(),content:[{type:"text",text:"Ya están corregidos"}]},
   {id:"u-later",role:"user",timestamp:new Date().toISOString(),content:[{type:"text",text:"ya"}]},
  ]});
 fireEvent.click(screen.getByRole("button",{name:/Release/}));
 await screen.findByText("ya");
 await waitFor(() => expect(view.container.querySelector(".session-delivery-unconfirmed")).toBeVisible());
});

const snapshot: OrchestrationSnapshot = {
	available: true,
	sessions: [
		{
			paneId: "p1",
			sessionId: "s1",
			terminalId: "t1",
			workspaceId: "w1",
			label: "Release",
			state: "blocked",
			connected: true,
			managed: true,
			cwd: "/work/release",
		},
	],
	approvals: [
		{
			id: "ask1",
			paneId: "p1",
			sessionId: "s1",
			title: "Push prepared changes?",
			message: "git push origin feature",
			action: "push",
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			answerable: true,
		},
	],
	policies: [],
	events: [],
};

function setup(next = snapshot, conversation?: AgentConversation) {
	const controls: OrchestrationControls = {
		snapshot: next,
		busy: false,
		refresh: vi.fn(async () => {}),
		act: vi.fn(async () => true),
	};
	const client: OrchestrationClient = {
		snapshot: vi.fn(async () => next),
		act: vi.fn(async () => {}),
		inspect: vi.fn(
			async (): Promise<AgentConversation> =>
				conversation ?? {
					sessionId: "s1",
					status: "idle",
					messages: [
						{ id: "m1", role: "assistant", content: [{ type: "text", text: "The checks passed." }] },
					],
					question: null,
				},
		),
	};
	const view = render(<OrchestrationPanel controls={controls} client={client} />);
	return { controls, client, view };
}

it.each([false, true])("shows live work above the composer, marks the list row, and clears on idle (mobile=%s)", async mobile => {
 const next: OrchestrationSnapshot = { ...snapshot, approvals: [], sessions: snapshot.sessions.map(s => ({ ...s, state: "working" })) };
 const { controls, client, view } = setup(next);
 view.rerender(<OrchestrationPanel client={client} controls={controls} mobile={mobile} />);
 expect(view.container.querySelector(".agent-session-state .session-working-dot")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: /Release/ }));
 expect(await screen.findByRole("status", { name: "Actividad de la sesión" })).toHaveTextContent("Trabajando…");
 view.rerender(<OrchestrationPanel client={client} mobile={mobile} controls={{ ...controls, snapshot: { ...next, sessions: next.sessions.map(s => ({ ...s, state: "idle" })) } }} />);
 expect(screen.queryByRole("status", { name: "Actividad de la sesión" })).not.toBeInTheDocument();
});

it("keeps a waiting session question and its answer options inline above the phone composer", async()=>{
 const next:OrchestrationSnapshot={...snapshot,approvals:snapshot.approvals.map(a=>({...a,kind:"select",options:[{id:"continue",label:"Continuar"},{id:"stop",label:"Detener"}]}))};
 const {controls,client,view}=setup(next,{sessionId:"s1",status:"waiting",messages:[],question:{id:"ask1",kind:"select",title:"Push prepared changes?",answerable:true}});
 view.rerender(<OrchestrationPanel controls={controls} client={client} mobile requestsVisible={false}/>);
 fireEvent.click(screen.getByRole("button",{name:/Release/}));
 const card=await screen.findByRole("region",{name:"Solicitud pendiente de esta sesión"});
 expect(within(card).getByText("Push prepared changes?")).toBeVisible();
 expect(within(card).getByLabelText("Continuar")).toBeEnabled();
 expect(card.closest("details,dialog")).toBeNull();
 fireEvent.click(within(card).getByLabelText("Continuar"));
 fireEvent.click(within(card).getByRole("button",{name:"Enviar respuesta"}));
 await waitFor(()=>expect(controls.act).toHaveBeenCalledWith({action:"answer",paneId:"p1",sessionId:"s1",requestId:"ask1",optionId:"continue"}));
});
it("does not treat a refused answer as a disconnected phone", async () => {
 const { controls, client, view } = setup();
 view.rerender(<OrchestrationPanel controls={{...controls,error:"Esta solicitud cambió. Actualiza la sesión."}} client={client} mobile />);
 fireEvent.click(screen.getByRole("button", {name:/Release/}));
 expect(await screen.findByRole("button", {name:"Permitir"})).toBeEnabled();
});
it("shows the waiting-question queue receipt instead of losing the extra detail", async()=>{
 const delivery={id:"queued-human-123",status:"queued" as const,deliverAs:"followUp" as const,preview:"extra detail",acceptedAt:new Date().toISOString()};
 setup({...snapshot,approvals:[]},{sessionId:"s1",status:"waiting",messages:[],question:null,deliveries:[delivery]});
 fireEvent.click(screen.getByRole("button",{name:/Release/}));
 expect(await screen.findByText("Enviado a la cola; revisa la pregunta pendiente.")).toBeVisible();
});

function ProductionAgentPanel({ client, active = true, connected = true, send = () => false }: { client: OrchestrationClient; active?: boolean; connected?: boolean; send?: Send }) {
	const controls = useOrchestration(client, active);
	return <AgentVoiceContext value={{ state: { ...initialState, connection: connected ? "open" : "closed" }, send }}>
		<button type="button" onClick={() => void controls.refresh()}>Verify owner</button>
		<OrchestrationPanel client={client} controls={controls} active={active} />
	</AgentVoiceContext>;
}

function attachmentClient(files = true): OrchestrationClient {
	return {
		snapshot: vi.fn<OrchestrationClient["snapshot"]>(async () => ({ ...snapshot, approvals: [], sessions: snapshot.sessions.map(session => ({ ...session, capabilities: { prompt: true, inspect: true, abort: true, approvals: false, ...(files ? { attachments: { version: 1 as const, files: true as const, images: true, audio: "file" as const } } : {}) } })) })),
		act: vi.fn(async () => {}),
		inspect: vi.fn(async () => ({ sessionId: "s1", status: "idle" as const, messages: [], question: null })),
		uploadAttachment: vi.fn<NonNullable<OrchestrationClient["uploadAttachment"]>>(async (_pane, _session, file) => ({ uploadId: "u_readyfixture", name: file.name, size: file.size, mime: "application/octet-stream", path: `uploads/u_readyfixture/${file.name}` })),
	};
}

describe.each([false, true])("no-file text recovery with attachment capability=%s", files => {
	it("submits a fresh manual text draft after tab hide and return", async () => {
		const client = attachmentClient(files);
		const send = vi.fn<Send>();
		let accept!: () => void;
		vi.mocked(client.act).mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
		const view = render(<ProductionAgentPanel client={client} send={send} />);
		await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
		fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "manual text after return" } });
		view.rerender(<ProductionAgentPanel client={client} send={send} active={false} />);
		view.rerender(<ProductionAgentPanel client={client} send={send} />);
		const form = screen.getByRole("button", { name: "Enviar instrucción" }).closest("form")!;
		fireEvent.submit(form); fireEvent.submit(form);
		await waitFor(() => expect(client.act).toHaveBeenCalledExactlyOnceWith({ action: "prompt", paneId: "p1", sessionId: "s1", text: "manual text after return" }));
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("manual text after return");
		await act(async () => accept());
		await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue(""));
		expect(client.uploadAttachment).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Archivos para esta sesión") !== null).toBe(files);
	});

	it("retains rejection and sends the exact no-file draft after real hook refresh and manual retry", async () => {
		const client = attachmentClient(files);
		const send = vi.fn<Send>();
		vi.mocked(client.act).mockRejectedValueOnce(new Error("HTTP 409: text rejected"));
		render(<ProductionAgentPanel client={client} send={send} />);
		await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
		fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "retry this exact text" } });
		fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
		await screen.findAllByText(/HTTP 409: text rejected/);
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("retry this exact text");
		expect(client.act).toHaveBeenCalledExactlyOnceWith({ action: "prompt", paneId: "p1", sessionId: "s1", text: "retry this exact text" });
		expect(screen.queryByText(/Instrucción enviada/)).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeEnabled());
		expect(client.act).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
		await waitFor(() => expect(client.act).toHaveBeenCalledTimes(2));
		expect(vi.mocked(client.act).mock.calls[1]![0]).toEqual({ action: "prompt", paneId: "p1", sessionId: "s1", text: "retry this exact text" });
		await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue(""));
		expect(client.uploadAttachment).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
	});

	it.each(["availability", "session connection", "transport disconnect"])("recovers fresh no-file sending after %s", async change => {
		const client = attachmentClient(files);
		const send = vi.fn<Send>();
		const original = await client.snapshot();
		const view = render(<ProductionAgentPanel client={client} send={send} />);
		await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
		fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "manual text after recovery" } });
		if (change === "transport disconnect") view.rerender(<ProductionAgentPanel client={client} send={send} connected={false} />);
		else {
			vi.mocked(client.snapshot).mockResolvedValue({ ...original, ...(change === "availability" ? { available: false } : { sessions: original.sessions.map(session => ({ ...session, connected: false })) }) });
			await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
		}
		await waitFor(() => expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeDisabled());
		expect(client.act).not.toHaveBeenCalled();
		vi.mocked(client.snapshot).mockResolvedValue(original);
		view.rerender(<ProductionAgentPanel client={client} send={send} />);
		await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeEnabled());
		expect(client.act).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
		await waitFor(() => expect(client.act).toHaveBeenCalledExactlyOnceWith({ action: "prompt", paneId: "p1", sessionId: "s1", text: "manual text after recovery" }));
		await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue(""));
		expect(client.uploadAttachment).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
	});
});

function selectAgentFile() {
	fireEvent.change(screen.getByLabelText("Archivos para esta sesión"), { target: { files: [new File(["retained bytes"], "ready.txt", { type: "text/plain" })] } });
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "retain this draft" } });
}

it("retains ready files and text after the real orchestration action hook propagates rejection", async () => {
	const client = attachmentClient();
	vi.mocked(client.act).mockRejectedValueOnce(new Error("HTTP 409: session rejected"));
	const view = render(<ProductionAgentPanel client={client} />);
	await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
	selectAgentFile();
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await screen.findAllByText(/HTTP 409: session rejected/);
	expect(screen.getByText("ready.txt")).toBeVisible();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("retain this draft");
	expect(client.act).toHaveBeenCalledExactlyOnceWith({ action: "prompt", paneId: "p1", sessionId: "s1", text: "retain this draft", attachments: [{ uploadId: "u_readyfixture", name: "ready.txt" }] });
	expect(screen.queryByText(/Instrucción enviada/)).toBeNull();
	view.rerender(<ProductionAgentPanel client={client} active={false} />);
	view.rerender(<ProductionAgentPanel client={client} />);
	expect(screen.getByText("ready.txt")).toBeVisible();
	// Re-verify through the real hook, without changing its error/snapshot by hand.
	await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeEnabled());
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await waitFor(() => expect(screen.queryByText("ready.txt")).toBeNull());
	expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
	expect(vi.mocked(client.act).mock.calls[1]![0]).toEqual(vi.mocked(client.act).mock.calls[0]![0]);
});

it("keeps same-owner unsent files across tab hide and return", async () => {
	const client = attachmentClient();
	const view = render(<ProductionAgentPanel client={client} />);
	await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
	selectAgentFile();
	view.rerender(<ProductionAgentPanel client={client} active={false} />);
	view.rerender(<ProductionAgentPanel client={client} />);
	expect(screen.getByText("ready.txt")).toBeVisible();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("retain this draft");
	expect(client.act).not.toHaveBeenCalled();
});

it.each(["availability", "session connection"])("preserves same-owner files when %s becomes unavailable", async change => {
	const client = attachmentClient();
	const original = await client.snapshot();
	const view = render(<ProductionAgentPanel client={client} />);
	await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
	selectAgentFile();
	vi.mocked(client.snapshot).mockResolvedValue({ ...original, ...(change === "availability" ? { available: false } : { sessions: original.sessions.map(session => ({ ...session, connected: false })) }) });
	await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeDisabled());
	expect(screen.getByText("ready.txt")).toBeVisible();
	vi.mocked(client.snapshot).mockResolvedValue(original);
	await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeEnabled());
	expect(screen.getByText("ready.txt")).toBeVisible();
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("retain this draft");
	expect(client.act).not.toHaveBeenCalled();
	view.unmount();
});

it("does not let an old owner's acceptance clear another session's saved draft", async () => {
	const client = attachmentClient();
	const original = await client.snapshot();
	vi.mocked(client.snapshot).mockResolvedValue({ ...original, sessions: [...original.sessions, { ...original.sessions[0]!, paneId: "p2", sessionId: "s2", label: "Other owner" }] });
	let resolve!: () => void;
	vi.mocked(client.act).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
	render(<ProductionAgentPanel client={client} />);
	await userEvent.click(await screen.findByRole("button", { name: "Other owner · Te necesita" }));
	fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "other owner's saved draft" } });
	await userEvent.click(screen.getByRole("button", { name: "Todos los agentes" }));
	await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
	selectAgentFile();
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await waitFor(() => expect(client.act).toHaveBeenCalledTimes(1));
	await userEvent.click(screen.getByRole("button", { name: "Todos los agentes" }));
	await userEvent.click(screen.getByRole("button", { name: "Other owner · Te necesita" }));
	await act(async () => resolve());
	expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("other owner's saved draft");
	expect(screen.queryByText("ready.txt")).toBeNull();
	expect(client.act).toHaveBeenCalledExactlyOnceWith({ action: "prompt", paneId: "p1", sessionId: "s1", text: "retain this draft", attachments: [{ uploadId: "u_readyfixture", name: "ready.txt" }] });
});

it.each([true, false])("settles an already dispatched same-owner acknowledgement while hidden (accepted=%s)", async accepted => {
	const client = attachmentClient();
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	vi.mocked(client.act).mockImplementationOnce(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
	const view = render(<ProductionAgentPanel client={client} />);
	await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
	selectAgentFile();
	const form = screen.getByRole("button", { name: "Enviar instrucción" }).closest("form")!;
	fireEvent.submit(form); fireEvent.submit(form);
	await waitFor(() => expect(client.act).toHaveBeenCalledTimes(1));
	view.rerender(<ProductionAgentPanel client={client} active={false} />);
	await act(async () => { if (accepted) resolve(); else reject(new Error("HTTP 409: hidden rejection")); });
	if (!accepted) expect(screen.getAllByText(/HTTP 409: hidden rejection/).length).toBeGreaterThan(0);
	view.rerender(<ProductionAgentPanel client={client} />);
	await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue(accepted ? "" : "retain this draft"));
	if (accepted) {
		expect(screen.queryByText("ready.txt")).toBeNull();
		fireEvent.submit(form);
		expect(client.act).toHaveBeenCalledTimes(1);
	} else {
		expect(screen.getByText("ready.txt")).toBeVisible();
	}
});

it.each(["tab", "disconnect"])("keeps owned files but invalidates late voice after %s without remounting", async change => {
	const client = attachmentClient();
	let resolve!: (result: { text: string }) => void;
	window.__GENTLE_MOBILE__ = { transcribe: () => new Promise(done => { resolve = done; }) };
	try {
		const view = render(<ProductionAgentPanel client={client} />);
		await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
		selectAgentFile();
		fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
		view.rerender(<ProductionAgentPanel client={client} active={change !== "tab"} connected={change !== "disconnect"} />);
		await act(async () => resolve({ text: "stale dictation" }));
		view.rerender(<ProductionAgentPanel client={client} />);
		expect(screen.getByText("ready.txt")).toBeVisible();
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("retain this draft");
		expect(client.act).not.toHaveBeenCalled();
	} finally { delete window.__GENTLE_MOBILE__; }
});

it.each(["client", "pane", "session"])("resets files and fences native voice on an actual %s owner change", async change => {
	const client = attachmentClient();
	let resolve!: (result: { text: string }) => void;
	window.__GENTLE_MOBILE__ = { transcribe: () => new Promise(done => { resolve = done; }) };
	try {
		const view = render(<ProductionAgentPanel client={client} />);
		await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
		selectAgentFile();
		fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
		const nextClient = change === "client" ? attachmentClient() : client;
		if (change !== "client") {
			const next = await client.snapshot();
			vi.mocked(client.snapshot).mockResolvedValue({ ...next, sessions: next.sessions.map(session => ({ ...session, ...(change === "pane" ? { paneId: "p2" } : { sessionId: "s2" }) })) });
		}
		view.rerender(<ProductionAgentPanel client={nextClient} />);
		if (change !== "client") await userEvent.click(screen.getByRole("button", { name: "Verify owner" }));
		if (change === "pane") await userEvent.click(await screen.findByRole("button", { name: "Release · Te necesita" }));
		else await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue(""));
		await act(async () => resolve({ text: "other owner's transcript" }));
		expect(screen.queryByText("ready.txt")).toBeNull();
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("");
		expect(client.act).not.toHaveBeenCalled(); expect(nextClient.act).not.toHaveBeenCalled();
		expect(client.uploadAttachment).not.toHaveBeenCalled(); expect(nextClient.uploadAttachment).not.toHaveBeenCalled();
	} finally { delete window.__GENTLE_MOBILE__; }
});

describe("remote agent controls", () => {
	it("dictates into the real legacy session composer and only submits edited text to its captured target", async () => {
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn(async () => ({ text: "spoken instruction" })) };
		const send = vi.fn();
		const controls: OrchestrationControls = { snapshot, busy: false, refresh: vi.fn(), act: vi.fn(async () => true) };
		const client = { inspect: vi.fn(async () => ({ sessionId: "s1", status: "idle", messages: [], question: null })) } as unknown as OrchestrationClient;
		try {
			render(<AgentVoiceContext value={{ state: { ...initialState, connection: "open" }, send }}><OrchestrationPanel controls={controls} client={client} /></AgentVoiceContext>);
			await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
			await userEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
			await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("spoken instruction"));
			expect(controls.act).not.toHaveBeenCalled();
			fireEvent.change(screen.getByLabelText("Continuar esta sesión"), { target: { value: "reviewed instruction" } });
			await userEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
			expect(controls.act).toHaveBeenCalledExactlyOnceWith({ action: "prompt", paneId: "p1", sessionId: "s1", text: "reviewed instruction" });
			expect(send).not.toHaveBeenCalled();
			expect(screen.getByText("git push origin feature")).toBeVisible();
		} finally { delete window.__GENTLE_MOBILE__; }
	});
	it("fails closed for attachments with a short availability state, not setup prose", async () => {
		setup();
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(await screen.findByText("The checks passed.")).toBeVisible();
		expect(screen.queryByText(/Esta conexión no admite archivos adjuntos/)).not.toBeInTheDocument();
		expect(screen.queryByText("Adjuntos no disponibles")).toBeNull();
		expect(screen.queryByRole("button", { name: "Adjuntar archivos" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Archivos para esta sesión")).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByLabelText("Continuar esta sesión")).toBeEnabled());
		expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeDisabled();
	});
	it("separates identified delegate results without interpreting the words in human messages", async () => {
		setup(snapshot, {
			sessionId: "s1",
			status: "idle",
			question: null,
			messages: [
				{
					id: "human",
					role: "user",
					content: [{ type: "text", text: "[Gentle Agents] Este texto lo escribí yo." }],
				},
				{
					id: "delegate",
					role: "assistant",
					provenance: { kind: "subagent", label: "Revisor" },
					content: [{ type: "text", text: "Cambios verificados." }],
				},
				{
					id: "peer",
					role: "assistant",
					provenance: { kind: "session", label: "Preparación" },
					content: [{ type: "text", text: "Ya está preparado." }],
				},
				{
					id: "orchestrator",
					role: "assistant",
					content: [{ type: "text", text: "Estoy integrando la revisión." }],
				},
				{ id: "system", role: "system", content: [{ type: "text", text: "Registro de sistema oculto" }] },
			],
		});
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(await screen.findByRole("article", { name: "Tu mensaje" })).toHaveTextContent(
			"[Gentle Agents] Este texto lo escribí yo.",
		);
		const delegate = screen.getByRole("article", { name: "Subagente · Revisor" });
		const body = within(delegate).getByText("Cambios verificados.");
		expect(body).not.toBeVisible();
		const summary = within(delegate).getByText("Subagente · Revisor", { selector: "summary" });
		expect(summary).toBeVisible();
		expect(summary).not.toHaveTextContent("Cambios verificados.");
		expect(screen.getByText("Estoy integrando la revisión.")).toBeVisible();
		expect(screen.getByText("Ya está preparado.")).toBeVisible();
		expect(screen.queryByText("Registro de sistema oculto")).not.toBeInTheDocument();

		await userEvent.click(summary);
		expect(body).toBeVisible();
		await userEvent.click(summary);
		expect(body).not.toBeVisible();
		expect(screen.getByText("Estoy integrando la revisión.")).toBeVisible();
		expect(screen.getByText("Ya está preparado.")).toBeVisible();
	});

	it("keeps separate subagent replies closed independently, including unlabeled replies and refreshes", async () => {
		const messages: AgentConversation["messages"] = [
			{
				id: "first",
				role: "assistant",
				provenance: { kind: "subagent" },
				content: [{ type: "text", text: "Primer resultado." }],
			},
			{
				id: "second",
				role: "assistant",
				provenance: { kind: "subagent", label: "Pruebas" },
				content: [{ type: "text", text: "Segundo resultado." }],
			},
		];
		const { controls, client, view } = setup(snapshot, {
			sessionId: "s1",
			status: "idle",
			question: null,
			messages,
		});
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		const first = await screen.findByRole("article", { name: "Subagente" });
		const summary = within(first).getByText("Subagente", { selector: "summary" });
		expect(screen.getByText("Primer resultado.")).not.toBeVisible();
		expect(screen.getByText("Segundo resultado.")).not.toBeVisible();
		await userEvent.click(summary);
		expect(screen.getByText("Primer resultado.")).toBeVisible();
		expect(screen.getByText("Segundo resultado.")).not.toBeVisible();
		view.rerender(
			<OrchestrationPanel
				controls={{
					...controls,
					snapshot: { ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session })) },
				}}
				client={client}
			/>,
		);
		fireEvent(document, new Event("visibilitychange"));
		await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
		expect(screen.getByText("Primer resultado.")).toBeVisible();
		expect(screen.getByText("Segundo resultado.")).not.toBeVisible();
		await userEvent.click(summary);
		expect(screen.getByText("Primer resultado.")).not.toBeVisible();
	});

	it("opens an alert only for its exact session and reports visibility without reopening after Back", async () => {
		const { controls, client, view } = setup();
		const onVisibleSession = vi.fn();
		const props = { controls, client, onVisibleSession };
		view.rerender(
			<OrchestrationPanel {...props} requestedSession={{ paneId: "p1", sessionId: "replaced", key: 1 }} />,
		);
		expect(screen.queryByLabelText("Continuar esta sesión")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(await screen.findByLabelText("Continuar esta sesión")).toBeVisible();
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Puedo seguir escribiendo");
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Puedo seguir escribiendo");
		view.rerender(<OrchestrationPanel {...props} requestedSession={{ paneId: "p1", key: 2 }} />);
		expect(screen.queryByLabelText("Continuar esta sesión")).not.toBeInTheDocument();
		const requestedSession = { paneId: "p1", sessionId: "s1", key: 3 };
		view.rerender(<OrchestrationPanel {...props} requestedSession={requestedSession} />);
		expect(await screen.findByLabelText("Continuar esta sesión")).toBeVisible();
		expect(onVisibleSession).toHaveBeenLastCalledWith({ paneId: "p1", sessionId: "s1" });
		await userEvent.click(screen.getByRole("button", { name: "Todos los agentes" }));
		view.rerender(<OrchestrationPanel {...props} requestedSession={requestedSession} />);
		expect(screen.queryByLabelText("Continuar esta sesión")).not.toBeInTheDocument();
		expect(onVisibleSession).toHaveBeenLastCalledWith(undefined);
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		view.rerender(<OrchestrationPanel {...props} active={false} requestedSession={requestedSession} />);
		expect(onVisibleSession).toHaveBeenLastCalledWith(undefined);
		view.unmount();
		expect(onVisibleSession).toHaveBeenLastCalledWith(undefined);
		expect(controls.act).not.toHaveBeenCalled();
	});
	it("keeps tool and system records out of the chat while preserving the reply draft and native Back", async () => {
		const { controls, client, view } = setup(snapshot, {
			sessionId: "s1",
			status: "idle",
			question: null,
			messages: [
				{ id: "covered", role: "tool", content: [{ type: "text", text: "Resultado de comando plegado" }] },
				{ id: "other", role: "tool", content: [{ type: "text", text: "Resultado de memoria separado" }] },
				{ id: "answer", role: "assistant", content: [{ type: "text", text: "La revisión está lista." }] },
			],
			work: {
				version: 1,
				truncated: false,
				agents: [],
				commands: [
					{
						id: "call",
						messageId: "covered",
						label: "pnpm test",
						tool: "bash",
						source: "history",
						status: "completed",
					},
				],
			},
		});
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(await screen.findByText("La revisión está lista.")).toBeVisible();
		expect(screen.getByText("Resultado de memoria separado")).not.toBeVisible();
		expect(screen.queryByText("Agente", { exact: true })).not.toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Actividad reciente" })).not.toBeInTheDocument();
		expect(screen.getByText("Resultado de comando plegado")).not.toBeVisible();
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Borrador pendiente");
		expect(screen.queryByText("Ver resultado")).not.toBeInTheDocument();
		expect(screen.queryByText("Registros")).not.toBeInTheDocument();
		const viewport = view.container.querySelector(".agent-detail-scroll") as HTMLDivElement;
		Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1200 });
		viewport.scrollTop = 0;
		fireEvent.scroll(viewport);
		const currentConversation = await vi.mocked(client.inspect).mock.results[0]?.value;
		if (!currentConversation) throw new Error("Expected the loaded conversation");
		vi.mocked(client.inspect).mockResolvedValue({
			...currentConversation,
			messages: [...currentConversation.messages],
		});
		view.rerender(
			<OrchestrationPanel
				controls={{
					...controls,
					snapshot: { ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session })) },
				}}
				client={client}
			/>,
		);
		fireEvent(document, new Event("visibilitychange"));
		await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Borrador pendiente");
		expect(view.container.querySelector(".agent-command-workflow")).not.toHaveAttribute("open");
		expect(viewport.scrollTop).toBe(0);
		expect(controls.act).not.toHaveBeenCalled();
		fireEvent(window, new Event("gentledot-back", { cancelable: true }));
		expect(screen.queryByLabelText("Continuar esta sesión")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Release · Te necesita" })).toBeVisible();
	});
	it("creates with a healthy provider even when Herdr is disconnected", async () => {
		const { controls } = setup({
			...snapshot,
			providers: [
				{ id: "herdr", available: false, canCreate: false },
				{ id: "terminal", available: true, canCreate: true },
			],
		});
		await userEvent.click(screen.getByRole("button", { name: "Nueva sesión" }));
		expect(screen.getByLabelText("Abrir en")).toHaveValue("terminal");
		fireEvent.change(screen.getByLabelText("Carpeta del proyecto en tu equipo"), {
			target: { value: "/work/project" },
		});
		await userEvent.click(screen.getByRole("button", { name: "Crear sesión" }));
		expect(controls.act).toHaveBeenCalledWith({
			action: "create",
			provider: "terminal",
			cwd: "/work/project",
		});
	});

	it("uses explicit session capabilities and binds stopping to the current session", async () => {
		const { controls, client } = setup({
			...snapshot,
			sessions: snapshot.sessions.map((session) => ({
				...session,
				provider: "orca",
				state: "working",
				capabilities: { inspect: false, prompt: false, abort: true, approvals: false },
			})),
		});
		await userEvent.click(screen.getByRole("button", { name: "Release · Trabajando" }));
		expect(client.inspect).not.toHaveBeenCalled();
		expect(screen.queryByLabelText("Continuar esta sesión")).not.toBeInTheDocument();
		expect(screen.getByText("Solo consulta")).toBeVisible();
		await userEvent.click(screen.getByLabelText("Detalles de la sesión"));
		await userEvent.click(screen.getByRole("button", { name: "Detener tarea" }));
		expect(controls.act).toHaveBeenCalledExactlyOnceWith({ action: "abort", paneId: "p1", sessionId: "s1" });
	});

	it("requires an explicit approval and binds it to the exact pending request and session", async () => {
		const { controls } = setup();
		expect(controls.act).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Permitir" }));
		expect(controls.act).toHaveBeenCalledWith({
			action: "answer",
			paneId: "p1",
			sessionId: "s1",
			requestId: "ask1",
			approved: true,
		});
	});

	it("keeps intervention specific without offering recurring authorization controls", async () => {
		const { controls } = setup();
		expect(screen.queryByRole("button", { name: "Permiso nocturno" })).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Duración")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Máximo de aprobaciones")).not.toBeInTheDocument();
		expect(screen.queryByText(/Permisos anteriores/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Rechazar" }));
		expect(controls.act).toHaveBeenCalledExactlyOnceWith({
			action: "answer",
			paneId: "p1",
			sessionId: "s1",
			requestId: "ask1",
			approved: false,
		});
	});

	it("never offers remote decisions for a legacy terminal request", () => {
		setup({
			...snapshot,
			approvals: snapshot.approvals.map((approval) => ({ ...approval, answerable: false })),
		});
		expect(screen.getByRole("button", { name: "Permitir" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Rechazar" })).toBeDisabled();
		expect(screen.getByText(/Responde esta solicitud en la terminal original/)).toBeInTheDocument();
	});

	it("shows the selected agent conversation and sends instructions to that session", async () => {
		const { controls, client } = setup();
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(await screen.findByText("The checks passed.")).toBeInTheDocument();
		expect(client.inspect).toHaveBeenCalledWith("p1", "s1", expect.any(AbortSignal));
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Continue the plan");
		await userEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
		await waitFor(() =>
			expect(controls.act).toHaveBeenCalledWith({
				action: "prompt",
				paneId: "p1",
				sessionId: "s1",
				text: "Continue the plan",
			}),
		);
	});

	it("creates a session only after the folder is submitted", async () => {
		const { controls } = setup();
		await userEvent.click(screen.getByRole("button", { name: "Nueva sesión" }));
		expect(screen.getByRole("button", { name: "Crear sesión" })).toBeDisabled();
		await userEvent.type(screen.getByLabelText("Carpeta del proyecto en tu equipo"), "/work/new-project");
		await userEvent.click(screen.getByRole("button", { name: "Crear sesión" }));
		await waitFor(() =>
			expect(controls.act).toHaveBeenCalledWith({ action: "create", cwd: "/work/new-project" }),
		);
	});

	it("keeps previously issued policies folded and revocable", async () => {
		const { controls } = setup({
			...snapshot,
			policies: [
				{
					id: "policy1",
					paneId: "p1",
					sessionId: "s1",
					action: "push",
					expiresAt: new Date(Date.now() + 10000).toISOString(),
					remainingUses: 2,
				},
			],
		});
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(screen.getByRole("button", { name: "Revocar permiso" })).not.toBeVisible();
		await userEvent.click(screen.getByLabelText("Detalles de la sesión"));
		await userEvent.click(screen.getByRole("button", { name: "Revocar permiso" }));
		expect(controls.act).toHaveBeenCalledWith({ action: "revoke", policyId: "policy1" });
	});
});

describe("session continuity", () => {
	it("preserves separate drafts, loaded history and reading position across sessions and tabs", async () => {
		const firstSession = snapshot.sessions[0];
		if (!firstSession) throw new Error("Missing fixture session");
		const two = {
			...snapshot,
			approvals: [],
			sessions: [
				...snapshot.sessions,
				{ ...firstSession, paneId: "p2", sessionId: "s2", label: "Otra sesión" },
			],
		};
		const { view, client, controls } = setup(two);
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		await screen.findByText("The checks passed.");
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Mi borrador de Release");
		await userEvent.click(screen.getByRole("button", { name: "Todos los agentes" }));
		await userEvent.click(screen.getByRole("button", { name: "Otra sesión · Te necesita" }));
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("");
		await userEvent.type(screen.getByLabelText("Continuar esta sesión"), "Otro borrador");
		await userEvent.click(screen.getByRole("button", { name: "Todos los agentes" }));
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Mi borrador de Release");
		const viewport = view.container.querySelector(".agent-detail-scroll") as HTMLDivElement;
		Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1500 });
		Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 400 });
		viewport.scrollTop = 320;
		fireEvent.scroll(viewport);
		view.rerender(<OrchestrationPanel controls={controls} client={client} active={false} />);
		viewport.scrollTop = 0;
		view.rerender(<OrchestrationPanel controls={controls} client={client} active />);
		expect(viewport.scrollTop).toBe(320);
		expect(screen.getByLabelText("Continuar esta sesión")).toHaveValue("Mi borrador de Release");
	});
	it("prepends full pages with stable ids and never discards loaded earlier messages on refresh", async () => {
		const latest: AgentConversation = {
			sessionId: "s1",
			status: "idle",
			question: null,
			history: { supported: true, hasEarlier: true, before: "m40" },
			messages: Array.from({ length: 40 }, (_, i) => ({
				id: `m${i + 40}`,
				role: "assistant" as const,
				content: [{ type: "text" as const, text: `Mensaje ${i + 40}` }],
			})),
		};
		const { view, client, controls } = setup({ ...snapshot, approvals: [] }, latest);
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		expect(await screen.findByText("Mensaje 40")).toBeVisible();
		expect(screen.getAllByRole("article")).toHaveLength(40);
		const viewport = view.container.querySelector(".agent-detail-scroll") as HTMLDivElement;
		Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1500 });
		viewport.scrollTop = 24;
		fireEvent.scroll(viewport);
		vi.mocked(client.inspect).mockImplementation(async (_pane, _session, _signal, page) => {
			if (!page) return latest;
			Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2500 });
			return {
				...latest,
				history: { supported: true, hasEarlier: false },
				messages: [
					{ id: "m39", role: "user", content: [{ type: "text", text: "El comienzo" }] },
					...latest.messages.slice(0, 1),
				],
			};
		});
		await userEvent.click(screen.getByRole("button", { name: "Ver mensajes anteriores" }));
		expect(await screen.findByText("El comienzo")).toBeVisible();
		expect(client.inspect).toHaveBeenLastCalledWith("p1", "s1", expect.any(AbortSignal), {
			before: "m40",
			limit: 50,
		});
		expect(screen.getAllByRole("article")).toHaveLength(41);
		expect(screen.queryByRole("button", { name: "Ver mensajes anteriores" })).toBeNull();
		view.rerender(
			<OrchestrationPanel
				controls={{
					...controls,
					snapshot: { ...snapshot, sessions: snapshot.sessions.map((s) => ({ ...s })) },
				}}
				client={client}
			/>,
		);
		fireEvent(document, new Event("visibilitychange"));
		await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(3));
		expect(screen.getByText("El comienzo")).toBeVisible();
		expect(screen.queryByRole("button", { name: "Ver mensajes anteriores" })).toBeNull();
	});
	it("discards an earlier page when the host changes branches before it returns", async () => {
		const latest: AgentConversation = { sessionId: "s1", status: "idle", question: null,
			history: { supported: true, hasEarlier: true, before: "old-cursor" },
			messages: [{ id: "old-tail", role: "assistant", content: [{ type: "text", text: "Rama anterior" }] }] };
		const replacement: AgentConversation = { ...latest, history: { supported: true, hasEarlier: true, before: "new-cursor" },
			messages: [{ id: "new-tail", role: "assistant", content: [{ type: "text", text: "Rama actual" }] }] };
		const { client } = setup({ ...snapshot, approvals: [] }, latest);
		await userEvent.click(screen.getByRole("button", { name: "Release · Te necesita" }));
		await screen.findByText("Rama anterior");
		let finish!: (value: AgentConversation) => void;
		vi.mocked(client.inspect).mockImplementation(async (_pane, _session, _signal, page) =>
			page ? new Promise<AgentConversation>(resolve => { finish = resolve; }) : replacement);
		await userEvent.click(screen.getByRole("button", { name: "Ver mensajes anteriores" }));
		fireEvent(document, new Event("visibilitychange"));
		await screen.findByText("Rama actual");
		await act(async () => finish({ ...latest, messages: [{ id: "old-history", role: "assistant", content: [{ type: "text", text: "Contenido descartado" }] }] }));
		expect(screen.queryByText("Contenido descartado")).toBeNull();
		expect(screen.queryByText("Rama anterior")).toBeNull();
		expect(screen.getByText("Rama actual")).toBeVisible();
		expect(screen.getByText("El historial cambió mientras se cargaba. Vuelve a pedir los mensajes anteriores.")).toBeVisible();
	});
});
