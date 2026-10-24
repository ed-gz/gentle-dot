import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { currentAgentAction } from "../src/agent-activity.ts";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage } from "../src/store.ts";

const messages: ChatMessage[] = [{ id: "turn", role: "assistant", text: "", streaming: true, activities: [
 { id: "read", kind: "read", title: "private path", status: "done" },
 { id: "run", kind: "run", title: "private command", status: "running" },
] }];
it("uses only live activities of a busy turn, then falls back to thinking", () => {
 expect(currentAgentAction("working", messages)).toBe("run");
 expect(currentAgentAction("idle", messages)).toBeUndefined();
 expect(currentAgentAction("needs_you", messages)).toBeUndefined();
 expect(currentAgentAction("thinking", [])).toBe("thinking");
 expect(currentAgentAction("working", [{ ...messages[0]!, activities: [], streaming: false }])).toBe("other");
});
it.each([
 ["run", "Ejecutando comando…"], ["read", "Leyendo archivos…"],
 ["search", "Buscando archivos…"], ["edit", "Editando archivos…"],
 ["memory", "Consultando memoria…"], ["delegate", "Coordinando agentes…"],
] as const)("labels %s without exposing raw tool text", (kind, label) => {
 render(<MessageList messages={[{ ...messages[0]!, activities: [{ id: "tool", kind, status: "running", title: "private command" }] }]} working mobile />);
 expect(screen.getByRole("status")).toHaveTextContent(label);
 expect(screen.queryByText("private command")).not.toBeInTheDocument();
});
it("shows the current action label rather than raw command text and clears when idle", () => {
 const { rerender } = render(<MessageList messages={messages} working mobile />);
 expect(screen.getByRole("status")).toHaveTextContent("Ejecutando comando…");
 expect(screen.queryByText("private command")).not.toBeInTheDocument();
 rerender(<MessageList messages={messages} working={false} mobile />);
 expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
