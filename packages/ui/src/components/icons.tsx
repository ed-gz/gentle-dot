import type { ReactNode } from "react";

/** One stroke icon set for the header: 18 px, drawn in the button's text color. */
function Icon({ children }: { children: ReactNode }) {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{children}
		</svg>
	);
}

/** Two chat bubbles: earlier conversations. */
export function ConversationsIcon() {
	return (
		<Icon>
			<path d="M14 9a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2z" />
			<path d="M18 9h1a2 2 0 0 1 2 2v9l-3-3h-6a2 2 0 0 1-2-2v-1" />
		</Icon>
	);
}

/** A key: sign-ins and API keys. */
export function AccountsIcon() {
	return (
		<Icon>
			<circle cx="7.5" cy="15.5" r="4.5" />
			<path d="m10.7 12.3 9.8-9.8" />
			<path d="m16 7 3 3" />
			<path d="m19 4 2 2" />
		</Icon>
	);
}

/** A plug: the apps the assistant can use. */
export function ConnectorsIcon() {
	return (
		<Icon>
			<path d="M9 2v5" />
			<path d="M15 2v5" />
			<path d="M6 7h12v4a6 6 0 0 1-12 0z" />
			<path d="M12 17v5" />
		</Icon>
	);
}

/** Sliders: which model does what. */
export function ProfilesIcon() {
	return (
		<Icon>
			<path d="M4 21v-7" />
			<path d="M4 10V3" />
			<path d="M12 21v-9" />
			<path d="M12 8V3" />
			<path d="M20 21v-5" />
			<path d="M20 12V3" />
			<path d="M2 14h4" />
			<path d="M10 8h4" />
			<path d="M18 16h4" />
		</Icon>
	);
}

export function PlusIcon() {
	return (
		<Icon>
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</Icon>
	);
}

/** A filled square: stop the current reply without expanding the composer. */
export function StopIcon() {
	return (
		<Icon>
			<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />
		</Icon>
	);
}

/** An arrow up, for the composer's send button. */
export function SendIcon() {
	return (
		<Icon>
			<path d="M12 19V5" />
			<path d="m5 12 7-7 7 7" />
		</Icon>
	);
}

/** A microphone: talk to the assistant. */
export function MicIcon() {
	return (
		<Icon>
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0" />
			<path d="M12 18v3" />
		</Icon>
	);
}

/** A paper clip: attach files (S31.1). */
export function PaperclipIcon() {
	return (
		<Icon>
			<path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />
		</Icon>
	);
}

/** Camera capture on mobile. */
export function CameraIcon() {
	return (
		<Icon>
			<path d="M4 7h3l1.5-2h7L17 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
			<circle cx="12" cy="13" r="3.5" />
		</Icon>
	);
}

/** A speaker: spoken replies are on. */
export function SpeakerIcon() {
	return (
		<Icon>
			<path d="M4 9v6h4l5 4V5L8 9Z" />
			<path d="M16.5 8.5a5 5 0 0 1 0 7" />
			<path d="M19 6a8.5 8.5 0 0 1 0 12" />
		</Icon>
	);
}

/** A crossed speaker: spoken replies are muted. */
export function SpeakerOffIcon() {
	return (
		<Icon>
			<path d="M4 9v6h4l5 4V5L8 9Z" />
			<path d="m17 9 5 6" />
			<path d="m22 9-5 6" />
		</Icon>
	);
}

/** A gauge: available subscription usage, opened on demand. */
export function UsageIcon() {
	return (
		<Icon>
			<path d="M4.6 18a9 9 0 1 1 14.8 0M12 12l4-4M6 12H4m8-6V4m6 8h2" />
			<circle cx="12" cy="12" r="1.25" />
		</Icon>
	);
}

/** The Gentle rose, simplified into clear petals and a stem at navigation size. */
export function RoseGlyph() {
	return (
		<svg
			className="rose-glyph"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d="M8.2 4.5C8.5 2.7 10.5 2 12 3.2c1.7-1 3.8-.1 4 1.7 2.1.3 3 2.2 2.2 4-.2 3.4-2.8 5.7-6 6-3.3-.1-6-2.5-6.4-5.6C4.2 7.5 5.4 5 8.2 4.5Z" />
			<path d="M8.2 4.5c.1 2.2 1.4 3.8 3.8 4.5m4-4.1c-2.5-.2-4.7 1.3-5.2 3.5M7 9c2.7-.3 5.3 1.8 5.2 5.9m6-6c-2.7-.4-5.3 1.8-6 4.1" />
			<path d="M12.2 14.9c.2 2.8-.8 5.2-2.1 7M11.9 18.1c1.5-2 3.6-2.3 5.4-1.4-1 2.1-3.3 2.7-5.4 1.4ZM11.8 18.7c-2.4-.1-3.9-1.3-4.2-3.2 2.3-.3 3.9 1 4.2 3.2Z" />
		</svg>
	);
}

export function MinusIcon() {
	return (
		<Icon>
			<path d="M5 12h14" />
		</Icon>
	);
}

/** An eye: show the floating rose again. */
export function EyeIcon() {
	return (
		<Icon>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
			<circle cx="12" cy="12" r="3" />
		</Icon>
	);
}

/** A crossed-out eye: hide the floating rose. */
export function EyeOffIcon() {
	return (
		<Icon>
			<path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1" />
			<path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
			<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
			<path d="m2 2 20 20" />
		</Icon>
	);
}

/** Corners pointing out: fill the screen. */
export function ExpandIcon() {
	return (
		<Icon>
			<path d="M15 3h6v6" />
			<path d="M9 21H3v-6" />
			<path d="M21 3l-7 7" />
			<path d="M3 21l7-7" />
		</Icon>
	);
}

/** Corners pointing in: back to the panel's size. */
export function CollapseIcon() {
	return (
		<Icon>
			<path d="M4 14h6v6" />
			<path d="M20 10h-6V4" />
			<path d="M14 10l7-7" />
			<path d="M3 21l7-7" />
		</Icon>
	);
}

/** A gear: the panel's settings (S33.1). */
export function SettingsIcon() {
	return (
		<Icon>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</Icon>
	);
}
