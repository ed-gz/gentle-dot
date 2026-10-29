import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceControls } from './useVoice.ts';

export type AgentTextDraft = { revision: number; text: string };
export type AgentTextDraftStore = {
  read(): Promise<AgentTextDraft>;
  readCurrent?(): Promise<AgentTextDraft>;
  save(expected: AgentTextDraft, text: string): Promise<AgentTextDraft>;
  deliver(receipt: unknown, expected: AgentTextDraft): Promise<{ draft: AgentTextDraft; alreadyDelivered: boolean }>;
  /** Let a new view wait for this owner's already queued local writes. */
  trackPending?(work: Promise<unknown>): void;
};

/** An optional platform store. No desktop caller supplies one. */
export function useAgentTextDraft(store: AgentTextDraftStore | undefined, text: string, onText: (value: string) => void) {
  const [ready, setReady] = useState(!store), [error, setError] = useState('');
  const currentText = useRef(text); currentText.current = text;
  const callback = useRef(onText); callback.current = onText;
  const state = useRef({ live: true, snapshot: undefined as AgentTextDraft | undefined, chain: Promise.resolve(), error: '', text });
  useEffect(() => {
    const s = state.current; s.live = true;
    if (!store) { setReady(true); return () => { s.live = false; }; }
    setReady(false); setError(''); s.error = '';
    s.chain = store.read().then(saved => {
      s.snapshot = saved;
      if (!s.live) return;
      const existing = currentText.current;
      if (existing && saved.text && existing !== saved.text) { s.error = 'Hay dos borradores distintos. Conserva el texto antes de reintentar.'; setError(s.error); }
      else if (!existing && saved.text) callback.current(saved.text);
      s.text = existing || saved.text; setReady(true);
    }).catch(() => { s.error = 'No pude abrir el borrador de esta sesión.'; if (s.live) { setError(s.error); setReady(true); } });
    return () => { s.live = false; };
  }, [store]);
  const save = useCallback((value: string) => {
    const s = state.current; s.text = value; callback.current(value);
    if (!store) return;
    s.chain = s.chain.then(async () => {
      if (s.error || !s.snapshot) return;
      if (s.snapshot.text !== value) s.snapshot = await store.save(s.snapshot, value);
    }).catch(() => { s.error = 'No se confirmó el borrador de esta sesión.'; if (s.live) setError(s.error); });
    store.trackPending?.(s.chain);
  }, [store]);
  const commit = useCallback((draft: NonNullable<VoiceControls['draft']>, value: string) => {
    const s = state.current;
    const task = (async () => {
      if (!store || !draft.receipt) throw new Error('El dictado no tiene recibo verificable.');
      await s.chain;
      if (s.error || !s.snapshot || s.text !== value) throw new Error('El borrador cambió.');
      if (s.snapshot.text !== value) s.snapshot = await store.save(s.snapshot, value);
      const result = await store.deliver(draft.receipt, s.snapshot);
      s.snapshot = result.draft; s.text = result.draft.text;
      return result.draft.text;
    })();
    store?.trackPending?.(task);
    return task;
  }, [store]);
  const retry = useCallback(() => {
    const s = state.current; if (!store) return; setError(''); s.error = '';
    s.chain = s.chain.then(async () => {
      const persisted = await (store.readCurrent?.() ?? store.read());
      if (!s.snapshot) {
        if (persisted.text && s.text && persisted.text !== s.text) throw new Error('Hay dos borradores distintos.');
        s.snapshot = persisted;
        if (persisted.text && !s.text) { s.text = persisted.text; if (s.live) callback.current(persisted.text); }
      } else if (persisted.revision !== s.snapshot.revision || persisted.text !== s.snapshot.text) throw new Error('El borrador cambió.');
      if (persisted.text !== s.text) s.snapshot = await store.save(persisted, s.text);
    }).catch(() => { s.error = 'No se confirmó el borrador de esta sesión.'; if (s.live) setError(s.error); });
    store.trackPending?.(s.chain);
  }, [store]);
  return { ready, error, save, commit, retry };
}
