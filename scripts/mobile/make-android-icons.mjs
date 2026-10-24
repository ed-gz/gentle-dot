#!/usr/bin/env node
// Android variants of the official Gentle Dot artwork, without redrawing the logo.
// Sources: docs/brand/rose-source.png and docs/brand/rose-glyph.svg.
// Run: node scripts/mobile/make-android-icons.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resources = join(root, "apps/mobile/android/app/src/main/res");
const preview = join(root, ".cache/mobile-qa");
const rose = readFileSync(join(root, "docs/brand/rose-source.png")).toString("base64");
const glyph = [
	...readFileSync(join(root, "docs/brand/rose-glyph.svg"), "utf8").matchAll(/<path d="([^"]+)"\/>/g),
].map((match) => match[1]);
if (glyph.length !== 7) throw new Error("The official rose glyph changed; review its Android adaptation.");

// Same crop as ROSE_VIEWBOX in packages/ui/src/rose/strokes.ts. The whole flower
// fits inside the adaptive icon's central 66 dp safe area, including its stem.
const image = `<svg x="28" y="22" width="52" height="64" viewBox="200 60 860 1130"><image width="1254" height="1254" href="data:image/png;base64,${rose}" style="mix-blend-mode:screen"/></svg>`;
const svg = (body, viewBox = "0 0 108 108") =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
const foreground = svg(`<rect width="108" height="108" fill="#000"/>${image}`);
const splash = svg(`<rect width="108" height="108" fill="#101114"/>${image}`);
const legacy = svg(
	`<defs><clipPath id="shape"><rect x="18" y="18" width="72" height="72" rx="16"/></clipPath></defs><g clip-path="url(#shape)"><rect width="108" height="108" fill="#000"/>${image}</g>`,
	"18 18 72 72",
);
const circular = svg(
	`<defs><clipPath id="mask"><circle cx="54" cy="54" r="36"/></clipPath></defs><g clip-path="url(#mask)"><rect width="108" height="108" fill="#000"/>${image}</g>`,
	"18 18 72 72",
);
const glyphSvg = (color = "#ffffff") =>
	`<g transform="translate(16.2 13.89) scale(4.2)" fill="none" stroke="${color}" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">${glyph.map((d) => `<path d="${d}"/>`).join("")}</g>`;

function write(relative, content) {
	const file = join(resources, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}
function vector(size, viewport, transform) {
	return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from docs/brand/rose-glyph.svg by scripts/mobile/make-android-icons.mjs. -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">\n    <group ${transform}>\n${glyph.map((d) => `        <path android:fillColor="@android:color/transparent" android:strokeColor="#FFFFFF" android:strokeWidth="1.25" android:strokeLineCap="round" android:strokeLineJoin="round" android:pathData="${d}"/>`).join("\n")}\n    </group>\n</vector>\n`;
}
write(
	"drawable/rose_monochrome.xml",
	vector(
		108,
		108,
		'android:scaleX="4.2" android:scaleY="4.2" android:translateX="16.2" android:translateY="13.89"',
	),
);
write(
	"drawable/ic_notification.xml",
	vector(
		24,
		24,
		'android:scaleX="1.2" android:scaleY="1.2" android:translateX="1.2" android:translateY="0.54"',
	),
);
const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/icon_background"/>\n    <foreground android:drawable="@drawable/rose_foreground"/>\n    <monochrome android:drawable="@drawable/rose_monochrome"/>\n</adaptive-icon>\n`;
write("mipmap-anydpi-v26/ic_launcher.xml", adaptive);
write("mipmap-anydpi-v26/ic_launcher_round.xml", adaptive);
write("values/icon_background.xml", '<resources><color name="icon_background">#000000</color></resources>\n');

const executablePath =
	process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	async function render(markup, size, file) {
		mkdirSync(dirname(file), { recursive: true });
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(
			`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
		);
		await page.locator("svg").first().screenshot({ path: file, omitBackground: true });
	}
	await render(foreground, 432, join(resources, "drawable-nodpi/rose_foreground.png"));
	await render(splash, 432, join(resources, "drawable-nodpi/rose_splash.png"));
	for (const [density, size] of Object.entries({
		mdpi: 48,
		hdpi: 72,
		xhdpi: 96,
		xxhdpi: 144,
		xxxhdpi: 192,
	})) {
		await render(legacy, size, join(resources, `mipmap-${density}/ic_launcher.png`));
		await render(circular, size, join(resources, `mipmap-${density}/ic_launcher_round.png`));
	}
	const themed = svg(
		`<rect x="18" y="18" width="72" height="72" rx="20" fill="#f7d5e4"/>${glyphSvg("#452133")}`,
		"18 18 72 72",
	);
	const notification = svg(glyphSvg(), "18 18 72 72");
	await page.setViewportSize({ width: 760, height: 340 });
	await page.setContent(
		`<style>html,body{margin:0;background:#17141b;color:#f5eef3;font:14px system-ui}main{padding:28px}h1{font-size:19px;margin:0 0 8px}p{color:#c5b9c4;margin:0 0 26px}.row{display:flex;gap:36px}.cell{width:120px;text-align:center}.cell svg{display:block;width:96px;height:96px;margin:0 auto 12px}.small svg{width:48px;height:48px;margin-top:24px}.caption{line-height:1.4}</style><main><h1>Gentle Dot · Iconos Android 0.3</h1><p>Rosa oficial: launcher adaptable, versión clásica y símbolos del sistema.</p><div class="row">${[
			[circular, "Circular"],
			[legacy, "Clásico"],
			[themed, "Tema Android"],
			[notification, "Monocromo"],
		]
			.map(([mark, label]) => `<div class="cell">${mark}<div class="caption">${label}</div></div>`)
			.join(
				"",
			)}</div><div class="row small">${[circular, legacy, themed, notification].map((mark) => `<div class="cell">${mark}</div>`).join("")}</div></main>`,
	);
	mkdirSync(preview, { recursive: true });
	await page.screenshot({ path: join(preview, "rose-android-preview.png") });
	console.log(`Android rose resources generated; preview: ${join(preview, "rose-android-preview.png")}`);
} finally {
	await browser.close();
}
