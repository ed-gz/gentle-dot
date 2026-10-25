import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const sourceDirectory = "../src/";
const files = [
 ...readdirSync(fileURLToPath(new URL(sourceDirectory, import.meta.url))).filter(name => name.endsWith(".css")).map(name => `../src/${name}`),
 "../../theme-capri/src/style.css", "../../../apps/mobile/src/mobile.css",
];
function rules(file: string) {
 const css = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
 return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }));
}

it.each(files)("uses thin neutral borders and keyboard-only focus, not accent rings: %s", file => {
 for (const { selector, body } of rules(file)) {
  if (/focus-visible/.test(selector)) {
   expect(body, selector).not.toMatch(/outline:\s*[2-9]\d*px/);
  }
  if (/\.(?:message-body|agent-message-user|composer(?=[\s:.),]|$)|ask-card|agent-permission-card|agent-command-shelf|agent-plan(?=[\s:.),]|$)|session-delivery(?=[\s:.),]|$)|companion-scene-preview|appearance-preview-user)/.test(selector)) {
   // Buttons retain brand colors; this assertion concerns their containing surfaces.
   if (/composer-(send|mic)/.test(selector)) continue;
   expect(body, selector).not.toMatch(/border(?:-left)?:\s*[2-9]\d*px\s+solid/);
   expect(body, selector).not.toMatch(/border(?:-color)?:[^;]*(?:var\(--accent|#[0-9a-f]{6})/i);
   expect(body, selector).not.toMatch(/box-shadow:[^;]*var\(--accent/);
  }
  if (/(?:input|select|textarea|composer).*:focus(?!-visible)/.test(selector)) {
   expect(body, selector).not.toMatch(/box-shadow:[^;]*var\(--accent/);
  }
 }
});
