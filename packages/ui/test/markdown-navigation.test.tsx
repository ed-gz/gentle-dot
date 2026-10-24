import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SharedMarkdown } from "../src/components/SharedMarkdown.tsx";

afterEach(() => vi.restoreAllMocks());

it("opens web links externally and cancels navigation away from the conversation", () => {
	const open = vi.fn();
	render(
		<SharedMarkdown openUrl={open}>
			{"[Documentación](https://example.com/guide?q=test#intro)"}
		</SharedMarkdown>,
	);
	const link = screen.getByRole("link", { name: "Documentación" });
	expect(fireEvent.click(link)).toBe(false);
	expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/guide?q=test#intro");
	expect(link).toHaveAttribute("target", "_blank");
	expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

it("uses the browser bridge by default, keeping the current document mounted", () => {
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	render(<SharedMarkdown>{"[Sitio](https://example.com)"}</SharedMarkdown>);
	fireEvent.click(screen.getByRole("link"));
	expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com", "_blank", "noopener,noreferrer");
	expect(screen.getByRole("link")).toBeInTheDocument();
});

it("keeps anchors in the document and does not pass unsafe schemes to the opener", () => {
	const open = vi.fn();
	render(
		<SharedMarkdown openUrl={open}>
			{"[Sección](#section) [No ejecutar](javascript:alert%281%29)"}
		</SharedMarkdown>,
	);
	const anchor = screen.getByRole("link", { name: "Sección" });
	expect(anchor).toHaveAttribute("href", "#section");
	expect(anchor).not.toHaveAttribute("target");
	const unsafe = screen.getByText("No ejecutar");
	expect(unsafe).not.toHaveAttribute("href", expect.stringMatching(/^javascript:/));
	fireEvent.click(unsafe);
	expect(open).not.toHaveBeenCalled();
});
