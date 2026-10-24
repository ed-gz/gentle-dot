import { expect, test } from "@playwright/test";
import type {} from "./mobile-shell-native.ts";

test("agent shared icon row and native dictation remain scoped and manual", async ({ page }) => {
 const origin = "https://agent-composer-fixture.test.ts.net";
 await page.addInitScript(origin => {
  window.__mobileShellFixture = { connection: { url: origin, token: "fixture_agent_composer_0123456789", deviceId: "fixture-phone", name: "Mi equipo" }, monitoring: false, calls: [] };
 }, origin);
 const prompts: unknown[] = []; const dotActions: unknown[] = [];
 await page.route(`${origin}/**`, async route => {
  const request = route.request(); const path = new URL(request.url()).pathname;
  const action = request.method() === "POST" ? request.postDataJSON() : undefined;
  if (action?.action === "prompt") prompts.push(action);
  const body = path === "/orchestration" ? action?.action === "inspect" ? {
   sessionId: action.sessionId, status: "idle", question: null, messages: [], history: { supported: true, hasEarlier: false },
  } : { available: true, sessions: ["one", "two"].map(id => ({ paneId: `pi:${id}`, sessionId: id, label: `Destino ${id}`, state: "idle", provider: "terminal", connected: true, managed: true, capabilities: { inspect: true, prompt: true, abort: true } })), approvals: [], policies: [], events: [] }
   : { approvals: [], workflows: [], pending: 0, enabled: false };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
 });
 await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, socket => {
  let seq = 0;
  socket.onMessage(raw => {
   const command = JSON.parse(String(raw));
   if (["send", "abort", "voice_speak"].includes(command.type)) dotActions.push(command);
   if (command.type === "hello") socket.send(JSON.stringify({ type: "ready", seq: ++seq, agentState: "idle", model: "Fixture" }));
   if (command.type === "get_history") socket.send(JSON.stringify({ type: "history", seq: ++seq, messages: [] }));
  });
 });
 await page.goto("/");
 await page.getByRole("button", { name: "Sesiones", exact: true }).click();
 await page.getByRole("button", { name: "Destino one · Disponible" }).click();
 const row = page.locator(".agent-reply .composer");
 for (const viewport of [{ width: 320, height: 720 }, { width: 375, height: 820 }, { width: 780, height: 390 }]) {
  await page.setViewportSize(viewport);
  await expect(row).toBeVisible();
  await expect(row.locator("button")).toHaveText(["", ""]);
  expect(await row.locator("textarea, button").evaluateAll(elements => {
   const boxes = elements.map(element => element.getBoundingClientRect());
   return Math.max(...boxes.map(box => box.bottom)) - Math.min(...boxes.map(box => box.bottom)) < 3;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 }
 await expect(page.getByText("Continuar esta sesión", { exact: true })).toHaveCount(0);
 await expect(row.locator('input[type="file"]')).toHaveCount(0);
 expect(await page.evaluate(() => window.__mobileShellFixture.calls.filter(call => call.method === "transcribe"))).toEqual([]);
 await row.getByRole("button", { name: "Dictar mensaje" }).click();
 await expect(row.locator("textarea")).toHaveValue("Revisa el avance de mis tareas");
 expect(prompts).toEqual([]);
 await row.locator("textarea").fill("Texto revisado");
 await row.getByRole("button", { name: "Enviar instrucción" }).click();
 await expect.poll(() => prompts.length).toBe(1);
 expect(prompts).toEqual([{ action: "prompt", paneId: "pi:one", sessionId: "one", text: "Texto revisado" }]);
 await page.evaluate(() => { window.__mobileShellFixture.deferSpeech = true; });
 await row.getByRole("button", { name: "Dictar mensaje" }).click();
 await page.getByRole("button", { name: "Todos los agentes" }).click();
 await page.getByRole("button", { name: "Destino two · Disponible" }).click();
 await page.evaluate(() => window.__resolveMobileSpeech?.({ text: "stale result" }));
 await expect(row.locator("textarea")).toHaveValue("");
 expect(prompts).toHaveLength(1); expect(dotActions).toEqual([]);
});
