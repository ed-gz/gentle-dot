import { useCallback, useEffect, useRef, useState } from "react";
import type { OrchestrationAction, OrchestrationClient, OrchestrationSnapshot } from "./orchestration.ts";

export interface OrchestrationControls {
	snapshot?: OrchestrationSnapshot;
	error?: string;
	busy: boolean;
	refresh(): Promise<void>;
	act(action: OrchestrationAction): Promise<boolean>;
}

/** One request at a time; the native monitor handles alerts while the document is hidden. */
export function useOrchestration(
	client: OrchestrationClient | undefined,
	visible = true,
): OrchestrationControls {
	const [snapshot, setSnapshot] = useState<OrchestrationSnapshot>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const loading = useRef(false);
	const mutating = useRef(false);
	const active = useRef(client);
	active.current = client;
	const verified = useRef<OrchestrationClient | undefined>(undefined);
	const abort = useRef<AbortController | undefined>(undefined);

	const refresh = useCallback(async () => {
		if (!client || loading.current || document.visibilityState === "hidden") return;
		loading.current = true;
		const controller = new AbortController();
		abort.current = controller;
		try {
			const next = await client.snapshot(controller.signal);
			if (active.current !== client || controller.signal.aborted) return;

			verified.current = client;
			setSnapshot(next);
			setError(undefined);
		} catch (problem) {
			if (!controller.signal.aborted && active.current === client)
				setError(problem instanceof Error ? problem.message : "No se pudo contactar con el equipo.");
		} finally {
			if (abort.current === controller) loading.current = false;
		}
	}, [client]);

	useEffect(() => {
		loading.current = false;
		verified.current = undefined;
		if (client === active.current) setSnapshot(undefined);
		setError(undefined);
	}, [client]);

	useEffect(() => {
		if (!client) return;
		let live = true;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			await refresh();
			if (live) timer = setTimeout(poll, document.visibilityState === "hidden" || !visible ? 15_000 : 4_000);
		};
		void poll();
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
			else abort.current?.abort();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			live = false;
			clearTimeout(timer);
			abort.current?.abort();
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [client, refresh, visible]);

	const act = useCallback(
		async (action: OrchestrationAction) => {
			if (!client || active.current !== client || verified.current !== client || mutating.current)
				return false;
			mutating.current = true;
			setBusy(true);
			setError(undefined);
			try {
				await client.act(action);
				if (active.current !== client) return false;
				// A confirmed mutation must not wait for discovery of every other terminal.
				void refresh();
				return active.current === client;
			} catch (problem) {
				if (active.current === client)
					setError(
						problem instanceof Error
							? problem.message
							: "No se pudo confirmar la acción. Actualiza el estado antes de volver a intentar.",
					);
				return false;
			} finally {
				mutating.current = false;
				setBusy(false);
			}
		},
		[client, refresh],
	);

	return { snapshot: verified.current === client ? snapshot : undefined, error, busy, refresh, act };
}
