import type { Tool, ToolContext } from './agent-tools.ts';
import * as inbox from './work-inbox.ts';
import { createWorkDispatcher, prepareWorkTransfer } from './work-sync.ts';
import { acquireMinuteAction, createMinuteProposal, finishMinuteAction, listMinuteProposals, markMinuteActionExecuting, validateMinuteProposal } from './minute-proposals.ts';
import { createConnectionTools } from './connection-tools.ts';
export type WorkToolDependencies = {
  getHost: () => string | undefined;
  getDispatcher: (operation?: 'process') => ReturnType<typeof createWorkDispatcher> | undefined;
  inbox?: typeof inbox;
  prepareTransfer?: typeof prepareWorkTransfer;
  connectionCall?: Tool;
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function input(value: unknown): Record<string, unknown> { if (!record(value)) throw new Error('Argumentos de trabajo inválidos.'); return value; }
function idOf(value: unknown): string { const id = input(value).id; if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Identificador de trabajo inválido.'); return id; }
function revisionOf(value: unknown): number { const revision = input(value).revision; if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('Indica la revisión exacta del trabajo.'); return Number(revision); }
const summary = (item: inbox.WorkItem) => ({ id: item.id, title: item.title, kind: item.kind, status: item.status, revision: item.revision, files: item.files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size })), versions: item.versions.length, hasResult: Boolean(item.result), minuteApprovedLocally: inbox.validMinuteApproval(item) });
/** Local work and durable transfers participate in the same conversational tool registry. */
export function createWorkTools(dependencies: WorkToolDependencies): Tool[] {
  const store = dependencies.inbox ?? inbox;
  const prepare = dependencies.prepareTransfer ?? prepareWorkTransfer;
  const connectionCall = dependencies.connectionCall ?? createConnectionTools().find(tool => tool.definition.name === 'connection_call')!;
  const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
  const id = { id: { type: 'string' } }; const versioned = { ...id, revision: { type: 'integer', minimum: 1 } };
  const getLinked = (operation?: 'process') => {
    const host = dependencies.getHost(); const dispatcher = dependencies.getDispatcher(operation);
    if (!host || !dispatcher) throw new Error('Conecta el host para transferir o procesar. El trabajo local se conserva.');
    return { host, dispatcher };
  };
  async function approve(context: ToolContext, host: string, title: string, details: unknown): Promise<void> {
    context.signal.throwIfAborted();
    if (!context.askApproval || !await context.askApproval({ title, details: JSON.stringify({ host, ...input(details) }, null, 2), operation: 'work-transfer' })) throw new Error('La operación del trabajo no fue aprobada.');
    context.signal.throwIfAborted(); if (dependencies.getHost() !== host) throw new Error('El host cambió después de revisar la operación.');
  }
  return [
    { definition: { name: 'work_list', description: 'Lista los trabajos offline, reuniones importadas, revisiones y estado de transferencia. No envía nada.', parameters: schema({}) }, validate: input, execute: async (_args, context) => { context.signal.throwIfAborted(); return (await store.listWork()).map(summary); } },
    { definition: { name: 'work_read', description: 'Lee una instrucción y la última versión local. Si el texto se acota, se indica truncado. Las minutas recuperadas conservan evidencia y revisión humana pendiente.', parameters: schema(id, ['id']) }, validate(args) { return { id: idOf(args) }; }, execute: async (args, context) => {
      context.signal.throwIfAborted(); const work = await store.readWork(idOf(args)); const latest = work.versions.at(-1);
      return { ...summary(work), instruction: work.instruction, ...(latest ? { latestVersion: { id: latest.id, text: latest.text.slice(0, 12000), truncated: latest.text.length > 12000 } } : {}), ...(work.result ? { result: work.result } : {}), ...(work.transfer?.receipt ? { receipt: work.transfer.receipt } : {}) };
    } },
    { definition: { name: 'work_save', description: 'Conserva una instrucción nueva en el iPhone offline, sin enviarla al host ni ejecutar acciones.', parameters: schema({ title: { type: 'string', maxLength: 120 }, kind: { type: 'string', enum: ['task','meeting'] }, instruction: { type: 'string', maxLength: 8000 } }, ['title','kind','instruction']) }, validate(args) { return store.validateWorkInput(input(args) as inbox.WorkInput); }, execute: async (args, context) => { context.signal.throwIfAborted(); return summary(await store.createWork(store.validateWorkInput(input(args) as inbox.WorkInput))); } },
    { definition: { name: 'work_version', description: 'Guarda una corrección de voz o texto como nueva versión offline. Invalida la aprobación anterior; no envía nada.', parameters: schema({ ...versioned, text: { type: 'string', maxLength: 200000 } }, ['id','revision','text']) }, validate(args) { const value = input(args); if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 200000) throw new Error('Versión inválida.'); return { id: idOf(args), revision: revisionOf(args), text: value.text }; }, execute: async (args, context) => { context.signal.throwIfAborted(); const value = input(args); if (typeof value.text !== 'string') throw new Error('Versión inválida.'); return summary(await store.addWorkVersion(idOf(args), revisionOf(args), value.text)); } },
    { definition: { name: 'work_sync', description: 'Propone transferir una revisión exacta con todos sus archivos y versiones al host. Solicita revisión humana en la conversación. Sólo un recibo durable confirma almacenamiento; nunca implica que la tarea se ejecutó.', parameters: schema(versioned, ['id','revision']) }, validate(args) { return { id: idOf(args), revision: revisionOf(args) }; }, execute: async (args, context) => {
      const linked = getLinked(); let item = await store.readWork(idOf(args)); store.assertWorkRevision(item, revisionOf(args));
      if (!['local','prepared','approved','failed','uncertain'].includes(item.status)) throw new Error('Consulta o recupera la transferencia existente antes de crear otra.');
      let approved = item;
      if (approved.status !== 'approved') { if (approved.status !== 'prepared') approved = store.transitionWorkItem(approved, 'prepared'); approved = store.transitionWorkItem(approved, 'approved'); }
      const frozen = await prepare(approved, linked.host);
      await approve(context, linked.host, `Transferir «${item.title}» al host`, { operation: 'store-only', manifest: frozen.manifest, manifestHash: frozen.manifestHash, meaning: 'Guarda archivos y versiones; no ejecuta acciones externas ni aprueba la minuta.' });
      getLinked();
      const current = await store.readWork(item.id); store.assertWorkRevision(current, item.revision);
      context.signal.throwIfAborted();
      if (item.status !== 'approved') { if (item.status !== 'prepared') item = await store.transitionWork(item.id, item.revision, 'prepared'); item = await store.transitionWork(item.id, item.revision, 'approved'); }
      context.signal.throwIfAborted();
      const result = await linked.dispatcher.send(item.id, item.revision, frozen.manifestHash, context.signal); return { ...summary(result), receipt: result.transfer?.receipt, executed: false };
    } },
    { definition: { name: 'work_recover', description: 'Consulta el ACK durable de una transferencia existente y reanuda sólo sus bytes ya aprobados. Nunca repite procesamiento ni acciones externas.', parameters: schema(id, ['id']) }, validate(args) { return { id: idOf(args) }; }, execute: async (args, context) => { context.signal.throwIfAborted(); const result = await getLinked().dispatcher.recover(idOf(args), context.signal); return { ...summary(result), receipt: result.transfer?.receipt }; } },
    { definition: { name: 'work_process', description: 'Propone procesar una reunión confirmada en el host con el transcriptor configurado de la PC y su modelo Pi. Solicita aprobación del contenido exacto y produce únicamente una minuta para revisión, sin enviar comunicaciones ni modificar servicios.', parameters: schema(versioned, ['id','revision']) }, validate(args) { return { id: idOf(args), revision: revisionOf(args) }; }, execute: async (args, context) => {
      const linked = getLinked('process'); const item = await store.readWork(idOf(args)); store.assertWorkRevision(item, revisionOf(args));
      if (!item.transfer?.receipt || item.status !== 'sent') throw new Error('El host debe confirmar primero los archivos de esta reunión.');
      await approve(context, linked.host, `Preparar borrador de «${item.title}»`, { operation: 'meeting-draft-only', receipt: item.transfer.receipt, manifest: item.transfer.manifest, requiresReview: true });
      getLinked('process');
      store.assertWorkRevision(await store.readWork(item.id), item.revision);
      context.signal.throwIfAborted();
      return { id: item.id, processing: await linked.dispatcher.process(item.id, item.transfer.manifestHash, context.signal) };
    } },
    { definition: { name: 'work_result', description: 'Consulta y conserva offline el borrador de la reunión, con evidencia temporal, fuente, responsables y fechas sustentados. No aprueba el resultado.', parameters: schema(id, ['id']) }, validate(args) { return { id: idOf(args) }; }, execute: async (args, context) => { context.signal.throwIfAborted(); return { id: idOf(args), processing: await getLinked().dispatcher.result(idOf(args)) }; } },
    { definition: { name: 'work_propose_action', description: 'Guarda una propuesta local de llamada para una minuta aprobada, usando conexión y herramienta descubiertas. No revisa el esquema remoto, no conecta, no aprueba ni ejecuta la acción. Si la minuta cambia, la propuesta deja de estar vigente.', parameters: schema({ workId: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, connectionId: { type: 'string' }, tool: { type: 'string' }, description: { type: 'string', maxLength: 200 }, arguments: { type: 'object' } }, ['workId','revision','connectionId','tool','description','arguments']) },
      validate(args) { const value = validateMinuteProposal(args); return { workId: value.workId, revision: value.revision, connectionId: value.connectionId, tool: value.tool, description: value.description, arguments: JSON.parse(value.argumentsJSON) }; },
      async execute(args, context) { context.signal.throwIfAborted(); return createMinuteProposal(args); } },
    { definition: { name: 'work_proposals', description: 'Consulta propuestas locales de una minuta y si siguen vinculadas a su versión aprobada. Ninguna implica aprobación o ejecución de la acción externa.', parameters: schema(id, ['id']) },
      validate(args) { return { id: idOf(args) }; }, async execute(args, context) { context.signal.throwIfAborted(); return listMinuteProposals(idOf(args)); } },
    { definition: { name: 'work_review_action', description: 'Solicita revisión humana de una propuesta vigente y ejecuta sólo si se aprueban servicio y argumentos exactos. Nunca repite una llamada incierta; una interrupción puede dejar el trabajo protegido para revisión.', parameters: schema({ ...id, proposalId: { type: 'string' } }, ['id','proposalId']) },
      validate(args) { const value = input(args); const id = idOf(value); if (typeof value.proposalId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.proposalId)) throw new Error('Propuesta inválida.'); return { id, proposalId: value.proposalId }; },
      async execute(args, context) {
        const value = input(args), id = idOf(value), proposalId = value.proposalId;
        if (typeof proposalId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(proposalId) || !context.askApproval) throw new Error('La acción necesita una revisión humana.');
        context.signal.throwIfAborted();
        const lease = await acquireMinuteAction(id, proposalId); let approved = false;
        try {
          const proposal = lease.proposal;
          // MCP calls always ask; the provider allowlist contains only write tools.
          if (!/^(?:mcp_[a-f0-9]{24}|api_[a-f0-9]{32}_(?:create_issue|send_message|create_task|update_task))$/.test(proposal.tool)) throw new Error('Esta propuesta no es una acción compatible para revisión.');
          const request = { connectionId: proposal.connectionId, tool: proposal.tool, arguments: JSON.parse(proposal.argumentsJSON) };
          const result = await connectionCall.execute(connectionCall.validate(request), { ...context, askApproval: async review => {
            context.signal.throwIfAborted();
            const current = await inbox.readWork(id);
            const accepted = await context.askApproval!({ ...review, details: `Minuta aprobada: ${current.title} · revisión ${proposal.revision}. Propuesta: ${proposal.description}.\n${review.details}` });
            if (!accepted) return false;
            context.signal.throwIfAborted();
            await markMinuteActionExecuting(id, proposalId, lease.leaseId);
            approved = true; return true;
          } });
          if (!approved) { await finishMinuteAction(id, proposalId, lease.leaseId, 'denied'); return { executed: false, approved: false }; }
          if (!record(result) || result.confirmed !== true) throw new Error('La respuesta no confirmó la operación.');
          await finishMinuteAction(id, proposalId, lease.leaseId, 'responded');
          return { ...result, minuteWorkId: id, proposalId };
        } catch (error) {
          try { await finishMinuteAction(id, proposalId, lease.leaseId, approved ? 'uncertain' : 'denied'); }
          catch { throw new Error('No se confirmó el estado de la acción. Revisa el trabajo y el servicio antes de continuar.'); }
          if (approved) throw new Error('La acción quedó sin confirmar. No se volverá a enviar automáticamente; revisa el servicio.');
          throw error;
        }
      } },
    { definition: { name: 'work_correct', description: 'Crea una copia local editable de una minuta recuperada, conservando adjuntos, evidencia y recibo de origen. La corrección empieza sin aprobar.', parameters: schema(versioned, ['id','revision']) }, validate(args) { return { id: idOf(args), revision: revisionOf(args) }; }, execute: async (args, context) => { context.signal.throwIfAborted(); return summary(await store.createWorkFromResult(idOf(args), revisionOf(args))); } },
  ];
}
