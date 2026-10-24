import { useLayoutEffect, useState } from "react";

/** A stable portal host survives navigation and moves with the browser's modal top layer. */
export function useCompanionLayer(enabled: boolean) {
	const [host] = useState(() => {
		const element = document.createElement("div");
		element.className = "companion-layer";
		element.dataset.companionLayer = "";
		return element;
	});
	useLayoutEffect(() => {
		if (!enabled) return;
		const opened = new Map<HTMLDialogElement, number>();
		let order = 0;
		const popoverOpen = () => typeof host.showPopover === "function" && host.matches(":popover-open");
		const isModal = (dialog: HTMLDialogElement) => {
			try {
				return dialog.matches(":modal");
			} catch {
				return dialog.open;
			}
		};
		const sync = () => {
			const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(isModal);
			for (const dialog of opened.keys()) if (!dialogs.includes(dialog)) opened.delete(dialog);
			for (const dialog of dialogs) if (!opened.has(dialog)) opened.set(dialog, ++order);
			const modal = dialogs.sort((a, b) => (opened.get(b) ?? 0) - (opened.get(a) ?? 0))[0];
			const parent = modal ?? document.body;
			// A body-level popover stays inert while showModal() is active. Keeping this same host
			// inside the modal preserves React state and lets the sprite receive touch above it.
			if (host.parentElement !== parent) {
				if (popoverOpen()) host.hidePopover();
				parent.append(host);
			}
			if (modal && typeof host.showPopover === "function") {
				host.setAttribute("popover", "manual");
				if (!popoverOpen()) host.showPopover();
			} else if (host.hasAttribute("popover")) {
				if (popoverOpen()) host.hidePopover();
				host.removeAttribute("popover");
			}
		};
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "attributes" && record.target instanceof HTMLDialogElement) {
					if (record.target.open) opened.set(record.target, ++order);
					else opened.delete(record.target);
				}
			}
			sync();
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["open"],
		});
		sync();
		return () => {
			observer.disconnect();
			if (popoverOpen()) host.hidePopover();
			host.removeAttribute("popover");
			host.remove();
		};
	}, [enabled, host]);
	return host;
}
