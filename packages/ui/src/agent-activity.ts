import type { AgentState } from "@gentle-dot/protocol";
import type { CapriActionKind } from "@gentle-dot/theme-capri/behavior";
import type { ChatMessage } from "./store.ts";

export const ACTION_LABELS: Record<CapriActionKind, string> = {
 run: "Ejecutando comando…",
 read: "Leyendo archivos…",
 search: "Buscando archivos…",
 edit: "Editando archivos…",
 thinking: "Pensando…",
 memory: "Consultando memoria…",
 delegate: "Coordinando agentes…",
 other: "Trabajando…",
};

/** Only live activities from the current turn count; never infer action from tool text. */
export function currentAgentAction(state: AgentState, messages: ChatMessage[]): CapriActionKind | undefined {
 if (state !== "working" && state !== "thinking") return;
 const message = messages.at(-1);
 const running = message?.role === "assistant" ? message.activities.findLast(activity => activity.status === "running") : undefined;
 return running?.kind ?? (state === "thinking" || message?.streaming ? "thinking" : "other");
}
