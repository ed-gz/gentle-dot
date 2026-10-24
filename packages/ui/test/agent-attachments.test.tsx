import type { UploadedFile } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgentAttachments } from "../src/components/AgentAttachments.tsx";
import type { OrchestrationClient } from "../src/orchestration.ts";

type Upload = NonNullable<OrchestrationClient["uploadAttachment"]>;
const uploaded: UploadedFile = {
	uploadId: "u_fixture123",
	name: "voice.wav",
	mime: "application/octet-stream",
	size: 5,
	path: "uploads/u_fixture123/voice.wav",
};

function setup(upload = vi.fn<Upload>(async (_pane, _session, file) => ({
	...uploaded,
	name: file.name,
	size: file.size,
}))) {
	const onSend = vi.fn(async () => true);
	const client = { uploadAttachment: upload } as unknown as OrchestrationClient;
	const props = {
		client,
		paneId: "pi:one",
		sessionId: "one",
		text: "",
		onText: vi.fn(),
		onSend,
		disabled: false,
		images: true,
	};
	const view = render(<AgentAttachments key="one" {...props} />);
	const add = () => fireEvent.change(screen.getByLabelText("Archivos para esta sesión"), {
		target: { files: [new File(["audio"], "voice.wav", { type: "audio/wav" })] },
	});
	return { ...view, props, client, upload, onSend, add };
}

it("uploads attachment-only to the exact session and sends refs once despite repeated submit", async () => {
	const h = setup();
	h.add();
	const form = screen.getByRole("button", { name: "Enviar instrucción" }).closest("form")!;
	fireEvent.submit(form);
	fireEvent.submit(form);
	await waitFor(() => expect(h.onSend).toHaveBeenCalledTimes(1));
	expect(h.upload).toHaveBeenCalledWith(
		"pi:one", "one", expect.any(File), undefined, expect.any(AbortSignal),
	);
	expect(h.onSend).toHaveBeenCalledWith("", [{ uploadId: "u_fixture123", name: "voice.wav" }]);
	expect(screen.queryByText(/no se graba ni transcribe/)).toBeNull();
});

it.each([true, false])("keeps attachment controls without always-visible explanations (images=%s)", (images) => {
	const h = setup();
	h.rerender(<AgentAttachments {...h.props} images={images} />);
	expect(screen.getByLabelText("Archivos para esta sesión")).toBeEnabled();
	expect(screen.getByRole("button", { name: "Enviar instrucción" })).toBeDisabled();
	expect(screen.queryByText(/El audio se adjunta|Las imágenes compatibles|Este modelo no admite imágenes/)).toBeNull();
	expect(screen.queryByText("Imágenes no disponibles")).toBeNull();
	h.add();
	expect(screen.getByText("voice.wav")).toBeVisible();
	expect(screen.getByRole("button", { name: "Quitar voice.wav" })).toBeEnabled();
});

it("retains files when HTTP acknowledgement is rejected, clearing only on acceptance", async () => {
 const h = setup();
 h.onSend.mockResolvedValueOnce(false);
 h.add();
 fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
 await screen.findByRole("alert");
 expect(screen.getByText("voice.wav")).toBeVisible();
 expect(h.onSend).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
 await waitFor(() => expect(screen.queryByText("voice.wav")).toBeNull());
 expect(h.onSend).toHaveBeenCalledTimes(2);
});

it("never dispatches after upload failure and allows removal", async () => {
	const h = setup(vi.fn<Upload>(async () => { throw new Error("offline upload"); }));
	h.add();
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	await screen.findByText("offline upload");
	expect(h.onSend).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Quitar voice.wav" }));
	expect(screen.queryByText("voice.wav")).toBeNull();
});

it("does not invalidate an accepted upload merely because the action is busy", async () => {
 const h = setup();
 let resolve!: (accepted: boolean) => void;
 h.onSend.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
 h.add();
 fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
 await waitFor(() => expect(h.onSend).toHaveBeenCalledTimes(1));
 h.rerender(<AgentAttachments key="one" {...h.props} busy />);
 expect(h.upload.mock.calls[0]![4]!.aborted).toBe(false);
 await act(async () => resolve(true));
 expect(screen.queryByText("voice.wav")).toBeNull();
});

it("aborts and never dispatches pending files when the selected session changes", async () => {
	let resolve!: (file: UploadedFile) => void;
	const h = setup(vi.fn<Upload>(() => new Promise(done => { resolve = done; })));
	h.add();
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	const signal = h.upload.mock.calls[0]![4]!;
	h.rerender(<AgentAttachments key="two" {...h.props} paneId="pi:two" sessionId="two" />);
	expect(signal.aborted).toBe(true);
	await act(async () => resolve(uploaded));
	expect(h.onSend).not.toHaveBeenCalled();
	expect(screen.queryByText("voice.wav")).toBeNull();
});

it.each(["cancel", "disconnect"])("fresh text recovery never revives a late %s upload", async interruption => {
	let resolve!: (file: UploadedFile) => void;
	const h = setup(vi.fn<Upload>(() => new Promise(done => { resolve = done; })));
	h.add();
	const form = screen.getByRole("button", { name: "Enviar instrucción" }).closest("form")!;
	fireEvent.submit(form);
	if (interruption === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancelar subida" }));
	h.rerender(<AgentAttachments key="one" {...h.props} disabled />);
	h.rerender(<AgentAttachments key="one" {...h.props} />);
	fireEvent.submit(form);
	expect(h.onSend).not.toHaveBeenCalled();
	await act(async () => resolve(uploaded));
	expect(h.onSend).not.toHaveBeenCalled();
	if (interruption === "disconnect") fireEvent.click(screen.getByRole("button", { name: "Quitar voice.wav" }));
	h.rerender(<AgentAttachments key="one" {...h.props} text="fresh manual text" />);
	fireEvent.submit(form); fireEvent.submit(form);
	await waitFor(() => expect(h.onSend).toHaveBeenCalledExactlyOnceWith("fresh manual text", undefined));
	expect(h.upload).toHaveBeenCalledTimes(1);
});

it("cancel and disconnect suppress dispatch even when an upload completes", async () => {
	let resolve!: (file: UploadedFile) => void;
	const h = setup(vi.fn<Upload>(() => new Promise(done => { resolve = done; })));
	h.add();
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	fireEvent.click(screen.getByRole("button", { name: "Cancelar subida" }));
	await act(async () => resolve(uploaded));
	expect(h.onSend).not.toHaveBeenCalled();
	h.add();
	fireEvent.click(screen.getByRole("button", { name: "Enviar instrucción" }));
	h.rerender(<AgentAttachments key="one" {...h.props} disabled />);
	await act(async () => resolve(uploaded));
	expect(h.onSend).not.toHaveBeenCalled();
});
