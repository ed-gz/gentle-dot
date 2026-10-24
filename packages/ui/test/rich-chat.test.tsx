import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SharedMarkdown } from "../src/components/SharedMarkdown.tsx";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

it.each([
	'%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n A --> B',
	'flowchart TD\n A --> B\n click A "https://example.org"',
	"flowchart TD\n A[img: https://example.org/private.png]",
])("keeps diagram directives and external resources inert", async (source) => {
	vi.stubGlobal("IntersectionObserver", undefined);
	const { container } = render(<SharedMarkdown>{`\`\`\`mermaid\n${source}\n\`\`\``}</SharedMarkdown>);
	await screen.findByText("Vista previa no disponible");
	expect(mermaid.render).not.toHaveBeenCalled();
	expect(container.querySelector("svg, iframe, script, img")).toBeNull();
	expect(container.querySelector("pre code")?.textContent).toBe(source);
	expect(container.querySelector("details")?.open).toBe(true);
});
it("preserves readable tables and task lists without interpreting HTML", () => {
	const { container } = render(
		<SharedMarkdown>
			{
				"| Fase | Estado |\n|---|---|\n| Revisión | Lista |\n\n- [x] Revisado\n- [ ] Entregar\n\n<script>alert(1)</script>"
			}
		</SharedMarkdown>,
	);
	expect(screen.getByRole("region", { name: "Tabla" })).toHaveAttribute("tabindex", "0");
	expect(screen.getAllByRole("columnheader")).toHaveLength(2);
	expect(screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)).toHaveLength(1);
	expect(container.querySelector("script")).toBeNull();
});
it("shows useful alternate text when an ordinary image cannot load", () => {
	render(<SharedMarkdown>{"![Mapa del proyecto](https://example.org/mapa.png)"}</SharedMarkdown>);
	const image = screen.getByRole("img", { name: "Mapa del proyecto" });
	expect(image).toHaveAttribute("loading", "lazy");
	expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
	fireEvent.error(image);
	expect(screen.getByText("Mapa del proyecto · Imagen no disponible")).toBeVisible();
});
