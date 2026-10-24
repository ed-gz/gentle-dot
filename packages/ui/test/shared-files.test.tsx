import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedFileContext, SharedMarkdown } from "../src/components/SharedMarkdown.tsx";
import {
	createSharedFileClient,
	type SharedFileClient,
	type SharedFileInfo,
	sharedFileId,
} from "../src/shared-files.ts";

const origin = "https://computer.tailnet.ts.net";
const id = "A".repeat(43);
const path = `/api/files/${id}/content`;
const info = { url: `${origin.replace("https:", "wss:")}/ws`, token: "private-test-key" };
const file: SharedFileInfo = { id, name: "informe.pdf", size: 3, mime: "application/pdf", image: false };
const image: SharedFileInfo = { ...file, name: "captura.png", mime: "image/png", image: true };
const controller = () => new AbortController();

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
	vi.stubGlobal("IntersectionObserver", undefined);
	URL.createObjectURL = vi.fn(() => "blob:test-preview");
	URL.revokeObjectURL = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
		configurable: true,
		value() {
			this.open = true;
		},
	});
});
afterEach(() => {
	delete window.__GENTLE_MOBILE__;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
});

function fakeClient(overrides: Partial<SharedFileClient> = {}): SharedFileClient {
	return {
		idFromHref: (href) => sharedFileId(href, origin),
		metadata: vi.fn(async () => file),
		preview: vi.fn(async () => new Blob(["png"])),
		receive: vi.fn(async () => ({ status: "saved" as const })),
		canShare: () => true,
		...overrides,
	};
}
const chat = (client: SharedFileClient, text = `[informe](${path})`) => (
	<SharedFileContext value={client}>
		<SharedMarkdown>{text}</SharedMarkdown>
	</SharedFileContext>
);

describe("authenticated files from the connected computer", () => {
	it("recognizes only that computer's exact private route; no foreign origin, credential, query or local path", () => {
		expect(sharedFileId(path, origin)).toBe(id);
		expect(sharedFileId(`${origin}${path}`, origin)).toBe(id);
		for (const href of [
			`https://other.ts.net${path}`,
			`//evil.test${path}`,
			`${path}?token=secret`,
			`${path}#x`,
			"file:///etc/passwd",
			"/api/files/../token",
			`https://user:pass@computer.tailnet.ts.net${path}`,
		])
			expect(sharedFileId(href, origin)).toBeUndefined();
	});
	it("sends keys only in headers, disallows redirects and rejects forged metadata", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(Response.json(file));
		const client = createSharedFileClient(info);
		expect(await client.metadata(id, controller().signal)).toEqual(file);
		expect(fetch).toHaveBeenCalledWith(
			`${origin}/api/files/${id}/meta`,
			expect.objectContaining({
				headers: { Authorization: "Bearer private-test-key" },
				credentials: "omit",
				redirect: "error",
				cache: "no-store",
			}),
		);
		for (const bad of [
			{ ...file, name: "../../private" },
			{ ...file, size: 51 * 1024 * 1024 },
			{ ...image, mime: "image/svg+xml" },
			{ ...file, id: "B".repeat(43) },
		]) {
			vi.mocked(fetch).mockResolvedValueOnce(Response.json(bad));
			await expect(client.metadata(id, controller().signal)).rejects.toThrow("no válido");
		}
	});
	it("does not fetch previews for unsafe types or large images; enforces the byte count on streaming responses", async () => {
		const client = createSharedFileClient(info);
		await expect(client.preview(file, controller().signal)).rejects.toThrow("Guarda");
		await expect(client.preview({ ...image, size: 9 * 1024 * 1024 }, controller().signal)).rejects.toThrow(
			"Guarda",
		);
		expect(fetch).not.toHaveBeenCalled();
		vi.mocked(fetch).mockResolvedValueOnce(new Response("too much"));
		await expect(client.preview(image, controller().signal)).rejects.toThrow("supera");
		vi.mocked(fetch).mockResolvedValueOnce(new Response("ab"));
		await expect(client.preview(image, controller().signal)).rejects.toThrow("incompleta");
		vi.mocked(fetch).mockResolvedValueOnce(new Response("png"));
		expect((await client.preview(image, controller().signal)).size).toBe(3);
	});
	it("explains revoked access without exposing credentials", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response("", { status: 401 }));
		await expect(createSharedFileClient(info).metadata(id, controller().signal)).rejects.toThrow(
			"ya no tiene acceso",
		);
	});
	it("hands authenticated downloads to Android only after a user action and cancels the native transfer", async () => {
		let finish: ((value: { status: "cancelled" }) => void) | undefined;
		const receiveFile = vi.fn(
			() =>
				new Promise<{ status: "cancelled" }>((resolve) => {
					finish = resolve;
				}),
		);
		const cancelReceiveFile = vi.fn(async () => {
			finish?.({ status: "cancelled" });
		});
		window.__GENTLE_MOBILE__ = { transcribe: vi.fn(), receiveFile, cancelReceiveFile };
		const abort = controller();
		const pending = createSharedFileClient(info).receive(file, "save", abort.signal);
		expect(receiveFile).toHaveBeenCalledWith({
			url: `${origin}${path}`,
			token: info.token,
			name: file.name,
			mime: file.mime,
			action: "save",
		});
		abort.abort();
		expect(await pending).toEqual({ status: "cancelled" });
		expect(cancelReceiveFile).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("file cards in chat", () => {
	it("shows just one image in chat even when the reply repeats its download link; actions live only in its viewer", async () => {
		const client = fakeClient({ metadata: vi.fn(async () => image) });
		render(
			chat(client, `[Descargar](${path})\n\n![Captura del resultado](${path})\n\n![Duplicada](${path})`),
		);
		const card = await screen.findByRole("group", { name: "Archivo: captura.png" });
		await within(card).findByRole("img", { name: "Captura del resultado" });
		expect(screen.getAllByRole("group")).toHaveLength(1);
		expect(within(card).getAllByRole("button")).toHaveLength(1);
		expect(screen.queryByText("Guardar archivo")).not.toBeInTheDocument();
		expect(screen.queryByText("captura.png")).not.toBeInTheDocument();
		expect(client.metadata).toHaveBeenCalledOnce();
		expect(client.receive).not.toHaveBeenCalled();
		await userEvent.click(within(card).getByRole("button", { name: "Ampliar captura.png" }));
		const viewer = screen.getByRole("dialog", { name: "captura.png" });
		await userEvent.click(within(viewer).getByRole("button", { name: "Descargar imagen" }));
		expect(client.receive).toHaveBeenCalledWith(image, "save", expect.any(AbortSignal));
		await userEvent.click(within(viewer).getByRole("button", { name: "Compartir imagen" }));
		expect(client.receive).toHaveBeenLastCalledWith(image, "share", expect.any(AbortSignal));
		await userEvent.click(within(viewer).getByRole("button", { name: "Cerrar imagen" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(client.preview).toHaveBeenCalledOnce();
	});
	it("keeps lazy previews alive while open, then revokes them when closed outside the reading viewport", async () => {
		let visibility: (entries: { isIntersecting: boolean }[]) => void = () => {};
		const disconnect = vi.fn();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: typeof visibility) {
					visibility = callback;
				}
				observe() {}
				disconnect = disconnect;
			},
		);
		const client = fakeClient({ metadata: vi.fn(async () => image) });
		const view = render(chat(client, `![Captura](${path})`));
		await screen.findByRole("group", { name: "Archivo: captura.png" });
		expect(client.preview).not.toHaveBeenCalled();
		act(() => visibility([{ isIntersecting: true }]));
		await userEvent.click(await screen.findByRole("button", { name: "Ampliar captura.png" }));
		act(() => visibility([{ isIntersecting: false }]));
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Cerrar imagen" }));
		expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
		expect(client.preview).toHaveBeenCalledOnce();
		view.unmount();
		expect(disconnect).toHaveBeenCalledOnce();
	});
	it("allows large images to download from the viewer without fetching an oversized preview", async () => {
		const client = fakeClient({ metadata: vi.fn(async () => ({ ...image, size: 9 * 1024 * 1024 })) });
		render(chat(client));
		await userEvent.click(await screen.findByRole("button", { name: "Abrir captura.png" }));
		expect(client.preview).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Descargar imagen" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Ampliar imagen" })).toBeDisabled();
	});
	it("renders a named card and waits for the user to save or share", async () => {
		const client = fakeClient();
		render(chat(client));
		await screen.findByText("informe.pdf");
		expect(client.receive).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Guardar archivo" }));
		expect(client.receive).toHaveBeenCalledWith(file, "save", expect.any(AbortSignal));
		await screen.findByText(/Archivo recibido/);
		await userEvent.click(screen.getByRole("button", { name: "Compartir" }));
		expect(client.receive).toHaveBeenLastCalledWith(file, "share", expect.any(AbortSignal));
	});
	it("keeps the pending transfer mounted when the assistant streams more text", async () => {
		let done: ((value: { status: "saved" }) => void) | undefined;
		const client = fakeClient({
			receive: vi.fn(
				() =>
					new Promise<{ status: "saved" }>((resolve) => {
						done = resolve;
					}),
			),
		});
		const view = render(chat(client));
		await userEvent.click(await screen.findByRole("button", { name: "Guardar archivo" }));
		view.rerender(chat(client, `[informe](${path})\n\nAquí tienes el resultado.`));
		expect(screen.getByRole("button", { name: "Guardar archivo" })).toBeDisabled();
		expect(client.metadata).toHaveBeenCalledOnce();
		await act(async () => done?.({ status: "saved" }));
		await screen.findByText(/Archivo recibido/);
	});
	it("preserves an image download and its viewer when streaming adds the same attachment as image Markdown", async () => {
		let done: ((value: { status: "saved" }) => void) | undefined;
		let signal: AbortSignal | undefined;
		const client = fakeClient({
			metadata: vi.fn(async () => image),
			receive: vi.fn((_file, _action, nextSignal) => {
				signal = nextSignal;
				return new Promise<{ status: "saved" }>((resolve) => {
					done = resolve;
				});
			}),
		});
		const view = render(chat(client, `[Captura](${path})`));
		await userEvent.click(await screen.findByRole("button", { name: "Ampliar captura.png" }));
		await userEvent.click(screen.getByRole("button", { name: "Descargar imagen" }));
		view.rerender(chat(client, `[Captura](${path})\n\n![Vista del resultado](${path})`));
		expect(screen.getByRole("dialog", { name: "captura.png" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Descargar imagen" })).toBeDisabled();
		expect(signal?.aborted).toBe(false);
		expect(client.metadata).toHaveBeenCalledOnce();
		expect(client.preview).toHaveBeenCalledOnce();
		await act(async () => done?.({ status: "saved" }));
		await screen.findByText(/Archivo recibido/);
	});
	it("revokes image object URLs when the card unmounts and preserves the alt text", async () => {
		const client = fakeClient({ metadata: vi.fn(async () => image) });
		const view = render(chat(client, `![Captura del resultado](${path})`));
		const preview = await screen.findByRole("img", { name: "Captura del resultado" });
		expect(preview).toHaveAttribute("src", "blob:test-preview");
		expect(client.preview).toHaveBeenCalledWith(image, expect.any(AbortSignal));
		view.unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-preview");
	});
	it("allows retry after an offline metadata request and preserves ordinary web links", async () => {
		const metadata = vi.fn().mockRejectedValueOnce(new Error("Sin conexión")).mockResolvedValue(file);
		render(chat(fakeClient({ metadata }), `[informe](${path}) y [referencia](https://example.org/info)`));
		await screen.findByText("Sin conexión");
		expect(screen.getByRole("link", { name: "referencia" })).toHaveAttribute(
			"href",
			"https://example.org/info",
		);
		fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
		await waitFor(() => expect(screen.getByText("informe.pdf")).toBeVisible());
	});
});
