import type { ChatEntry } from './conversation.ts';
import type { ToolDefinition } from './agent-tools.ts';
import { createCheckpointClient, fingerprintForCheckpoint, type CheckpointSummary } from './checkpoint-client.ts';
import { checkpointAnchorStore, type CheckpointAnchor, type CheckpointAnchorStore } from './checkpoint-anchor-store.ts';
import { hashSourceBytes } from './perception.ts';

type Client = ReturnType<typeof createCheckpointClient>;
type TurnStore = {
  /** Returns a durable turn from the same iPhone main conversation or its
   * archive; it must not search Herdr or another conversation by ID. */
  read(id: string): Promise<ChatEntry | undefined>;
  /** Must compare the exact expected turn and commit atomically; true means durable. */
  commitAnswer(expected: ChatEntry, text: string): Promise<boolean>;
};
export type CheckpointView = { kind: 'ready' | 'active' | 'interrupted' | 'starting_unconfirmed' | 'create_unconfirmed' | 'proposal' | 'uncertain' | 'budget' | 'cancelled' | 'answer'; record?: CheckpointSummary };
const fingerprintText = (text: string) => hashSourceBytes(new TextEncoder().encode(text));

/** Coordinates a native planning checkpoint with one durable chat turn. This
 * controller has no tool executor, approval callback or network dispatch. */
export function createCheckpointConversation(options: { turns: TurnStore; anchors?: CheckpointAnchorStore; client?: Client }) {
  const anchors = options.anchors ?? checkpointAnchorStore;
  const client = options.client ?? createCheckpointClient();
  async function original(anchor: CheckpointAnchor, allowComplete = false): Promise<ChatEntry> {
    const [request, turn] = await Promise.all([options.turns.read(anchor.userId), options.turns.read(anchor.id)]);
    if (!request || request.id !== anchor.userId || request.role !== 'user' || request.engine !== 'iphone' || request.state !== 'complete' || await fingerprintText(request.text) !== anchor.requestFingerprint) throw new Error('No coincide la solicitud original. El análisis se conserva sin ejecutar.');
    if (!turn || turn.id !== anchor.id || turn.engine !== 'iphone' || turn.role === 'user' || turn.localCancelled || (!allowComplete && turn.state === 'complete')) throw new Error('El turno original cambió o fue cancelado. El análisis se conserva sin modificarlo.');
    return turn;
  }
  async function bound(anchor: CheckpointAnchor): Promise<{ record?: CheckpointSummary; activeId?: string }> {
    const snapshot = await client.list();
    const found = snapshot.items.find(item => item.id === anchor.id);
    if (found && found.sourceFingerprint !== anchor.fingerprint) throw new Error('El contenido del análisis no coincide con su turno. Ambas copias se conservan.');
    return { record: found, activeId: snapshot.activeId };
  }
  async function mark(anchor: CheckpointAnchor, record: CheckpointSummary): Promise<CheckpointAnchor> {
    if (anchor.state === record.state && anchor.nativeRevision === record.revision) return anchor;
    return anchors.compareAndSwap(anchor, { state: record.state, nativeRevision: record.revision });
  }
  async function finishAnswer(anchor: CheckpointAnchor, record: CheckpointSummary): Promise<CheckpointView> {
    const text = record.decision?.kind === 'answer' ? record.decision.text : undefined;
    if (!text) throw new Error('La respuesta guardada no es válida. El original se conserva.');
    let turn = await original(anchor, true);
    if (turn.state === 'complete') {
      if (turn.role !== 'assistant' || turn.text !== text) throw new Error('La respuesta difiere del turno guardado. Ambas copias se conservan.');
    } else {
      if (!await options.turns.commitAnswer(turn, text)) throw new Error('La conversación no confirmó el guardado. La copia nativa se conserva.');
      turn = await original(anchor, true);
      if (turn.state !== 'complete' || turn.role !== 'assistant' || turn.text !== text) throw new Error('La conversación no confirmó la respuesta exacta. La copia nativa se conserva.');
    }
    const digest = await fingerprintText(text);
    anchor = await anchors.compareAndSwap(anchor, { state: 'answerCommitted', answerFingerprint: digest });
    // Removal is revision-bound and happens only after the exact answer is in
    // durable conversation and that fact has itself been anchored.
    await client.remove(record.id, record.revision);
    await anchors.remove(anchor);
    return { kind: 'answer', record };
  }
  async function recover(id: string): Promise<CheckpointView> {
    let anchor = await anchors.get(id);
    if (!anchor) throw new Error('No encontré el ancla del turno. No se ejecutó ninguna herramienta.');
    const turn = await original(anchor, true);
    const { record, activeId } = await bound(anchor);
    if (!record) {
      if (anchor.state === 'answerCommitted' && turn.state === 'complete' && turn.role === 'assistant' && await fingerprintText(turn.text) === anchor.answerFingerprint) {
        await anchors.remove(anchor); return { kind: 'answer' };
      }
      if (anchor.state === 'preparing') return { kind: 'create_unconfirmed' };
      throw new Error('El registro nativo no aparece. El turno y su ancla se conservan para revisión.');
    }
    // A native record created after a lost callback can be adopted only while
    // the anchor is still preparing and only if no inference has started.
    if (anchor.state === 'preparing') {
      if (record.state !== 'ready') throw new Error('El análisis avanzó sin una revisión anclada. Se conserva para revisión.');
      anchor = await anchors.compareAndSwap(anchor, { state: 'ready', nativeRevision: record.revision });
      return { kind: 'ready', record };
    }
    if (!anchor.nativeRevision) throw new Error('Falta la revisión nativa del turno.');
    if (anchor.state === 'answerCommitted') {
      if (record.state !== 'answer' || record.revision !== anchor.nativeRevision || turn.state !== 'complete' || turn.role !== 'assistant' || await fingerprintText(turn.text) !== anchor.answerFingerprint || record.decision?.text !== turn.text) throw new Error('La respuesta guardada cambió. Ambas copias se conservan.');
      await client.remove(record.id, record.revision); await anchors.remove(anchor); return { kind: 'answer', record };
    }
    if (anchor.state === 'resuming') {
      if (activeId === id) return { kind: 'active', record };
      if (['running', 'interrupted'].includes(record.state) && record.revision === anchor.nativeRevision) return { kind: 'interrupted', record };
      if (record.state === 'interrupted' && record.revision !== anchor.nativeRevision) {
        await anchors.compareAndSwap(anchor, { state: 'interrupted', nativeRevision: record.revision });
        return { kind: 'interrupted', record };
      }
      if (['ready', 'budgetExhausted'].includes(record.state) && record.revision !== anchor.nativeRevision) {
        anchor = await anchors.compareAndSwap(anchor, { state: record.state, nativeRevision: record.revision });
        return { kind: record.state === 'ready' ? 'ready' : 'budget', record };
      }
      throw new Error('No se confirmó la recuperación del análisis. Se conserva para revisión.');
    }
    // The controller anchors `running` before asking the native model to run.
    // Unexpected revision changes from any other state are never inferred safe.
    if (anchor.state !== 'running' && (anchor.nativeRevision !== record.revision || anchor.state !== record.state)) throw new Error('El análisis cambió fuera de este turno. Se conserva para revisión.');
    if (anchor.state === 'running' && record.state === 'ready') {
      if (record.revision !== anchor.nativeRevision) throw new Error('La revisión inicial del análisis cambió.');
      return { kind: activeId === id ? 'active' : 'starting_unconfirmed', record };
    }
    if (anchor.state === 'running' && record.revision === anchor.nativeRevision) throw new Error('El análisis no confirmó una nueva revisión.');
    if (anchor.state === 'running' && record.state === 'running') return { kind: activeId === id ? 'active' : 'interrupted', record };
    if (anchor.state === 'running') anchor = await mark(anchor, record);
    switch (record.state) {
      case 'ready': return { kind: 'ready', record };
      case 'running': return { kind: activeId === id ? 'active' : 'interrupted', record };
      case 'interrupted': return { kind: 'interrupted', record };
      case 'awaitingForeground': await original(anchor); return { kind: 'proposal', record };
      case 'executingForeground': case 'uncertainForeground': return { kind: 'uncertain', record };
      case 'budgetExhausted': return { kind: 'budget', record };
      case 'cancelled': return { kind: 'cancelled', record };
      case 'answer': return finishAnswer(anchor, record);
    }
  }
  async function runReady(anchor: CheckpointAnchor, allowBackground: boolean): Promise<CheckpointView> {
    if (anchor.state !== 'ready' || !anchor.nativeRevision) throw new Error('El análisis no está listo para continuar.');
    await original(anchor);
    const running = await anchors.compareAndSwap(anchor, { state: 'running' });
    await original(running);
    // The current revision is durably bound before the model can start. If the
    // callback is lost, restoration only reads and never calls run again.
    await client.run(running.id, running.nativeRevision!, allowBackground);
    return recover(running.id);
  }
  return {
    async start(input: { id: string; userId: string; instruction: string; context: string; tools: ToolDefinition[]; allowBackground?: boolean }): Promise<CheckpointView> {
      const [user, turn] = await Promise.all([options.turns.read(input.userId), options.turns.read(input.id)]);
      // Reading a durable window after reload projects pending as interrupted.
      // Both represent an unanswered original turn; local cancellation and a
      // completed answer remain hard fences.
      if (!user || user.id !== input.userId || user.role !== 'user' || user.engine !== 'iphone' || user.state !== 'complete' || user.text !== input.instruction || !turn || turn.id !== input.id || turn.engine !== 'iphone' || turn.role === 'user' || !['pending', 'interrupted'].includes(turn.state) || turn.localCancelled) throw new Error('Guarda primero la solicitud y su turno original.');
      const fingerprint = await fingerprintForCheckpoint(input.instruction, input.context, input.tools);
      const requestFingerprint = await fingerprintText(input.instruction);
      let anchor = await anchors.create({ id: input.id, userId: input.userId, fingerprint, requestFingerprint, state: 'preparing' });
      const created = await client.create(input.id, input.instruction, input.context, input.tools);
      if (created.id !== anchor.id || created.sourceFingerprint !== anchor.fingerprint || created.state !== 'ready') throw new Error('El registro nativo no coincide. Se conservan ambas copias.');
      anchor = await anchors.compareAndSwap(anchor, { state: 'ready', nativeRevision: created.revision });
      return runReady(anchor, input.allowBackground === true);
    },
    recover,
    /** Explicit user action only; recovered work never runs by itself. */
    async resume(id: string, confirmedByUser: boolean, allowBackground = false): Promise<CheckpointView> {
      if (!confirmedByUser) throw new Error('Continuar requiere una indicación tuya.');
      let anchor = await anchors.get(id);
      if (!anchor) throw new Error('No encontré el ancla del turno.');
      await original(anchor);
      const { record, activeId } = await bound(anchor);
      if (!record || activeId === id) throw new Error('El análisis sigue en curso o no pudo recuperarse.');
      if (anchor.state === 'running' && record.state === 'ready' && record.revision === anchor.nativeRevision) {
        anchor = await anchors.compareAndSwap(anchor, { state: 'ready' });
      } else if (['running', 'interrupted', 'resuming'].includes(anchor.state) && ['running', 'interrupted'].includes(record.state)) {
        if (anchor.state === 'interrupted' && (record.state !== 'interrupted' || record.revision !== anchor.nativeRevision)) throw new Error('La revisión interrumpida cambió. El análisis se conserva.');
        if (anchor.state === 'running' && record.revision === anchor.nativeRevision) throw new Error('El análisis no confirmó una nueva revisión.');
        if (anchor.state === 'resuming' && record.revision !== anchor.nativeRevision) throw new Error('La recuperación cambió. El análisis se conserva.');
        if (anchor.state !== 'resuming') anchor = await anchors.compareAndSwap(anchor, { state: 'resuming', nativeRevision: record.revision });
        const ready = await client.resume(id, record.revision, true);
        if (ready.id !== id || ready.sourceFingerprint !== anchor.fingerprint) throw new Error('El análisis recuperado no coincide.');
        anchor = await anchors.compareAndSwap(anchor, { state: ready.state, nativeRevision: ready.revision });
        if (ready.state === 'budgetExhausted') return { kind: 'budget', record: ready };
      } else if (anchor.state === 'resuming' && ['ready', 'budgetExhausted'].includes(record.state) && record.revision !== anchor.nativeRevision) {
        anchor = await anchors.compareAndSwap(anchor, { state: record.state, nativeRevision: record.revision });
        if (record.state === 'budgetExhausted') return { kind: 'budget', record };
      } else if (anchor.state !== 'ready' || record.state !== 'ready' || anchor.nativeRevision !== record.revision) {
        throw new Error('Revisa el análisis guardado antes de continuar.');
      }
      return runReady(anchor, allowBackground);
    },
  };
}
