import { createLiveActivityBridge, type ActivityEnd, type ActivityItem, type ActivityOrigin, type ActivityPhase } from './live-activity.ts';

export type LiveTurn = { turnId: string; origin: ActivityOrigin; phase: ActivityPhase };
export type LiveEnd = { turnId: string; origin: ActivityOrigin; phase: ActivityEnd };
export type LiveCoordinatorState = {
  enabled: boolean;
  status: 'disabled' | 'checking' | 'ready' | 'active' | 'conflict' | 'unavailable' | 'uncertain';
  activity?: ActivityItem;
  message?: string;
};
type Bridge = Pick<ReturnType<typeof createLiveActivityBridge>, 'availability' | 'list' | 'start' | 'update'>;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const phases = new Set(['thinking', 'working', 'attention', 'waiting']);
const ends = new Set(['finished', 'interrupted', 'dismissed']);
const keyOf = (turn: { turnId: string; origin: ActivityOrigin }) => `${turn.origin}:${turn.turnId}`;
function valid(turn: LiveTurn | LiveEnd, ending: boolean): boolean {
  return !!turn && uuid.test(turn.turnId) && ['iphone', 'laptop'].includes(turn.origin)
    && (ending ? ends : phases).has(turn.phase);
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'No se confirmó el estado de la actividad.';

/** Coordinates confirmed app events, never work execution. Every native mutation
 * is serialized. A failed/uncertain mutation needs an explicit fresh inspection;
 * pending or late callbacks are not replayed after inspection. */
export function createLiveActivityCoordinator(options: { bridge?: Bridge; onChange?: (state: LiveCoordinatorState) => void } = {}) {
  const bridge = options.bridge ?? createLiveActivityBridge();
  let state: LiveCoordinatorState = { enabled: false, status: 'disabled' };
  let chain: Promise<void> = Promise.resolve();
  let latestObservation = 0;
  const closedTurns = new Set<string>();
  const snapshot = (): LiveCoordinatorState => ({ ...state, ...(state.activity ? { activity: { ...state.activity } } : {}) });
  const publish = (next: LiveCoordinatorState) => { state = next; try { options.onChange?.(snapshot()); } catch { /* UI observers cannot change operation ordering. */ } };
  const serial = (work: () => Promise<void>): Promise<void> => {
    const pending = chain.then(work);
    chain = pending.catch(() => {});
    return pending;
  };
  const markUncertain = (error: unknown) => publish({ ...state, status: 'uncertain', message: errorText(error) });
  const nextSequence = (item: ActivityItem) => {
    if (item.sequence >= 1_000_000_000) throw new Error('La actividad alcanzó su límite de revisiones; vuelve a consultarla.');
    return item.sequence + 1;
  };
  const isActive = (item: ActivityItem) => phases.has(item.phase);
  const refresh = () => serial(async () => {
    publish({ ...state, status: 'checking', message: undefined });
    try {
      const available = await bridge.availability();
      if (!available) { publish({ enabled: state.enabled, status: 'unavailable', message: 'Las Actividades en vivo no están disponibles.' }); return; }
      const items = await bridge.list();
      if (items.length > 1) { publish({ enabled: state.enabled, status: 'conflict', message: 'Hay varias actividades; revisa su estado antes de continuar.' }); return; }
      const activity = items[0];
      publish({ enabled: state.enabled, status: activity ? 'active' : state.enabled ? 'ready' : 'disabled', ...(activity ? { activity } : {}) });
    } catch (error) { publish({ enabled: state.enabled, status: 'unavailable', message: errorText(error) }); throw error; }
  });
  const finish = (turn: LiveEnd) => {
    if (!valid(turn, true)) return Promise.reject(new Error('El turno finalizado no es válido.'));
    const key = keyOf(turn); closedTurns.add(key); latestObservation++;
    return serial(async () => {
      if (state.status === 'uncertain' || state.status === 'checking') throw new Error('Consulta la actividad antes de actualizarla.');
      const current = state.activity;
      if (!current) return;
      if (keyOf(current) !== key) throw new Error('La actividad pertenece a otro turno.');
      if (!isActive(current)) throw new Error('La actividad ya terminó; consulta su estado.');
      try {
        await bridge.update({ id: current.id, turnId: current.turnId, origin: current.origin,
          phase: turn.phase, sequence: nextSequence(current) }, true);
        publish({ enabled: state.enabled, status: state.enabled ? 'ready' : 'disabled' });
      } catch (error) { markUncertain(error); throw error; }
    });
  };
  return {
    snapshot,
    refresh,
    setEnabled(enabled: boolean): Promise<void> {
      if (typeof enabled !== 'boolean') return Promise.reject(new Error('La preferencia de actividad no es válida.'));
      latestObservation++;
      publish({ ...state, enabled, ...(!enabled && !state.activity && state.status !== 'uncertain' ? { status: 'disabled' as const } : {}) });
      if (enabled) return refresh();
      return serial(async () => {
        const current = state.activity;
        // Uncertain means the last request may still finish; do not guess or retry.
        if (!current || state.status === 'uncertain' || !isActive(current)) return;
        // Turning off the surface does not stop a task on either device.
        const turn = { turnId: current.turnId, origin: current.origin, phase: 'dismissed' as const };
        closedTurns.add(keyOf(turn));
        try {
          await bridge.update({ ...turn, id: current.id, sequence: nextSequence(current) }, true);
          publish({ enabled: state.enabled, status: state.enabled ? 'ready' : 'disabled' });
        } catch (error) { markUncertain(error); throw error; }
      });
    },
    observe(turn: LiveTurn): Promise<void> {
      if (!valid(turn, false)) return Promise.reject(new Error('El turno observado no es válido.'));
      const observation = ++latestObservation, key = keyOf(turn);
      return serial(async () => {
        if (!state.enabled || observation !== latestObservation || closedTurns.has(key)) return;
        if (state.status === 'uncertain') throw new Error('Consulta la actividad antes de volver a actualizarla.');
        if (state.status !== 'ready' && state.status !== 'active' && !(state.status === 'conflict' && state.activity && keyOf(state.activity) === key))
          throw new Error('La actividad todavía no está disponible.');
        const current = state.activity;
        if (current && keyOf(current) !== key) {
          publish({ ...state, status: 'conflict', message: 'Hay una actividad de otro turno. Revísala antes de iniciar otra.' }); return;
        }
        if (current && !isActive(current)) throw new Error('La actividad ya terminó; consulta su estado.');
        try {
          if (!current) {
            const item = await bridge.start({ turnId: turn.turnId, origin: turn.origin, phase: turn.phase, sequence: 1 });
            // Preserve the system-returned phase/revision, not a guessed state.
            publish({ enabled: state.enabled, status: 'active', activity: item });
          } else {
            const sequence = nextSequence(current);
            await bridge.update({ turnId: turn.turnId, origin: turn.origin, phase: turn.phase, id: current.id, sequence });
            // The system may reject or defer a visual update even after a bridge
            // callback. Publish only the state observed from ActivityKit itself.
            const items = await bridge.list();
            const confirmed = items.length === 1 ? items[0] : undefined;
            if (!confirmed || confirmed.id !== current.id || keyOf(confirmed) !== key || confirmed.sequence !== sequence || confirmed.phase !== turn.phase)
              throw new Error('No se confirmó la revisión de la actividad. Consulta su estado.');
            publish({ enabled: state.enabled, status: 'active', activity: confirmed });
          }
        } catch (error) { markUncertain(error); throw error; }
      });
    },
    finish,
  };
}
