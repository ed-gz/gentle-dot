import type { ReactNode } from "react";
import claudeLogo from "../assets/brands/claude.svg";
import codexLogo from "../assets/brands/codex.svg";

/** Original provider assets; adjacent names supply their accessible labels. */
export function UsageGlyph({
	kind,
}: {
	kind: "codex" | "claude" | "clock" | "calendar" | "refresh" | "layers" | "info";
}) {
	if (kind === "codex" || kind === "claude") {
		return (
			<img
				src={kind === "codex" ? codexLogo : claudeLogo}
				width="28"
				height="28"
				alt=""
				aria-hidden="true"
				className="usage-brand-logo"
			/>
		);
	}
	const paths: Record<typeof kind, ReactNode> = {
		clock: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v5l3 2" />
			</>
		),
		calendar: (
			<>
				<rect x="3" y="5" width="18" height="16" rx="4" />
				<path d="M7 3v4m10-4v4M3 11h18m-13 5h3" />
			</>
		),
		refresh: (
			<>
				<path d="M20 4v5h-5M4 20v-5h5" />
				<path d="M5.1 9a7.5 7.5 0 0 1 12.5-3.2L20 9M4 15l2.4 3.2A7.5 7.5 0 0 0 18.9 15" />
			</>
		),
		layers: (
			<>
				<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />
			</>
		),
		info: (
			<>
				<circle cx="12" cy="12" r="9" />
				<path d="M12 11v6m0-10v.1" />
			</>
		),
	};
	return (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{paths[kind]}
		</svg>
	);
}
