import { deviceInvoke, requireNative, validSharedImport, listSharedImports, readSharedFile, readSharedFileChunk, acknowledgeSharedImport,
  type DeviceInvoker, type NativeReply, type SharedImport } from './device-bridge.ts';

function documentInvoker(call: DeviceInvoker): DeviceInvoker {
  const commands: Record<string, string> = { share_list: 'documents_list', share_read: 'documents_read', share_ack: 'documents_ack' };
  return (command, request) => call(commands[command] ?? command, request);
}
export async function pickDocuments(call: DeviceInvoker = deviceInvoke): Promise<SharedImport | null> {
  const result = requireNative(await call<NativeReply & { items?: unknown; cancelled?: unknown }>('documents_pick', {}));
  if (!Array.isArray(result.items) || typeof result.cancelled !== 'boolean') throw new Error('El selector no confirmó la importación.');
  if (result.cancelled && result.items.length === 0) return null;
  if (result.cancelled || result.items.length !== 1 || !validSharedImport(result.items[0])) throw new Error('El selector devolvió un archivo inválido.');
  return result.items[0];
}
export function listDocumentImports(call: DeviceInvoker = deviceInvoke) { return listSharedImports(documentInvoker(call)); }
export async function importDocumentItem(item: SharedImport,
  save: (input: { sourceId: string; item: SharedImport; files: File[] }) => Promise<void>, call: DeviceInvoker = deviceInvoke): Promise<void> {
  if (!validSharedImport(item)) throw new Error('Importación de documentos inválida.');
  const invoke = documentInvoker(call), files: File[] = [];
  for (const file of item.files) files.push(await readSharedFile(item, file, invoke));
  await save({ sourceId: `document:${item.id}`, item, files });
  await acknowledgeSharedImport(item.id, invoke);
}
export async function importDocumentItemStreamed(item: SharedImport,
  save: (input: { sourceId: string; item: SharedImport; read: (file: SharedImport['files'][number], offset: number, length: number) => Promise<Uint8Array> }) => Promise<void>, call: DeviceInvoker = deviceInvoke): Promise<void> {
  if (!validSharedImport(item)) throw new Error('Importación de documentos inválida.');
  const invoke = documentInvoker(call);
  await save({ sourceId: `document:${item.id}`, item, read: (file, offset, length) => readSharedFileChunk(item, file, offset, length, invoke) });
  await acknowledgeSharedImport(item.id, invoke);
}
