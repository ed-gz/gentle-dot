import { useEffect, useState } from "react";
import type { ProviderUsage, UsageClient, UsageSnapshot, UsageWindow } from "../usage.ts";
import { type BadgeWindow, type UsageBadgePreferences, useUsageBadges } from "../useUsageBadges.ts";
import { UsageGlyph } from "./UsageGlyph.tsx";
import "../usage-badges.css";

function kind(window: UsageWindow): BadgeWindow | undefined {
	if (window.windowDurationMins === 300 || window.id === "five_hour") return "5h";
	if (window.windowDurationMins === 10080 || window.id === "seven_day") return "weekly";
	return undefined;
}
export function priorityWindow(provider: ProviderUsage, preferences: UsageBadgePreferences) {
	const settings = preferences.providers[provider.id];
	const order: BadgeWindow[] = settings.priority === "5h" ? ["5h", "weekly"] : ["weekly", "5h"];
	for (const candidate of order) {
		if (!(candidate === "5h" ? settings.fiveHour : settings.weekly)) continue;
		const windows = provider.windows.filter((window) => kind(window) === candidate);
		const canonical = candidate === "5h" ? ["primary_window", "five_hour"] : ["secondary_window", "seven_day"];
		const selected = windows.find((window) => canonical.includes(window.id)) ?? windows[0];
		if (selected) return selected;
	}
	return undefined;
}

export function UsageBadges({ client }: { client: UsageClient }) {
	const [preferences] = useUsageBadges();
	if (!preferences.visible || !Object.values(preferences.providers).some((p) => p.visible && (p.fiveHour || p.weekly))) return null;
	return <ReadBadges client={client} preferences={preferences} />;
}

function ReadBadges({ client, preferences }: { client: UsageClient; preferences: UsageBadgePreferences }) {
	const [snapshot, setSnapshot] = useState<UsageSnapshot>();
	const [failed, setFailed] = useState(false);
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		let live = true;
		let nextRead = 0;
		let pending = false;
		let controller: AbortController | undefined;
		setSnapshot(undefined);
		setFailed(false);
		const tick = async () => {
			if (document.visibilityState === "hidden") return;
			setNow(Date.now());
			if (pending || Date.now() < nextRead) return;
			pending = true;
			controller = new AbortController();
			try {
				const result = await client.read(controller.signal);
				if (!live) return;
				setSnapshot(result);
				setFailed(false);
				nextRead = Math.max(Date.now() + 60_000, Date.parse(result.refreshAt ?? "") || 0);
			} catch {
				if (live) setFailed(true);
				nextRead = Date.now() + 60_000;
			} finally { pending = false; }
		};
		void tick();
		const timer = setInterval(() => void tick(), 1000);
		const visible = () => { void tick(); };
		document.addEventListener("visibilitychange", visible);
		return () => {
			live = false;
			controller?.abort();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [client]);
	return (
		<div className="usage-badges" aria-label="Consumo resumido">
			{!snapshot ? <span className="usage-badge-placeholder" role="status">{failed ? "Consumo no disponible" : "Consultando consumo…"}</span> : null}
			{snapshot?.providers.filter((provider) => preferences.providers[provider.id]?.visible &&
				(preferences.providers[provider.id].fiveHour || preferences.providers[provider.id].weekly) &&
				(!["unauthenticated", "expired"].includes(provider.status) || provider.windows.length > 0)
			).map((provider) => {
				const window = priorityWindow(provider, preferences);
				const valid = window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100;
				const historical = failed || provider.stale || provider.status !== "ok" ||
					(window?.resetAt !== undefined && Date.parse(window.resetAt) <= now);
				const value = valid ? `${new Intl.NumberFormat("es", { maximumFractionDigits: 1 }).format(window.usedPercent)}%` : "—";
				const label = `${provider.label}, ${window?.label ?? "ventana prioritaria"}: ${valid ? `${value} usado${historical ? " · lectura anterior" : ""}` : "no disponible"}`;
				return <span key={provider.id} className={`usage-badge${historical ? " usage-badge-stale" : ""}`} role="img" aria-label={label} title={label}>
					<UsageGlyph kind={provider.id} />
					<span>{value}{valid && historical ? "*" : ""}</span>
					{window ? <UsageGlyph kind={kind(window) === "5h" ? "clock" : "calendar"} /> : null}
				</span>;
			})}
		</div>
	);
}
