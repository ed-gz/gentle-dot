import {
	Children,
	createContext,
	isValidElement,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl as openExternal } from "../desktop.ts";
import { MAX_IMAGE_PREVIEW_BYTES, type SharedFileClient, type SharedFileInfo } from "../shared-files.ts";
import { formatSize } from "../uploads.ts";
import { ImageViewer } from "./ImageViewer.tsx";
import "../shared-files.css";
import "../rich-chat.css";

const ChatDiagram = lazy(() =>
	import("./ChatDiagram.tsx").then((module) => ({ default: module.ChatDiagram })),
);

export const SharedFileContext = createContext<SharedFileClient | undefined>(undefined);

type AttachmentNode = {
	type: string;
	url?: string;
	alt?: string;
	children?: AttachmentNode[];
	data?: { hProperties?: Record<string, string> };
};
/** Keep the first card mounted when a streaming reply repeats its image or download link. */
function uniqueAttachments(client: SharedFileClient | undefined) {
	return () => (tree: AttachmentNode) => {
		if (!client) return;
		const chosen = new Map<string, AttachmentNode>();
		const visit = (node: AttachmentNode) => {
			const id = (node.type === "image" || node.type === "link") && node.url && client.idFromHref(node.url);
			if (id) {
				const first = chosen.get(id);
				if (!first) chosen.set(id, node);
				else if (
					first.type === "link" &&
					node.type === "image" &&
					node.alt &&
					!first.data?.hProperties?.["data-shared-description"]
				)
					first.data = { hProperties: { "data-shared-description": node.alt } };
			}
			for (const child of node.children ?? []) visit(child);
		};
		visit(tree);
		const prune = (node: AttachmentNode) => {
			if (!node.children) return;
			node.children = node.children.filter((child) => {
				const id =
					(child.type === "image" || child.type === "link") && child.url && client.idFromHref(child.url);
				if (id && chosen.get(id) !== child) return false;
				prune(child);
				return child.type !== "paragraph" || !!child.children?.length;
			});
		};
		prune(tree);
	};
}

export const SharedLinkContext = createContext<(url: string) => void>(openExternal);

/** Private file links are authenticated cards; ordinary Markdown remains ordinary content. */
export function SharedMarkdown({
	children,
	openUrl,
}: {
	children: string;
	openUrl?: (url: string) => void;
}) {
	const platformOpen = useContext(SharedLinkContext);
	const openLink = openUrl ?? platformOpen;
	const client = useContext(SharedFileContext);
	const attachments = useMemo(() => uniqueAttachments(client), [client]);
	const components = useMemo<Components>(
		() => ({
			table: ({ children }) => (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Wide tables must be scrollable with a keyboard.
				<section className="rich-table" aria-label="Tabla" tabIndex={0}>
					<table>{children}</table>
				</section>
			),
			pre: ({ children }) => {
				const child = Children.toArray(children)[0];
				if (
					isValidElement<{ className?: string; children?: ReactNode }>(child) &&
					child.props.className === "language-mermaid" &&
					typeof child.props.children === "string"
				)
					return (
						<Suspense fallback={<p className="muted">Preparando diagrama…</p>}>
							<ChatDiagram source={child.props.children.trim()} />
						</Suspense>
					);
				return <pre>{children}</pre>;
			},
			a: ({ href, children, node }) => {
				const id = href && client?.idFromHref(href);
				const external = typeof href === "string" && /^https?:\/\//i.test(href);
				const description = node?.properties["data-shared-description"];
				return id && client ? (
					<SharedFileCard
						key={id}
						client={client}
						id={id}
						description={typeof description === "string" ? description : undefined}
					/>
				) : (
					<a
						href={href}
						target={external ? "_blank" : undefined}
						rel={external ? "noopener noreferrer" : undefined}
						onClick={
							external
								? (event) => {
										event.preventDefault();
										openLink(href);
									}
								: undefined
						}
					>
						{children}
					</a>
				);
			},
			img: ({ src, alt }) => {
				const id = typeof src === "string" && client?.idFromHref(src);
				return id && client ? (
					<SharedFileCard key={id} client={client} id={id} description={alt} />
				) : (
					<ChatImage src={typeof src === "string" ? src : undefined} alt={alt ?? "Imagen compartida"} />
				);
			},
		}),
		[client, openLink],
	);
	return (
		<Markdown remarkPlugins={[remarkGfm, attachments]} components={components}>
			{children}
		</Markdown>
	);
}

function ChatImage({ src, alt }: { src: string | undefined; alt: string }) {
	const [expanded, setExpanded] = useState(false);
	const [failed, setFailed] = useState(false);
	const root = useRef<HTMLSpanElement>(null);
	const close = useCallback(() => setExpanded(false), []);
	const restoreFocus = useCallback(
		() => root.current?.querySelector("button")?.focus({ preventScroll: true }),
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A replacement URL gets a new load attempt and closes the old preview.
	useEffect(() => {
		setFailed(false);
		setExpanded(false);
	}, [src]);
	if (!src || failed) return <span className="chat-image-unavailable">{alt} · Imagen no disponible</span>;
	return (
		<span className="chat-image" ref={root}>
			<button type="button" aria-label={`Ampliar ${alt}`} onClick={() => setExpanded(true)}>
				<img
					src={src}
					alt={alt}
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setFailed(true)}
				/>
			</button>
			{expanded
				? createPortal(
						<ImageViewer url={src} name={alt} close={close} restoreFocus={restoreFocus} />,
						root.current?.closest(".chat") ?? document.body,
					)
				: null}
		</span>
	);
}

function SharedFileCard({
	client,
	id,
	description,
}: {
	client: SharedFileClient;
	id: string;
	description?: string | undefined;
}) {
	const [file, setFile] = useState<SharedFileInfo>();
	const [error, setError] = useState<string>();
	const [previewError, setPreviewError] = useState<string>();
	const [retry, setRetry] = useState(0);
	const [image, setImage] = useState<string>();
	const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<string>();
	const root = useRef<HTMLSpanElement>(null);
	const transfer = useRef<AbortController | undefined>(undefined);
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
			transfer.current?.abort();
		};
	}, []);
	useEffect(() => {
		if (typeof IntersectionObserver === "undefined" || !root.current) return;
		const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), {
			rootMargin: "200px",
		});
		observer.observe(root.current);
		return () => observer.disconnect();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly requests fresh metadata.
	useEffect(() => {
		const controller = new AbortController();
		setFile(undefined);
		setError(undefined);
		void client.metadata(id, controller.signal).then(
			(value) => {
				if (!controller.signal.aborted) setFile(value);
			},
			(cause: unknown) => {
				if (!controller.signal.aborted)
					setError(cause instanceof Error ? cause.message : "No se pudo cargar el archivo.");
			},
		);
		return () => {
			controller.abort();
			transfer.current?.abort();
		};
	}, [client, id, retry]);
	const previewEnabled = visible || expanded;
	const closeImage = useCallback(() => setExpanded(false), []);
	const restoreFocus = useCallback(
		() => root.current?.querySelector("button")?.focus({ preventScroll: true }),
		[],
	);
	useEffect(() => {
		if (!file?.image || file.size > MAX_IMAGE_PREVIEW_BYTES || !previewEnabled) return;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		setPreviewError(undefined);
		void client.preview(file, controller.signal).then(
			(blob) => {
				if (controller.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setImage(objectUrl);
			},
			() => {
				if (!controller.signal.aborted)
					setPreviewError("Vista previa no disponible. Abre la imagen para descargarla.");
			},
		);
		return () => {
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			setImage(undefined);
		};
	}, [client, file, previewEnabled]);
	const receive = async (action: "save" | "share") => {
		if (!file || transfer.current) return;
		const controller = new AbortController();
		transfer.current = controller;
		setBusy(true);
		setError(undefined);
		setStatus("Recibiendo desde tu equipo…");
		try {
			const result = await client.receive(file, action, controller.signal);
			if (active.current)
				setStatus(
					result.status === "cancelled"
						? "Descarga cancelada."
						: result.status === "shared"
							? "Se abrió el menú para compartir."
							: "Archivo recibido. Revisa la ubicación elegida o tus descargas.",
				);
		} catch (cause) {
			if (!active.current) return;
			if (controller.signal.aborted || (cause instanceof Error && cause.name === "AbortError"))
				setStatus("Descarga cancelada.");
			else {
				setStatus(undefined);
				setError(cause instanceof Error ? cause.message : "No se pudo recibir el archivo.");
			}
		} finally {
			transfer.current = undefined;
			if (active.current) setBusy(false);
		}
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: A file card is phrasing content inside Markdown paragraphs, not a form fieldset.
		<span
			ref={root}
			className={`shared-file${file?.image ? " shared-file-image" : ""}`}
			role="group"
			aria-label={file ? `Archivo: ${file.name}` : "Archivo compartido"}
		>
			{file ? (
				<>
					{file.image ? (
						<span className="shared-file-preview">
							{image ? (
								<button
									type="button"
									className="shared-image-open"
									onClick={() => setExpanded(true)}
									aria-label={`Ampliar ${file.name}`}
								>
									<img
										src={image}
										alt={description || file.name}
										loading="lazy"
										onError={() => {
											setPreviewError("Vista previa no disponible. Abre la imagen para descargarla.");
											setImage(undefined);
										}}
									/>
								</button>
							) : (
								<button
									type="button"
									className="shared-image-placeholder"
									onClick={() => setExpanded(true)}
									aria-label={`Abrir ${file.name}`}
								>
									{previewError ||
										(file.size > MAX_IMAGE_PREVIEW_BYTES ? "Abrir imagen" : "Cargando imagen…")}
								</button>
							)}
						</span>
					) : null}
					{!file.image ? (
						<>
							<span className="shared-file-heading">
								<FileIcon />
								<span>
									<strong>{file.name}</strong>
									<small>{formatSize(file.size)} · Desde tu equipo</small>
								</span>
							</span>
							<span className="shared-file-actions">
								<button type="button" disabled={busy} onClick={() => void receive("save")}>
									Guardar archivo
								</button>
								{client.canShare() ? (
									<button type="button" disabled={busy} onClick={() => void receive("share")}>
										Compartir
									</button>
								) : null}
								{busy ? (
									<button type="button" onClick={() => transfer.current?.abort()}>
										Cancelar
									</button>
								) : null}
							</span>
						</>
					) : null}
				</>
			) : !error ? (
				<span role="status">Cargando archivo…</span>
			) : null}
			{status && !file?.image ? (
				<span role="status" className="shared-file-status">
					{status}
				</span>
			) : null}
			{error && !file?.image ? (
				<span role="alert" className="shared-file-error">
					{error}
					{!file ? (
						<button type="button" onClick={() => setRetry((value) => value + 1)}>
							Reintentar
						</button>
					) : null}
				</span>
			) : null}
			{expanded && file
				? createPortal(
						<ImageViewer
							url={image}
							name={file.name}
							description={description}
							close={closeImage}
							restoreFocus={restoreFocus}
							save={() => void receive("save")}
							share={client.canShare() ? () => void receive("share") : undefined}
							busy={busy}
							status={status}
							error={error}
							cancelTransfer={() => transfer.current?.abort()}
						/>,
						root.current?.closest(".chat") ?? document.body,
					)
				: null}
		</span>
	);
}

function FileIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="24"
			height="24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<path d="M14 2v6h6M8 13h8M8 17h5" />
		</svg>
	);
}
