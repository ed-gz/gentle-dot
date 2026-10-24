import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { SettingsIcon } from "./icons.tsx";

/** Secondary desktop controls stay one click away without stealing the chat's width. */
export function DesktopOptions({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const id = useId();
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			trigger.current?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", onEscape, true);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", onEscape, true);
		};
	}, [open]);
	return (
		<div className="desktop-options" ref={root}>
			<button
				type="button"
				className="icon"
				aria-label="Options"
				title="Options"
				aria-expanded={open}
				aria-controls={id}
				ref={trigger}
				onClick={() => setOpen(!open)}
			>
				<SettingsIcon />
			</button>
			{open ? (
				// biome-ignore lint/a11y/useKeyWithClickEvents: child buttons synthesize clicks for Enter and Space.
				<fieldset
					id={id}
					className="desktop-options-panel"
					aria-label="Chat options"
					onClick={(event) => {
						if ((event.target as Element).closest("button")) {
							setOpen(false);
							trigger.current?.focus();
						}
					}}
				>
					{children}
				</fieldset>
			) : null}
		</div>
	);
}
