import type { ServerMessage } from '../../../packages/protocol/src/index.ts';
import type { createLiveActivityCoordinator } from './live-activity-coordinator.ts';
import type { ActivityPhase } from './live-activity.ts';

type Coordinator = Pick<ReturnType<typeof createLiveActivityCoordinator>, 'snapshot' | 'observe' | 'finish'>;
type StateEvent = Extract<ServerMessage, { type: 'ready' | 'agent_state' }>;

/** Observe only the daemon's reported aggregate state, never a submitted prompt.
 * The generated identifier identifies this observation, not a server request or
 * Herdr session. A disconnected socket says nothing about whether work ended. */
export function createLaptopLiveActivity(options: {
  coordinator: Coordinator;
  identifier?: () => string;
  onError?: (error: unknown) => void;
}) {
  const { coordinator } = options;
  const identifier = options.identifier ?? (() => crypto.randomUUID());
  let enabled = false, generation = 0, observationId: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Observers do not affect ordering. */ } };
  function enqueue(operation: () => Promise<void>) {
    const next = pending.then(operation);
    pending = next.catch(report);
    return next;
  }
  function owned() {
    const current = coordinator.snapshot().activity;
    return current?.origin === 'laptop' && current.turnId === observationId ? current : undefined;
  }
  return {
    /** This separate opt-in must not be inferred from the local-turn setting. */
    setEnabled(value: boolean): Promise<void> {
      enabled = value; generation++;
      if (value) return Promise.resolve(); // Wait for a fresh, authenticated daemon event.
      return enqueue(async () => {
        const current = owned(); observationId = undefined;
        if (current) await coordinator.finish({ origin: 'laptop', turnId: current.turnId, phase: 'dismissed' });
      });
    },
    disconnected(): void {
      // Do not refresh or end the last state. ActivityKit marks it stale.
      generation++;
    },
    message(message: StateEvent): Promise<void> {
      if (!enabled || (message.type !== 'ready' && message.type !== 'agent_state')) return Promise.resolve();
      const state = message.type === 'ready' ? message.agentState : message.state;
      const phase: ActivityPhase | undefined = state === 'thinking' ? 'thinking'
        : state === 'working' ? 'working' : state === 'needs_you' ? 'attention' : undefined;
      const eventGeneration = generation;
      return enqueue(async () => {
        if (!enabled || generation !== eventGeneration) return;
        const snapshot = coordinator.snapshot(), current = owned();
        if (!phase) {
          // idle, startup, restart and error are not proof of completion.
          if (current) await coordinator.finish({ origin: 'laptop', turnId: current.turnId, phase: 'dismissed' });
          observationId = undefined;
          return;
        }
        // A local turn or an unowned activity always wins; never replace it.
        if (!snapshot.enabled || !['ready', 'active'].includes(snapshot.status) || (snapshot.activity && !current)) return;
        if (!current) observationId = identifier();
        await coordinator.observe({ origin: 'laptop', turnId: observationId!, phase });
      });
    },
  };
}
