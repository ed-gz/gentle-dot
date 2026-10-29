import { readWork, validMinuteApproval, assertNoMinuteActionLock, type MinuteApproval, type WorkItem } from './work-inbox.ts';
import { canonicalJSON } from './remote-mcp.ts';
import { localIdentifier } from './local-identifiers.ts';

export type Proposal = { id: string; workId: string; revision: number; approval: MinuteApproval; connectionId: string; tool: string; description: string; argumentsJSON: string; createdAt: number; state?: 'reviewing' | 'executing' | 'responded' | 'uncertain' };
export type ProposalView = Omit<Proposal, 'approval'> & { current: boolean; executed: false | null; responseReceived: boolean; actionApproved: boolean };
const DB = 'capri-ios-work-inbox';
const LIMIT = 10;
const TIMEOUT = 8000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function input(value: unknown): { workId: string; revision: number; connectionId: string; tool: string; description: string; argumentsJSON: string } {
  if (!object(value) || Object.keys(value).some(k => !['workId', 'revision', 'connectionId', 'tool', 'description', 'arguments'].includes(k)) ||
      typeof value.workId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.workId) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      typeof value.connectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.connectionId) ||
      typeof value.description !== 'string' || !value.description.trim() || value.description.length > 200 || /[\u0000-\u001f\u007f]/.test(value.description) ||
      typeof value.tool !== 'string' || !/^(?:mcp_[a-f0-9]{24}|api_[a-f0-9]{32}_[a-z_]{1,40})$/.test(value.tool) || !object(value.arguments)) throw new Error('Propuesta de acción inválida.');
  const rejectCredentials = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) rejectCredentials(child); return; }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:authorization|password|passphrase|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i.test(key)) throw new Error('Las credenciales se configuran en la conexión, no en propuestas.');
      rejectCredentials(child);
    }
  };
  // Normalize/bound depth first to reject cyclic or oversized nesting before inspecting keys.
  const argumentsJSON = canonicalJSON(value.arguments);
  rejectCredentials(JSON.parse(argumentsJSON));
  if (new TextEncoder().encode(argumentsJSON).length > 16000) throw new Error('Los argumentos de la propuesta son demasiado grandes.');
  return { workId: value.workId, revision: Number(value.revision), connectionId: value.connectionId, tool: value.tool, description: value.description.trim(), argumentsJSON };
}
export function validateMinuteProposal(value: unknown) { return input(value); }
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Las propuestas locales no están disponibles.')); return; }
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('Las propuestas locales no respondieron.')); }, TIMEOUT);
    const request = indexedDB.open(DB);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onblocked = request.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(request.error ?? new Error('No se pudieron abrir las propuestas.')); } };
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; clearTimeout(timer); resolve(request.result); };
  });
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined, value: T, hasValue = false, settled = false;
    const fail = (error: unknown) => { if (settled) return; settled = true; clearTimeout(timer); try { transaction?.abort(); } catch {} db.close(); reject(error); };
    const timer = setTimeout(() => fail(new Error('Las propuestas locales no respondieron.')), TIMEOUT);
    try {
      transaction = db.transaction('items', mode);
      transaction.onabort = transaction.onerror = () => fail(transaction?.error ?? new Error('No se pudo guardar la propuesta.'));
      transaction.oncomplete = () => { if (settled) return; if (!hasValue) { fail(new Error('La propuesta no devolvió resultado.')); return; } settled = true; clearTimeout(timer); db.close(); resolve(value); };
      action(transaction.objectStore('items'), result => { value = result; hasValue = true; }, fail);
    } catch (error) { fail(error); }
  });
}
function matching(work: Awaited<ReturnType<typeof readWork>>, proposal: Proposal): boolean {
  return work.id === proposal.workId && work.revision === proposal.revision && validMinuteApproval(work) && canonicalJSON(work.minuteApproval) === canonicalJSON(proposal.approval);
}
function view(work: WorkItem, proposal: Proposal): ProposalView {
  const { approval: _approval, ...safe } = proposal;
  const executed = proposal.state === 'responded' || proposal.state === 'executing' || proposal.state === 'uncertain' ? null : false;
  return { ...safe, current: matching(work, proposal), executed, responseReceived: proposal.state === 'responded', actionApproved: proposal.state === 'executing' || proposal.state === 'responded' || proposal.state === 'uncertain' };
}
function proposalsOf(work: WorkItem): Proposal[] {
  const values = (work as WorkItem & { minuteProposals?: unknown }).minuteProposals;
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > LIMIT || values.some(value => !object(value) || typeof value.id !== 'string' || value.workId !== work.id)) throw new Error('No se pudieron verificar las propuestas guardadas.');
  return values as Proposal[];
}
/** The source check and insertion share the same transaction as work edits. No service is called. */
export async function createMinuteProposal(value: unknown): Promise<ProposalView> {
  const safe = input(value);
  return transact<ProposalView>('readwrite', (store, done, fail) => {
    const get = store.get(safe.workId); get.onerror = () => fail(get.error); get.onsuccess = () => {
      try {
        const work = get.result as WorkItem | undefined;
        if (!work || work.revision !== safe.revision || !validMinuteApproval(work) || !work.minuteApproval) throw new Error('Primero revisa y aprueba la versión actual de la minuta.');
        assertNoMinuteActionLock(work);
        const previous = proposalsOf(work);
        if (previous.length >= LIMIT) throw new Error('Esta minuta ya tiene 10 propuestas. Elimina una antes de continuar.');
        const proposal: Proposal = { id: localIdentifier(), workId: work.id, revision: work.revision, approval: structuredClone(work.minuteApproval), connectionId: safe.connectionId, tool: safe.tool, description: safe.description, argumentsJSON: safe.argumentsJSON, createdAt: Date.now() };
        const put = store.put({ ...work, minuteProposals: [...previous, proposal] }); put.onerror = () => fail(put.error); put.onsuccess = () => done(view(work, proposal));
      } catch (error) { fail(error); }
    };
  });
}
export async function listMinuteProposals(workId: string): Promise<ProposalView[]> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workId)) throw new Error('Trabajo inválido.');
  const work = await readWork(workId);
  return proposalsOf(work).map(proposal => view(work, proposal));
}
/** Explicit local deletion only; neither the minute nor any external service is changed. */
export async function deleteMinuteProposal(id: string, workId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(workId)) throw new Error('Propuesta inválida.');
  await transact<void>('readwrite', (store, done, fail) => {
    const get = store.get(workId); get.onerror = () => fail(get.error); get.onsuccess = () => {
      try {
        const work = get.result as WorkItem | undefined;
        if (!work) throw new Error('El trabajo ya no está disponible.');
        assertNoMinuteActionLock(work);
        const previous = proposalsOf(work), target = previous.find(value => value.id === id);
        if (target?.state === 'uncertain' || target?.state === 'executing' || target?.state === 'reviewing') throw new Error('La acción está sin confirmar y debe conservarse para revisión.');
        const kept = previous.filter(value => value.id !== id);
        if (kept.length === previous.length) throw new Error('La propuesta ya no está disponible.');
        const put = store.put({ ...work, minuteProposals: kept }); put.onerror = () => fail(put.error); put.onsuccess = () => done();
      } catch (error) { fail(error); }
    };
  });
}

/** Persistent lease fences edits, deletion and all other proposals during review and dispatch. */
export async function acquireMinuteAction(workId: string, proposalId: string): Promise<{ leaseId: string; proposal: ProposalView }> {
  return transact('readwrite', (store, done, fail) => {
    const get = store.get(workId); get.onerror = () => fail(get.error); get.onsuccess = () => {
      try {
        const work = get.result as WorkItem | undefined;
        if (!work) throw new Error('El trabajo ya no está disponible.');
        assertNoMinuteActionLock(work);
        const proposals = proposalsOf(work), index = proposals.findIndex(value => value.id === proposalId);
        if (index < 0 || !matching(work, proposals[index]!) || proposals[index]!.state !== undefined) throw new Error('La propuesta ya no puede revisarse; comprueba la minuta y el estado anterior.');
        const leaseId = localIdentifier(); const nextProposal = { ...proposals[index]!, state: 'reviewing' as const };
        const next = { ...work, minuteProposals: proposals.map((value, i) => i === index ? nextProposal : value), minuteActionLock: { proposalId, leaseId } };
        const put = store.put(next); put.onerror = () => fail(put.error); put.onsuccess = () => done({ leaseId, proposal: view(next, nextProposal) });
      } catch (error) { fail(error); }
    };
  });
}
/** A successful transition is the fence immediately before permitting the reviewed call. */
export async function markMinuteActionExecuting(workId: string, proposalId: string, leaseId: string): Promise<void> {
  await updateLease(workId, proposalId, leaseId, 'reviewing', 'executing', false);
}
/** Explicitly cancel a review; its later approval cannot transition the removed lease. */
export async function cancelMinuteActionReview(workId: string, proposalId: string, leaseId: string): Promise<void> {
  await updateLease(workId, proposalId, leaseId, 'reviewing', undefined, true);
}
/** Call only after the associated operation has fully settled; no automatic replay. */
export async function finishMinuteAction(workId: string, proposalId: string, leaseId: string, outcome: 'denied' | 'responded' | 'uncertain'): Promise<void> {
  if (outcome === 'denied') await updateLease(workId, proposalId, leaseId, 'reviewing', undefined, true);
  else await updateLease(workId, proposalId, leaseId, 'executing', outcome, true);
}
async function updateLease(workId: string, proposalId: string, leaseId: string, expected: 'reviewing' | 'executing', state: Proposal['state'], unlock: boolean): Promise<void> {
  await transact<void>('readwrite', (store, done, fail) => {
    const get = store.get(workId); get.onerror = () => fail(get.error); get.onsuccess = () => {
      try {
        const work = get.result as WorkItem | undefined;
        if (!work || work.minuteActionLock?.proposalId !== proposalId || work.minuteActionLock.leaseId !== leaseId) throw new Error('La revisión de la acción cambió.');
        const proposals = proposalsOf(work), index = proposals.findIndex(value => value.id === proposalId), proposal = proposals[index];
        if (!proposal || proposal.state !== expected || !matching(work, proposal)) throw new Error('La minuta o propuesta cambió durante la revisión.');
        const nextProposal = { ...proposal, state };
        const next = { ...work, minuteProposals: proposals.map((value, i) => i === index ? nextProposal : value) };
        if (unlock) delete next.minuteActionLock;
        const put = store.put(next); put.onerror = () => fail(put.error); put.onsuccess = () => done();
      } catch (error) { fail(error); }
    };
  });
}
