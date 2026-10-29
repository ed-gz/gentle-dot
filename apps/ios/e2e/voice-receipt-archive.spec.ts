import { expect, test, openRecoveryHarness } from './fixtures.ts';

test('saved receipts stay out of Archivo until recovery state and retention are integrated', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/conversation.ts')).loadConversation()).revision ?? 0)).toBeGreaterThanOrEqual(1);
  await page.evaluate(async () => {
    const { loadConversation } = await import('/src/conversation.ts');
    const { createVoiceChatCommit } = await import('/src/voice-chat-commit.ts');
    const saved = await loadConversation();
    await createVoiceChatCommit().apply({ ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', destination: 'chat',
      audioSHA256: 'a'.repeat(64), audioBytes: 3, transcript: { sessionId: '12345678-1234-4234-8234-123456789012',
        text: 'Texto de prueba.', locale: 'es-MX', source: 'apple-speech-analyzer', durationSeconds: 2,
        segments: [{ text: 'Texto de prueba.', startSeconds: .1, endSeconds: 1.8 }] } },
    { draft: saved.draft, revision: saved.revision ?? 0 });
  });
  await openRecoveryHarness(page);
  await expect(page.locator('.voice-receipt-recovery')).toHaveCount(0);
  await expect(page.getByText('Dictado guardado', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => (await (await import('/src/voice-chat-commit.ts')).createVoiceChatCommit().list()).length)).toBe(1);
});
