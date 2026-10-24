import { expect, test } from "@playwright/test";

for (const [width, mobile] of [[320, true], [375, true], [375, false], [1280, false]] as const) {
	test(`clip reserves its hit area with multiline draft and chips at ${width}px mobile=${mobile}`, async ({ page }, info) => {
		await page.setViewportSize({ width, height: 812 });
		await page.emulateMedia({ reducedMotion: "reduce" });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(mobile ? "/?mobile" : "/");
		const box = page.getByRole("textbox", { name: mobile ? "Mensaje" : "Message", exact: true });
		const clip = page.locator(".composer-attach");
		await expect(box).toBeEnabled();
		// Use the visible clip, not only the hidden input, to exercise the native picker hit area.
		const chooser = page.waitForEvent("filechooser");
		await clip.click();
		await (await chooser).setFiles([
			{ name: "a-long-attachment-name-for-the-preview.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
			{ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("fixture") },
		]);
		await expect(page.getByRole("list", { name: "Files to send" })).toContainText("photo.png");
		await box.click();
		await box.pressSequentially("This draft must remain visible beside the clip.");
		await box.press("Shift+Enter");
		await box.pressSequentially("second-line-with-a-long-unbroken-word-for-narrow-layout");
		const draft = "This draft must remain visible beside the clip.\nsecond-line-with-a-long-unbroken-word-for-narrow-layout";
		await expect(box).toHaveValue(draft);
		await expect(box).toBeFocused();
		await expect(page.getByLabel("Sent events")).toHaveText("[]");

		const geometry = await page.evaluate(() => {
			const form = document.querySelector(".composer")!;
			const clip = form.querySelector(".composer-attach")!;
			const box = form.querySelector("textarea")!;
			const send = form.querySelector(".composer-send")!;
			const rect = (element: Element) => element.getBoundingClientRect().toJSON();
			const a = clip.getBoundingClientRect();
			const b = box.getBoundingClientRect();
			const c = send.getBoundingClientRect();
			const intersects = (left: DOMRect, right: DOMRect) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
			return {
				clip: rect(clip), textarea: rect(box), send: rect(send), form: rect(form),
				clipOverlapsText: intersects(a, b), sendOverlapsText: intersects(c, b),
				textHit: document.elementFromPoint(b.left + 4, b.bottom - 10)?.tagName,
				clipHit: clip.contains(document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2)),
				lineHeight: Number.parseFloat(getComputedStyle(box).lineHeight),
				pageWidth: document.documentElement.scrollWidth,
			};
		});
		console.log(`COMPOSER_GEOMETRY ${width} mobile=${mobile} ${JSON.stringify(geometry)}`);
		await page.screenshot({ path: info.outputPath("multiline-chips.png") });
		expect.soft(geometry.clipOverlapsText).toBe(false);
		expect.soft(geometry.sendOverlapsText).toBe(false);
		expect.soft(geometry.clipHit).toBe(true);
		if (mobile) {
			// The visible native-picker hit area belongs inside the composer's border.
			expect.soft(geometry.clip.left).toBeGreaterThanOrEqual(geometry.form.left);
			expect.soft(geometry.clip.right).toBeLessThanOrEqual(geometry.form.right);
			expect.soft(geometry.clip.top).toBeGreaterThanOrEqual(geometry.form.top);
			expect.soft(geometry.clip.bottom).toBeLessThanOrEqual(geometry.form.bottom);
		}
		expect.soft(geometry.textHit).toBe("TEXTAREA");
		expect.soft(geometry.textarea.height).toBeGreaterThan(geometry.lineHeight * 2);
		expect.soft(geometry.send.right).toBeLessThanOrEqual(width);
		expect.soft(geometry.pageWidth).toBeLessThanOrEqual(width);

		await page.getByRole("button", { name: "Remove photo.png", exact: true }).click();
		await expect(page.getByRole("list", { name: "Files to send" })).not.toContainText("photo.png");
		await expect(box).toHaveValue(draft);
		await page.getByRole("button", { name: mobile ? "Enviar mensaje" : "Send", exact: true }).click();
		await expect(box).toHaveValue("");
		await expect(page.getByRole("list", { name: "Files to send" })).toHaveCount(0);
		await expect(page.getByLabel("Sent events")).toContainText('"name":"a-long-attachment-name-for-the-preview.txt"');
		await page.getByRole("button", { name: mobile ? "Detener respuesta" : "Stop", exact: true }).click();
		await expect(page.getByLabel("Sent events")).toContainText('"type":"abort"');
		await box.fill("plain follow-up");
		await box.press("Enter");
		await expect(box).toHaveValue("");
		await expect(page.getByLabel("Sent events")).toContainText('"text":"plain follow-up"');
		expect(errors).toEqual([]);
	});
}
