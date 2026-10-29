import { expect, test } from './fixtures.ts';
import { nativeFixture } from './native-voice-fixture.ts';

// The user reported: "cuando genero una transcripcion ... abajo se esta mostrando
// todo el texto y NO sobre el propio campo de escritura, viendose raro, porque
// cuando termina, ahi se sube al campo de texto quedando mal".
// The preview must therefore live in #prompt, where the final transcript lands.
async function dictation(page: import('@playwright/test').Page, partial: string) {
  await nativeFixture(page);
  await page.addInitScript((initial: string) => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    let recording = false;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    state.voicePartial = initial;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', ...(recording ? { recording: true, sessionId: id, partial: state.voicePartial } : {}) };
      if (command.endsWith('start_voice')) { recording = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { recording = false; return { ok: true, sessionId: args.sessionId, text: 'Texto final.', locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'Texto final.', startSeconds: 0.1, endSeconds: 1.8 }] }; }
      return previous(command, args);
    });
  }, partial);
}

test('the live dictation appears inside the composer, not below it', async ({ page }) => {
  await dictation(page, 'Primera hipótesis');
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador original');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nPrimera hipótesis');
  // The status line keeps a short state and never repeats the preview.
  await expect(page.locator('#voice-status')).not.toContainText('Primera hipótesis');
  await page.evaluate(() => (globalThis as any).voicePartial = 'Hipótesis corregida');
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nHipótesis corregida');
  await page.locator('#dictate').click();
  // One final result in place: no duplicated preview, nothing appended twice.
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nTexto final.');
  await expect(page.locator('#voice-status')).not.toContainText('Hipótesis corregida');
  expect(await page.evaluate(() => (globalThis as any).nativePrompts)).toEqual([]);
});

test('typing while dictating wins: Capri never overwrites the edited draft', async ({ page }) => {
  await dictation(page, 'Primera hipótesis');
  await page.goto('/');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Primera hipótesis');
  await page.locator('#prompt').fill('Primera hipótesis y lo que escribí');
  await page.evaluate(() => (globalThis as any).voicePartial = 'Segunda hipótesis');
  await expect(page.locator('#prompt')).toHaveValue('Primera hipótesis y lo que escribí');
  await expect(page.locator('#voice-status')).toContainText('no lo piso');
  await expect(page.locator('#voice-status')).toContainText('Segunda hipótesis');
  await page.locator('#dictate').click();
  // The final transcript is appended to what the person kept, without losing it.
  await expect(page.locator('#prompt')).toHaveValue('Primera hipótesis y lo que escribí\nTexto final.');
});

test('a transcript that would not fit leaves the draft untouched and says so', async ({ page }) => {
  await nativeFixture(page);
  await page.addInitScript(() => {
    const state = globalThis as any, previous = state.__TAURI_INTERNALS__.invoke;
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    let recording = false;
    state.__TAURI_INTERNALS__.invoke = state.wrapRetainedVoice(async (command: string, args: any) => {
      if (command.endsWith('check_voice')) return { available: true, status: 'available', assetsInstalled: true,
        microphonePermission: 'granted', ...(recording ? { recording: true, sessionId: id, partial: 'Parcial corto' } : {}) };
      if (command.endsWith('start_voice')) { recording = true; return { ok: true, sessionId: id, maxDurationSeconds: 90 }; }
      if (command.endsWith('stop_voice')) { recording = false; return { ok: true, sessionId: args.sessionId, text: 'y'.repeat(2400), locale: 'es-MX', durationSeconds: 2,
        source: 'apple-speech-analyzer', segments: [{ text: 'y'.repeat(2400), startSeconds: 0.1, endSeconds: 1.8 }] }; }
      return previous(command, args);
    });
  });
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador original');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nParcial corto');
  await page.locator('#dictate').click();
  // Too long to insert: nothing is truncated and nothing is left half-applied.
  await expect(page.locator('#prompt')).toHaveValue('Borrador original');
  await expect(page.locator('#voice-status')).toContainText('El dictado está guardado');
});

test('cancelling a dictation removes the preview and keeps the original draft', async ({ page }) => {
  await dictation(page, 'Parcial que se descarta');
  await page.goto('/');
  await page.locator('#prompt').fill('Borrador original');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nParcial que se descarta');
  await page.locator('#dictate').click();
  await expect(page.locator('#prompt')).toHaveValue('Borrador original\nTexto final.');
});

test('the composer announces that the text it shows is a dictation in progress', async ({ page }) => {
  await dictation(page, 'Primera hipótesis');
  await page.goto('/');
  await expect(page.locator('#prompt')).toHaveAttribute('aria-describedby', 'voice-status');
  await expect(page.locator('#voice-status')).toHaveAttribute('role', 'status');
});
