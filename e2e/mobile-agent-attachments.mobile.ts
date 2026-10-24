import { expect, test } from "@playwright/test";

// APK-shell browser fixture: real file chooser + HTTP upload client, simulated authenticated backend.
// Actual managed Pi byte/image delivery is covered separately by agent-attachments.integration.test.ts.
test("mobile session attaches a real file and submits typed refs through the visible session form", async ({ page }, info) => {
 const origin = "https://agent-attachments-fixture.test.ts.net";
 const token = "fixture_agent_attachments_0123456789";
 await page.addInitScript(({ origin, token }) => {
  window.__mobileShellFixture = { connection: { url: origin, token, deviceId: "fixture-phone", name: "Mi equipo" }, monitoring: false, calls: [] };
 }, { origin, token });
 const prompts: unknown[] = [];
 const uploads: { name: string; bytes: string; pane: string; session: string }[] = [];
 await page.route(`${origin}/**`, async route => {
  const request = route.request(); const path = new URL(request.url()).pathname;
  if (path === "/upload") {
   expect(request.headers().authorization).toBe(`Bearer ${token}`);
   uploads.push({ name: decodeURIComponent(request.headers()["x-file-name"]!), bytes: request.postDataBuffer()!.toString(), pane: request.headers()["x-agent-pane"]!, session: request.headers()["x-agent-session"]! });
   return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ uploadId: "u_browserfixture", name: "voice.wav", mime: "application/octet-stream", size: 12, path: "uploads/u_browserfixture/voice.wav" }) });
  }
  const action = request.method() === "POST" ? request.postDataJSON() : undefined;
  if (action?.action === "prompt") prompts.push(action);
  const body = path === "/orchestration" ? action?.action === "inspect" ? {
   sessionId: "session-one", status: "idle", question: null, messages: [], history: { supported: true, hasEarlier: false },
  } : { available: true, sessions: [{ paneId: "pi:one", sessionId: "session-one", label: "Destino de archivos", state: "idle", provider: "terminal", terminalId: "one", workspaceId: "one", connected: true, managed: true,
   capabilities: { inspect: true, prompt: true, abort: true, approvals: true, attachments: { version: 1, files: true, images: true, audio: "file" } } }], approvals: [], policies: [], events: [] }
   : { approvals: [], workflows: [], pending: 0, enabled: false };
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
 });
 await page.routeWebSocket(`${origin.replace("https:", "wss:")}/ws`, socket => {
  let seq = 0;
  socket.onMessage(raw => {
   const command = JSON.parse(String(raw));
   if (command.type === "hello") socket.send(JSON.stringify({ type: "ready", seq: ++seq, agentState: "idle", model: "Fixture" }));
   if (command.type === "get_history") socket.send(JSON.stringify({ type: "history", seq: ++seq, messages: [] }));
  });
 });
 await page.goto("/");
 await page.getByRole("button", { name: "Sesiones", exact: true }).click();
 await page.getByRole("button", { name: "Destino de archivos · Disponible" }).click();
 const chooser = page.waitForEvent("filechooser");
 await page.locator(".agent-reply .composer-attach").click();
 await (await chooser).setFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFFWAVEdata") });
 await expect(page.getByRole("list", { name: "Files to send" })).toContainText("voice.wav");
 await expect(page.getByText(/no se graba ni transcribe/)).toHaveCount(0);
 for (const viewport of [{ width: 375, height: 820 }, { width: 780, height: 390 }]) {
  await page.setViewportSize(viewport);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".agent-reply .composer-attach")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enviar instrucción" })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`agent-attachments-${viewport.width}.png`) });
 }
 await page.setViewportSize({ width: 375, height: 820 });
 await page.getByRole("button", { name: "Enviar instrucción" }).click();
 await expect.poll(() => prompts.length).toBe(1);
 expect(uploads).toEqual([{ name: "voice.wav", bytes: "RIFFWAVEdata", pane: "pi:one", session: "session-one" }]);
 expect(prompts).toEqual([{ action: "prompt", paneId: "pi:one", sessionId: "session-one", text: "", attachments: [{ uploadId: "u_browserfixture", name: "voice.wav" }] }]);
 await expect(page.getByRole("list", { name: "Files to send" })).toHaveCount(0);
});
