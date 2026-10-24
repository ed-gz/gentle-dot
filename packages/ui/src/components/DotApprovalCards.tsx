import { type ReactNode, useEffect, useRef, useState } from "react";
import { mobileBridge } from "../mobile.ts";
import type { DotApproval, OrchestrationClient } from "../orchestration.ts";
import { requestExpired, useRequestExpiry } from "../useRequestExpiry.ts";

import { RequestPresentation } from "./RequestPresentation.tsx";

const inBackground = () => document.visibilityState === "hidden";

export function DotApprovalCards({ client, presentation = false, extraIds = [], children, connected = true }: {
	client: OrchestrationClient; presentation?: boolean; extraIds?: string[]; children?: ReactNode; connected?: boolean;
}) {
	const [requests, setRequests] = useState<DotApproval[]>([]);
	const [allowed, setAllowed] = useState<boolean>();
	const [connectionError, setConnectionError] = useState<string>();
	const [actionError, setActionError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const mutation = useRef(false);
	const activeClient = useRef(client);
	activeClient.current = client;
	const verified = useRef<OrchestrationClient | undefined>(undefined);
	const seenRequests = useRef(new Set<string>());
	const [busyId, setBusyId] = useState<string>();
	useEffect(() => {
		if (activeClient.current === client) {
			setRequests([]);
			seenRequests.current.clear();
			setAllowed(undefined);
			setConnectionError(undefined);
			setActionError(undefined);
		}
	}, [client]);
	useEffect(() => {
		if (!client.dotApprovals || busy) return;
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let polling = false;
		const poll = async () => {
			if (polling || inBackground() || abort.signal.aborted) return;
			polling = true;
			clearTimeout(timer);
			try {
				const next = await client.dotApprovals?.(abort.signal);
				if (!abort.signal.aborted && activeClient.current === client && next && !mutation.current) {
					verified.current = client;
					setRequests(next.approvals);
					for (const request of next.approvals) {
						if (seenRequests.current.has(request.id) || requestExpired(request.expiresAt)) continue;
						seenRequests.current.add(request.id);
						if (seenRequests.current.size > 512)
							seenRequests.current.delete(seenRequests.current.values().next().value as string);
						window.dispatchEvent(
							new CustomEvent("gentledot-notification", {
								detail: {
									id: `dot-approval:${request.id}`,
									title: "Dot necesita tu autorización",
									body: request.title,
									event: "permission",
								},
							}),
						);
					}
					setAllowed(next.allowed);
					setConnectionError(undefined);
				}
			} catch (error) {
				if (!abort.signal.aborted && activeClient.current === client)
					setConnectionError(
						error instanceof Error ? error.message : "No se pudieron consultar los permisos de Gentle Dot.",
					);
			} finally {
				polling = false;
				if (!abort.signal.aborted && !inBackground()) timer = setTimeout(() => void poll(), 4000);
			}
		};
		const visible = () => {
			if (document.visibilityState === "visible") void poll();
			else clearTimeout(timer);
		};
		document.addEventListener("visibilitychange", visible);
		void poll();
		return () => {
			abort.abort();
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [client, busy]);

	async function answer(request: DotApproval, approved: boolean) {
		if (
			!connected ||
			!client.answerDotApproval ||
			mutation.current ||
			!allowed ||
			verified.current !== client ||
			connectionError ||
			requestExpired(request.expiresAt)
		)
			return;
		mutation.current = true;
		setBusy(true);
		setBusyId(request.id);
		setActionError(undefined);
		try {
			await client.answerDotApproval(request.id, approved);
			if (activeClient.current === client)
				setRequests((items) => items.filter((item) => item.id !== request.id));
		} catch (error) {
			if (activeClient.current === client)
				setActionError(
					error instanceof Error
						? error.message
						: "No se pudo confirmar tu respuesta. Revisa el estado antes de intentarlo otra vez.",
				);
		} finally {
			mutation.current = false;
			setBusy(false);
			setBusyId(undefined);
		}
	}

	const present = (content: ReactNode, ids: string[] = []) => (
		<RequestPresentation enabled={presentation} ids={[...extraIds, ...ids]} title={extraIds.length ? "Solicitudes pendientes" : "Permisos de Gentle Dot"}>
			{children}{content}
		</RequestPresentation>
	);
	if (verified.current !== client)
		return present(connectionError ? <p className="orchestration-error" role="alert">{connectionError}</p> : null);
	if (allowed === false && !mobileBridge()) return present(null);
	if (!requests.length && allowed !== false && !connectionError && !actionError) return present(null);
	return present(
		<section className="orchestration-section" aria-label="Permisos de Gentle Dot">
			<h3>Permisos de Gentle Dot</h3>
			{allowed === false ? (
				<p className="orchestration-intro">
					Para aprobar permisos de Dot, vuelve a vincular este teléfono con la app de escritorio abierta y
					acepta allí el acceso. Puedes seguir usando el chat y las sesiones.
				</p>
			) : null}
			{connectionError || actionError ? (
				<p className="orchestration-error" role="alert">
					{connectionError || actionError}
				</p>
			) : null}
			{requests.map((request) => (
				<DotApprovalCard
					key={request.id}
					request={request}
					locked={!connected || busy || !allowed || Boolean(connectionError)}
					sending={busyId === request.id}
					answer={answer}
				/>
			))}
		</section>,
		requests.length ? requests.map((request) => request.id) : ["dot-permission-status"],
	);
}

function DotApprovalCard({
	request,
	locked,
	sending,
	answer,
}: {
	request: DotApproval;
	locked: boolean;
	sending: boolean;
	answer: (request: DotApproval, approved: boolean) => Promise<void>;
}) {
	const expired = useRequestExpiry(request.expiresAt);
	return (
		<article className="card agent-approval">
			<h4>{request.title}</h4>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: full permission detail is scrollable on the phone. */}
			<pre className="dot-approval-detail" tabIndex={0}>
				{request.message}
			</pre>
			<p className="muted" role="status">
				{sending
					? "Enviando respuesta…"
					: expired
						? "Este permiso ya venció."
						: `Vence ${new Date(request.expiresAt).toLocaleString("es")}`}
			</p>
			<div className="agent-actions">
				<button
					type="button"
					className="primary"
					aria-label="Aprobar permiso de Dot"
					disabled={locked || expired}
					onClick={() => void answer(request, true)}
				>
					Permitir
				</button>
				<button
					type="button"
					aria-label="Rechazar permiso de Dot"
					disabled={locked || expired}
					onClick={() => void answer(request, false)}
				>
					Rechazar
				</button>
			</div>
		</article>
	);
}
