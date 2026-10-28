export type Service = 'github' | 'slack' | 'gmail' | 'odoo';
export type AttachmentRef = { workId: string; fileId: string; name: string; mime: string; size: number; sha256: string };
export type Operation =
  | { kind: 'github.issue'; repository: string; title: string; text: string; labels: string[] }
  | { kind: 'slack.message'; channel: string; text: string }
  | { kind: 'gmail.message'; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; attachments: AttachmentRef[] }
  | { kind: 'odoo.task.create'; projectId: number; name: string; description: string; assigneeIds: number[]; deadline?: string }
  | { kind: 'odoo.task.update'; taskId: number; changes: { name?: string; description?: string; stageId?: number; assigneeIds?: number[]; deadline?: string | null } };
export type ActionState = 'draft' | 'approved' | 'executing' | 'succeeded' | 'uncertain' | 'failed';
export type ExternalAction = {
  id: string; connectionId: string; connectionRevision: number; revision: number;
  operation: Operation; state: ActionState; createdAt: number; updatedAt: number;
  approval?: { digest: string; revision: number; at: number };
  executionId?: string; result?: { id?: string; url?: string; message: string }; error?: string;
};
export const serviceFor = (operation: Operation): Service => operation.kind.split('.')[0] as Service;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number, label: string, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /\u0000/.test(value)) throw new Error(`${label} no válido.`);
  return value.trim();
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('El identificador debe ser un entero positivo.');
  return value as number;
}
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Selecciona hasta 20 responsables confirmados.');
  return [...new Set(value.map(positive))];
}
function deadline(value: unknown): string {
  const date = text(value, 10, 'Fecha');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('La fecha debe existir y usar AAAA-MM-DD.');
  return date;
}
function addresses(value: unknown, required = false): string[] {
  if (!Array.isArray(value) || value.length > 30 || (required && !value.length)) throw new Error('Indica de 1 a 30 destinatarios.');
  return [...new Set(value.map(input => {
    const email = text(input, 254, 'Dirección');
    if (!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(email)) throw new Error('Usa direcciones de correo completas, sin nombres ni saltos de línea.');
    return email;
  }))];
}
function attachments(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('Adjunta hasta cinco archivos.');
  let total = 0;
  return value.map(input => {
    if (!object(input)) throw new Error('Adjunto no válido.');
    const file = {
      workId: text(input.workId, 150, 'Trabajo'), fileId: text(input.fileId, 150, 'Archivo'),
      name: text(input.name, 255, 'Nombre de archivo'), mime: text(input.mime, 150, 'Tipo de archivo'),
      size: positive(input.size), sha256: text(input.sha256, 64, 'Hash'),
    };
    if (/[\r\n]/.test(file.name) || !/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/i.test(file.mime) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Metadatos de adjunto no válidos.');
    total += file.size;
    if (total > 800_000) throw new Error('Los adjuntos del correo pueden sumar hasta 800 kB en esta entrega.');
    return file;
  });
}
/** Model/provider content is untrusted input. Only declared operations cross this boundary. */
export function validateOperation(input: unknown): Operation {
  if (!object(input)) throw new Error('Operación no válida.');
  switch (input.kind) {
    case 'github.issue': {
      const repository = text(input.repository, 200, 'Repositorio');
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) || repository.split('/').some(part => ['.', '..'].includes(part))) throw new Error('Usa propietario/repositorio.');
      if (!Array.isArray(input.labels) || input.labels.length > 20) throw new Error('Selecciona hasta 20 etiquetas.');
      return { kind: input.kind, repository, title: text(input.title, 256, 'Título'), text: text(input.text, 30000, 'Contenido'), labels: [...new Set(input.labels.map(label => text(label, 100, 'Etiqueta')))] };
    }
    case 'slack.message': {
      const channel = text(input.channel, 100, 'Canal');
      if (!/^[CDG][A-Z0-9]+$/.test(channel)) throw new Error('Selecciona el ID de un canal o conversación de Slack.');
      return { kind: input.kind, channel, text: text(input.text, 10000, 'Mensaje') };
    }
    case 'gmail.message': {
      const subject = text(input.subject, 500, 'Asunto');
      if (/[\r\n]/.test(subject)) throw new Error('El asunto no admite saltos de línea.');
      return { kind: input.kind, to: addresses(input.to, true), cc: addresses(input.cc), bcc: addresses(input.bcc), subject, text: text(input.text, 30000, 'Mensaje'), attachments: attachments(input.attachments) };
    }
    case 'odoo.task.create':
      return { kind: input.kind, projectId: positive(input.projectId), name: text(input.name, 256, 'Nombre'), description: text(input.description, 30000, 'Descripción', false), assigneeIds: ids(input.assigneeIds), ...(input.deadline ? { deadline: deadline(input.deadline) } : {}) };
    case 'odoo.task.update': {
      if (!object(input.changes)) throw new Error('Cambios no válidos.');
      const changes: Extract<Operation, { kind: 'odoo.task.update' }>['changes'] = {};
      if (input.changes.name !== undefined) changes.name = text(input.changes.name, 256, 'Nombre');
      if (input.changes.description !== undefined) changes.description = text(input.changes.description, 30000, 'Descripción', false);
      if (input.changes.stageId !== undefined) changes.stageId = positive(input.changes.stageId);
      if (input.changes.assigneeIds !== undefined) changes.assigneeIds = ids(input.changes.assigneeIds);
      if (input.changes.deadline !== undefined) changes.deadline = input.changes.deadline === null ? null : deadline(input.changes.deadline);
      if (!Object.keys(changes).length) throw new Error('Indica al menos un cambio.');
      return { kind: input.kind, taskId: positive(input.taskId), changes };
    }
    default: throw new Error('Esta herramienta todavía no está disponible.');
  }
}
export function actionContent(action: Pick<ExternalAction, 'id' | 'connectionId' | 'connectionRevision' | 'revision' | 'operation'>): string {
  return JSON.stringify({ id: action.id, connectionId: action.connectionId, connectionRevision: action.connectionRevision, revision: action.revision, operation: validateOperation(action.operation) });
}
export function reviseAction(action: ExternalAction, operation: unknown, connectionId = action.connectionId, connectionRevision = action.connectionRevision, now = Date.now()): ExternalAction {
  if (['executing', 'succeeded'].includes(action.state)) throw new Error('Esta acción está en curso o ya terminó. Prepara otra para cambiarla.');
  return { id: action.id, connectionId, connectionRevision: positive(connectionRevision), revision: action.revision + 1, operation: validateOperation(operation), state: 'draft', createdAt: action.createdAt, updatedAt: now };
}
export function approveAction(action: ExternalAction, digest: string, now = Date.now()): ExternalAction {
  if (action.state !== 'draft' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Revisa primero el contenido actual de la acción.');
  return { ...action, state: 'approved', approval: { digest, revision: action.revision, at: now }, updatedAt: now };
}
export function beginAction(action: ExternalAction, digest: string, connectionRevision: number, executionId: string, now = Date.now()): ExternalAction {
  if (action.state !== 'approved' || !action.approval || action.approval.digest !== digest || action.approval.revision !== action.revision || action.connectionRevision !== connectionRevision) throw new Error('La aprobación ya no corresponde a esta acción o conexión. Vuelve a revisarla.');
  return { ...action, state: 'executing', executionId, updatedAt: now };
}
/** An unresolved network outcome is never automatically replayed. */
export function finishAction(action: ExternalAction, executionId: string, outcome: 'succeeded' | 'uncertain' | 'failed', result: ExternalAction['result'], error?: string, now = Date.now()): ExternalAction {
  if (action.state !== 'executing' || action.executionId !== executionId) throw new Error('El resultado pertenece a otra ejecución.');
  return { ...action, state: outcome, result, ...(error ? { error: error.slice(0, 1000) } : {}), updatedAt: now };
}
export function recoverAction(action: ExternalAction): ExternalAction {
  return action.state === 'executing' ? { ...action, state: 'uncertain', error: 'Capri se cerró durante el envío. Comprueba el servicio antes de preparar otro intento.' } : action;
}
