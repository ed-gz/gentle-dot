import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentWorkflow } from "../src/components/AgentWorkflow.tsx";
import type { AgentWork } from "../src/orchestration.ts";

const work: AgentWork = {
	version: 1,
	truncated: false,
	plan: {
		source: "history",
		completed: 1,
		total: 2,
		tasks: [
			{ id: "one", title: "Revisar", status: "done" },
			{ id: "two", title: "Validar", status: "in_progress", note: "Falta la prueba final" },
		],
	},
	agents: [
		{ id: "review", agent: "Revisor", label: "Revisar los cambios", status: "running", source: "live" },
		{ id: "old", agent: "Anterior", status: "running", source: "history" },
	],
	commands: [
		{
			id: "command",
			tool: "bash",
			label: "pnpm test",
			status: "completed",
			source: "history",
			messageId: "tool-result",
		},
	],
};

describe("structured agent workflow", () => {
	it("shows the active command immediately and retains its result in the expandable activity", async () => {
		const view = render(<AgentWorkflow work={{ ...work, agents: [], commands: [{ ...work.commands[0]!, source: "live", status: "running" }] }} />);
		expect(screen.getByText("1 en ejecución")).toBeVisible();
		expect(view.container.querySelector(".agent-command-current")).toHaveTextContent("pnpm test");
		expect(view.container.querySelector(".agent-command-current")).toBeVisible();
		await userEvent.click(screen.getByText("Comandos y herramientas"));
		expect(screen.getByText("Ejecutando")).toBeVisible();
		view.rerender(<AgentWorkflow work={{ ...work, agents: [] }} />);
		expect(screen.getByText("Completado")).toBeVisible();
		expect(view.container.querySelector(".agent-command-current")).toBeNull();
	});
	it("starts compact and includes only confirmed active delegates", async () => {
		const onInspect = vi.fn();
		const { container } = render(
			<AgentWorkflow
				work={{
					...work,
					agents: [
						...work.agents,
						{ id: "waiting", agent: "Diseño", status: "waiting", source: "live" },
						{ id: "queued", agent: "Pruebas", status: "queued", source: "live" },
						{ id: "finished", agent: "Finalizado", status: "completed", source: "live" },
						{ id: "failed", agent: "Fallido", status: "failed", source: "live" },
						{ id: "cancelled", agent: "Cancelado", status: "cancelled", source: "live" },
						{ id: "timeout", agent: "Vencido", status: "timed_out", source: "live" },
					],
				}}
				onInspect={onInspect}
			/>,
		);
		expect(container.querySelector(".agent-workflow:not(.agent-command-workflow)")).not.toHaveAttribute("open");
		expect(screen.getByText("3 activos")).toBeVisible();
		expect(screen.getByRole("region", { name: "Plan de trabajo" })).toBeVisible();
		expect(screen.getByRole("progressbar", { name: "1 de 2 tareas terminadas" })).toBeVisible();
		expect(screen.getByText("Revisar los cambios")).not.toBeVisible();
		await userEvent.click(screen.getByText("Subagentes"));
		await waitFor(() => expect(onInspect).toHaveBeenCalledOnce());
		const list = screen.getByRole("list", { name: "Subagentes activos" });
		expect(within(list).getAllByRole("listitem")).toHaveLength(3);
		for (const state of ["Trabajando", "En espera", "En cola"])
			expect(within(list).getByRole("img", { name: state })).toBeVisible();
		for (const label of [
			"Anterior",
			"Finalizado",
			"Fallido",
			"Cancelado",
			"Vencido",
			"Ver resultado",
			"Registros",
		])
			expect(screen.queryByText(label, { exact: true })).not.toBeInTheDocument();
	});

	it("removes completed delegates immediately while preserving the open plan and focus", async () => {
		const view = render(<AgentWorkflow work={work} />);
		const plan = screen.getByLabelText("Ver tareas · 1 de 2");
		await userEvent.click(plan);
		await userEvent.click(screen.getByText("Subagentes"));
		view.rerender(
			<AgentWorkflow
				work={{ ...work, agents: work.agents.map((agent) => ({ ...agent, status: "completed" })) }}
			/>,
		);
		expect(screen.queryByText("Subagentes")).not.toBeInTheDocument();
		expect(screen.getByText("Falta la prueba final")).toBeVisible();
		expect(plan.closest("details")).toHaveAttribute("open");
		expect(plan).toHaveFocus();
	});

	it("hides obsolete delegates on disconnect and never invents activity or a plan", () => {
		const view = render(<AgentWorkflow work={work} stale />);
		expect(screen.queryByText("Subagentes")).not.toBeInTheDocument();
		expect(screen.getAllByText("Sin actualizar")).toHaveLength(2);
		view.rerender(<AgentWorkflow work={{ ...work, plan: undefined, agents: [], commands: [] }} />);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		expect(screen.queryByText("Ver resultado")).not.toBeInTheDocument();
		expect(view.container).toHaveTextContent("");
	});

	it("keeps live disclosure open across refreshes and renders delegate labels as text", async () => {
		const view = render(<AgentWorkflow work={work} />);
		await userEvent.click(screen.getByText("Subagentes"));
		const summary = view.container.querySelector(".agent-workflow:not(.agent-command-workflow) > summary") as HTMLElement;
		summary.focus();
		view.rerender(
			<AgentWorkflow
				work={{
					...work,
					agents: [
						{ id: "review", agent: "<script>doSomething()</script>", status: "waiting", source: "live" },
					],
				}}
			/>,
		);
		expect(view.container.querySelector(".agent-workflow:not(.agent-command-workflow)")).toHaveAttribute("open");
		expect(summary).toHaveFocus();
		expect(screen.getByText("<script>doSomething()</script>")).toBeVisible();
		expect(view.container.querySelector("script")).toBeNull();
	});
});
