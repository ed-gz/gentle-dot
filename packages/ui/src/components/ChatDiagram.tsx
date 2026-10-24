import { useEffect, useId, useRef, useState } from "react";

let rendering: Promise<unknown> = Promise.resolve();
let loaded: Promise<typeof import("mermaid")["default"]> | undefined;
function renderer() {
	loaded ??= import("mermaid").then(({ default: mermaid }) => mermaid);
	return loaded;
}
/** The SVG is displayed as an image, never inserted as executable model-authored markup. */
export function ChatDiagram({ source }: { source: string }) {
	const id = useId().replace(/[^a-z0-9]/gi, "");
	const root = useRef<HTMLElement>(null);
	const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [themeRevision, setThemeRevision] = useState(0);
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (!root.current || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "160px" },
		);
		observer.observe(root.current);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		const chat = root.current?.closest(".chat");
		if (!chat) return;
		const observer = new MutationObserver(() => setThemeRevision((value) => value + 1));
		observer.observe(chat, {
			attributes: true,
			attributeFilter: ["data-chat-theme", "data-chat-accent", "style"],
		});
		return () => observer.disconnect();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Theme tokens are read from the containing chat when its preferences change.
	useEffect(() => {
		if (!visible) return;
		let live = true;
		let image: string | undefined;
		setUrl(undefined);
		setError(false);
		const timer = setTimeout(() => {
			// Model directives, external resources and oversized diagrams remain readable as source.
			if (
				source.length > 12000 ||
				/^\s*(?:---|%%\{)/m.test(source) ||
				/\b(?:https?:|data:|javascript:|url\s*\(|click\s+|img\s*:)/i.test(source)
			) {
				setError(true);
				return;
			}
			rendering = rendering
				.catch(() => {})
				.then(async () => {
					if (!live) return;
					try {
						const mermaid = await renderer();
						if (!live) return;
						const style = getComputedStyle(root.current ?? document.documentElement);
						const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
						mermaid.initialize({
							startOnLoad: false,
							fontFamily: "system-ui, sans-serif",
							securityLevel: "strict",
							suppressErrorRendering: true,
							maxTextSize: 12000,
							maxEdges: 120,
							htmlLabels: false,
							flowchart: { htmlLabels: false },
							theme: "base",
							themeVariables: {
								primaryColor: color("--surface-2", "#241822"),
								primaryTextColor: color("--text", "#f6eff3"),
								primaryBorderColor: color("--accent", "#f095c8"),
								lineColor: color("--muted", "#a78e9b"),
								secondaryColor: color("--surface", "#20161e"),
								tertiaryColor: color("--surface-2", "#241822"),
								edgeLabelBackground: color("--surface-2", "#241822"),
								fontFamily: "system-ui, sans-serif",
							},
						});
						const { svg } = await mermaid.render(`dot-diagram-${id}`, source);
						if (!live) return;
						image = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
						setUrl(image);
					} catch {
						if (live) setError(true);
					}
				});
		}, 350);
		return () => {
			live = false;
			clearTimeout(timer);
			if (image) URL.revokeObjectURL(image);
		};
	}, [source, id, visible, themeRevision]);
	useEffect(() => {
		if (!expanded) return;
		dialog.current?.showModal();
		const back = (event: Event) => {
			if (!event.defaultPrevented) {
				event.preventDefault();
				setExpanded(false);
			}
		};
		window.addEventListener("gentledot-back", back, true);
		return () => window.removeEventListener("gentledot-back", back, true);
	}, [expanded]);
	return (
		<figure className="chat-diagram" ref={root}>
			{url ? (
				<button
					type="button"
					className="chat-diagram-open"
					aria-label="Ampliar diagrama"
					onClick={() => setExpanded(true)}
				>
					<img src={url} alt="Diagrama del flujo de trabajo" />
					<span>Ampliar</span>
				</button>
			) : (
				<p className="chat-diagram-loading">
					{error ? "Vista previa no disponible" : "Preparando diagrama…"}
				</p>
			)}
			<details className="chat-diagram-source" open={error}>
				<summary>Ver descripción del diagrama</summary>
				<pre>
					<code>{source}</code>
				</pre>
			</details>
			{expanded && url ? (
				<dialog
					ref={dialog}
					className="chat-diagram-viewer"
					aria-label="Diagrama ampliado"
					onCancel={() => setExpanded(false)}
				>
					<header>
						<strong>Diagrama</strong>
						<button type="button" aria-label="Cerrar diagrama" onClick={() => setExpanded(false)}>
							×
						</button>
					</header>
					<div>
						<img src={url} alt="Diagrama del flujo de trabajo" />
					</div>
				</dialog>
			) : null}
		</figure>
	);
}
