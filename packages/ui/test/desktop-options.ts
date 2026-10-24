import { fireEvent, screen } from "@testing-library/react";

/** Open secondary desktop actions as a user does; leave an already-open menu alone. */
export function openDesktopOptions() {
	const trigger = screen.getByRole("button", { name: "Options" });
	if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
}
