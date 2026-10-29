import { expect, test } from './fixtures.ts';

test('listing more than four voice receipts works with the bounded native hash fallback', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const chatPath = '/src/voice-chat-commit.ts', receiptPath = '/src/voice-receipt-store.ts';
    const { createVoiceChatCommit } = await import(chatPath), { createVoiceReceiptStore } = await import(receiptPath);
    const chat = createVoiceChatCommit({ databaseName: `voice-hash-chat-${crypto.randomUUID()}` });
    const receipts = createVoiceReceiptStore({ databaseName: `voice-hash-receipts-${crypto.randomUUID()}` });
    let base = { draft: '', revision: 0 };
    for (let i = 0; i < 6; i++) {
      const input = { ownerId: crypto.randomUUID(), destination: 'chat', audioSHA256: 'a'.repeat(64), audioBytes: 3,
        transcript: { sessionId: crypto.randomUUID(), text: `Voz ${i}`, locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
          segments: [{ text: `Voz ${i}`, startSeconds: 0.1, endSeconds: 1.8 }] } };
      const applied = await chat.apply(input, base);
      base = { draft: applied.currentDraft, revision: applied.currentRevision };
      await receipts.put(input);
    }
    const subtle = crypto.subtle, digests = new Map<string, number[]>();
    let maxActive = 0;
    const state = globalThis as any; state.isTauri = true;
    state.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      const request = args.request;
      if (command.endsWith('crypto_hash_begin')) {
        if (digests.size >= 4) return { ok: false, message: 'demasiados archivos' };
        const id = crypto.randomUUID(); digests.set(id, []); maxActive = Math.max(maxActive, digests.size); return { ok: true, id };
      }
      if (command.endsWith('crypto_hash_update')) {
        const bytes = digests.get(request.id); if (!bytes) return { ok: false };
        bytes.push(...Uint8Array.from(atob(request.data), char => char.charCodeAt(0))); return { ok: true };
      }
      if (command.endsWith('crypto_hash_finish')) {
        const bytes = digests.get(request.id); if (!bytes) return { ok: false };
        await new Promise(resolve => setTimeout(resolve, 15));
        const hex = [...new Uint8Array(await subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        digests.delete(request.id); return { ok: true, hex };
      }
      if (command.endsWith('crypto_hash_cancel')) { digests.delete(request.id); return { ok: true }; }
      return { ok: true };
    } };
    Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
    const chatRecords = await chat.list(), receiptRecords = await receipts.list('chat');
    return { maxActive, chat: chatRecords.map((item: any) => item.input.transcript.text), receipts: receiptRecords.length };
  });
  expect(result.chat).toEqual(['Voz 0', 'Voz 1', 'Voz 2', 'Voz 3', 'Voz 4', 'Voz 5']);
  expect(result.receipts).toBe(6);
  expect(result.maxActive).toBe(1);
});
