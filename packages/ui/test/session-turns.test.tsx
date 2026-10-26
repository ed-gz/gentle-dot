import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SessionTurns } from "../src/components/OrchestrationPanel.tsx";
import type { AgentConversation } from "../src/orchestration.ts";

it("hides empty work disclosures without hiding the assistant text", () => {
 const {container} = render(<SessionTurns messages={[
  {id:"u-empty",role:"user",content:[{type:"text",text:"ya"}]},
  {id:"a-empty",role:"assistant",stopReason:"toolUse",content:[{type:"text",text:"Preparando"}]},
 ]}/>);
 expect(container.querySelector(".session-turn-work")).toBeNull();
 expect(screen.getByText("Preparando")).toBeVisible();
});

it("separates realistic prompts, collapsed execution and final replies without losing live work", () => {
 const messages = [
 {id:"u1",role:"user",content:[{type:"text",text:"Comprueba el build"}]},
 {id:"a1",role:"assistant",content:[{type:"text",text:"Voy a comprobarlo"}]},
 {id:"t1",role:"tool",content:[{type:"text",text:"npm test: OK"}]},
 {id:"t2",role:"tool",content:[{type:"text",text:"npm build: OK"}]},
 {id:"a2",role:"assistant",timestamp:"2026-10-25T12:30:00Z",content:[{type:"text",text:"Todo listo"}]},
 {id:"u2",role:"user",content:[{type:"text",text:"Ahora revisa"}]},
 ] as AgentConversation["messages"];
 const {container} = render(<SessionTurns messages={messages}/>);
 expect(screen.getAllByRole("region", {name:/Turno/})).toHaveLength(2);
 expect(screen.getByText("Trabajó: 2 acciones").closest("details")).not.toHaveAttribute("open");
 expect(screen.getByText("npm test: OK")).not.toBeVisible();
 expect(screen.getByText("Todo listo").closest("article")).toHaveClass("session-turn-reply");
 expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-10-25T12:30:00Z");
});
