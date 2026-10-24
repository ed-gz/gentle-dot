import type { ConnectorInfo } from "@gentle-dot/protocol";
import { useCallback, useEffect, useState } from "react";
import {
	type ComputerCapabilities,
	type ComputerPermission,
	type ComputerPermissions,
	type ComputerSession,
	type ComputerYolo,
	timeLeft,
} from "../computer.ts";

/** Computer control in the desktop panel (S24.5, S24.6); the web page never gets it. */
export interface ComputerControls {
	/** The app has a helper (macOS or Linux), so the Connectors screen offers it. */
	available: boolean;
	/** The session the user allowed, while it lasts. */
	session?: ComputerSession;
	/** Yolo mode, while it is on (S24.9). */
	yolo?: ComputerYolo;
	stop: () => void;
	/** Asks the app; its native confirmation decides, and the state follows. */
	setYolo: (enabled: boolean) => Promise<unknown>;
	permissions: () => Promise<ComputerPermissions>;
	capabilities?: () => Promise<ComputerCapabilities>;
	requestPermission: (kind: ComputerPermission) => Promise<unknown>;
}

const PERMISSIONS: [ComputerPermission, string][] = [
	["accessibility", "Accessibility"],
	["screenRecording", "Screen Recording"],
];

export const DEBUG_BUILD_NOTE =
	"Debug builds lose these permissions on every rebuild because macOS ties them to the app's signature; grant them again after updating.";
const YOLO_NOTE =
	"Yolo mode lets the assistant send, pay, delete, and submit without asking you first. It turns itself off after 1 hour or when the app quits; Stop remains available in the app.";
const NO_IMAGES_NOTE =
	"The current model does not accept images, so the assistant cannot see your screen. Choose a model that does in Profiles.";

interface ComputerBannerProps {
	session: ComputerSession;
	yolo: boolean;
	stop: () => void;
}

/** "Controlling your computer · mm:ss left" with a Stop button, while a session is active. */
export function ComputerBanner({ session, yolo, stop }: ComputerBannerProps) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const left = session.endsAt === undefined ? "" : ` · ${timeLeft(session.endsAt, now)} left`;
	return (
		<section className="computer-banner" aria-label="Computer control">
			<span className="computer-banner-light" aria-hidden="true" />
			<span>Controlling your computer{left}</span>
			{yolo ? (
				<span className="chip computer-yolo-chip" title="Risky actions run without asking you first">
					Yolo
				</span>
			) : null}
			<button type="button" className="primary" onClick={stop}>
				Stop
			</button>
		</section>
	);
}

interface ComputerEntryProps {
	/** The daemon's built-in entry, once the helper is registered. */
	info?: ConnectorInfo;
	controls: ComputerControls;
}

/** The built-in Computer connector: the macOS permissions it needs and how to grant them. */
export function ComputerEntry({ info, controls }: ComputerEntryProps) {
	const { permissions, capabilities, requestPermission, yolo, setYolo } = controls;
	const [capability, setCapability] = useState<ComputerCapabilities>();
	const macPermissions = capability?.platform === "macos" || capabilities === undefined;
	const [granted, setGranted] = useState<ComputerPermissions>();
	const check = useCallback(() => {
		permissions().then(setGranted, () => setGranted(undefined));
		capabilities?.().then(setCapability, () => setCapability(undefined));
	}, [permissions, capabilities]);
	useEffect(check, [check]);

	return (
		<li className="computer-entry" aria-labelledby="connector-computer">
			<div className="provider-name">
				<b id="connector-computer">Computer</b>
				<span className="chip connector-connected">Built in</span>
			</div>
			{info ? (
				<>
					<p className="connector-note">{info.reads}</p>
					<p className="connector-note">{info.sends}</p>
				</>
			) : null}
			<ul className="computer-permissions">
				{PERMISSIONS.map(([kind, label]) => {
					const allowed = granted?.[kind] === true;
					const id = `computer-permission-${kind}`;
					return (
						<li key={kind} aria-labelledby={id}>
							<span id={id}>
								{capability?.platform === "linux"
									? kind === "accessibility"
										? "Keyboard and pointer"
										: "Screen capture"
									: label}
							</span>
							<span className={`chip ${allowed ? "connector-connected" : "connector-needs_setup"}`}>
								{granted === undefined ? "Checking…" : allowed ? "Allowed" : "Not allowed"}
							</span>
							{granted !== undefined && !allowed && macPermissions ? (
								<button
									type="button"
									className="primary"
									aria-label={`Grant ${label}`}
									onClick={() => {
										requestPermission(kind).then(check, check);
									}}
								>
									Grant
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
			<div className="provider-actions">
				<button type="button" onClick={check}>
					Check again
				</button>
			</div>
			<div className="computer-yolo">
				<span id="computer-yolo-label">Yolo mode</span>
				<button
					type="button"
					role="switch"
					className="switch"
					aria-checked={yolo !== undefined}
					aria-labelledby="computer-yolo-label"
					onClick={() => {
						setYolo(yolo === undefined).catch(() => {});
					}}
				>
					<span className="switch-knob" aria-hidden="true" />
				</button>
			</div>
			<p className="connector-note">{YOLO_NOTE}</p>
			{macPermissions ? <p className="connector-note">{DEBUG_BUILD_NOTE}</p> : null}
			{capability?.missingDependencies.length ? (
				<p className="connector-note">
					Missing on this computer: {capability.missingDependencies.join(", ")}
				</p>
			) : null}
			{capability?.limitations.length ? (
				<details>
					<summary>Compatibility</summary>
					{capability.limitations.map((note) => (
						<p className="connector-note" key={note}>
							{note}
						</p>
					))}
				</details>
			) : null}
			{info?.noImages ? <p className="connector-note computer-warning">{NO_IMAGES_NOTE}</p> : null}
		</li>
	);
}
