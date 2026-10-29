import { invoke, isTauri } from '@tauri-apps/api/core';
import { nativeSHA256Bytes } from './device-bridge.ts';

export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 90;
const DOCUMENT_MIMES = new Set(['image/png', 'image/jpeg', 'image/heic', 'image/heif', 'image/webp', 'image/tiff', 'application/pdf']);

/** WKWebView custom origins may lack WebCrypto; the native path hashes the same bytes in chunks. */
export async function hashSourceBytes(bytes: Uint8Array<ArrayBuffer>,
  subtle: Pick<SubtleCrypto, 'digest'> | null | undefined = globalThis.crypto?.subtle,
  fallback: (bytes: Uint8Array<ArrayBuffer>) => Promise<string> = nativeSHA256Bytes): Promise<string> {
  const hex = subtle
    ? Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    : await fallback(bytes);
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('No se pudo verificar la huella del archivo original.');
  return hex;
}

export interface VoiceAvailability {
  available: boolean;
  status: string;
  locale?: string;
  assetsInstalled: boolean;
  microphonePermission: 'granted' | 'denied' | 'undetermined';
  recording: boolean;
  readyToTranscribe: boolean;
  busy: boolean;
  sessionId?: string;
  ownerId?: string;
  recoveryPending?: boolean;
  /** Bounded, non-sensitive explanation of why this recording needs review or retry. */
  recoveryIssue?: string;
  /** Provisional text is display-only and must never be sent as a final transcript. */
  partial?: string;
  previewIssue?: string;
  /** Ephemeral input level, not speech detection. Absent when metering is unavailable. */
  microphoneLevel?: number;
}
export interface VoiceSession { sessionId: string; maxDurationSeconds: number }
export interface VoiceSegment { text: string; startSeconds: number; endSeconds: number }
export interface VoiceTranscript {
  sessionId: string;
  text: string;
  segments: VoiceSegment[];
  durationSeconds: number;
  locale: string;
  source: 'apple-speech-analyzer';
}
export interface DocumentObservation {
  kind: 'text' | 'barcode';
  text: string;
  confidence: number;
  bounds: { x: number; y: number; width: number; height: number };
  symbology?: string;
}
export interface DocumentPage {
  page: number;
  pixelWidth: number;
  pixelHeight: number;
  text: string;
  observations: DocumentObservation[];
}
export interface RecognizedDocument {
  source: { name: string; mimeType: string; size: number; sha256: string };
  pages: DocumentPage[];
  text: string;
  coordinateSystem: 'normalized-bottom-left';
  engine: 'apple-vision';
  warnings: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La respuesta nativa no es válida.');
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > max) throw new Error('La respuesta nativa contiene texto no válido.');
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('La respuesta nativa contiene un rango no válido.');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  const parsed = number(value, min, max);
  if (!Number.isInteger(parsed)) throw new Error('La respuesta nativa contiene un tamaño no válido.');
  return parsed;
}
function sessionId(value: unknown): string {
  const id = string(value, 36);
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error('El comando de voz no es válido.');
  return id;
}
function successful(value: unknown): Record<string, unknown> {
  const reply = object(value);
  if (reply.ok !== true) {
    const message = typeof reply.message === 'string' && reply.message.length <= 500 ? reply.message : 'La operación local no pudo completarse.';
    throw new Error(message);
  }
  return reply;
}
async function native(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) throw new Error('La voz y Vision requieren Capri instalada en el iPhone. Este navegador es una vista previa.');
  try { return await invoke(`plugin:perception|${command}`, args); }
  catch { throw new Error('No pude comunicarme con las funciones del iPhone. Cierra y vuelve a abrir Capri.'); }
}

export class VoiceBridgeTimeout extends Error {
  constructor(message: string) { super(message); this.name = 'VoiceBridgeTimeout'; }
}
/** A late result can never turn a timed-out status check into success. */
export async function withVoiceDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VoiceBridgeTimeout(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Fence a timed-out start by owner. An old attempt must not cancel a newer one. */
export async function voiceStartWithDeadline<T>(operation: Promise<T>, cancelOwner: () => Promise<void>, timeoutMs = 60_000, cancelTimeoutMs = 8_000): Promise<T> {
  try {
    return await withVoiceDeadline(operation, timeoutMs, 'El micrófono tardó demasiado. Revisa el permiso de iOS y vuelve a intentarlo.');
  } catch (error) {
    if (error instanceof VoiceBridgeTimeout) {
      try { await withVoiceDeadline(cancelOwner(), cancelTimeoutMs, 'No se confirmó la cancelación.'); }
      catch { throw new Error('No pude confirmar que el micrófono se detuvo. Sal de Capri para interrumpirlo.'); }
    }
    throw error;
  }
}

export function parseVoiceAvailability(value: unknown): VoiceAvailability {
  const reply = object(value);
  const status = string(reply.status, 100);
  const available = reply.available === true && status === 'available' && reply.assetsInstalled === true;
  const permission = reply.microphonePermission;
  return {
    available, status,
    ...(typeof reply.locale === 'string' ? { locale: string(reply.locale, 40) } : {}),
    assetsInstalled: reply.assetsInstalled === true,
    microphonePermission: permission === 'granted' || permission === 'denied' ? permission : 'undetermined',
    recording: reply.recording === true, readyToTranscribe: reply.readyToTranscribe === true, busy: reply.busy === true,
    ...(reply.sessionId !== undefined ? { sessionId: sessionId(reply.sessionId) } : {}),
    ...(reply.ownerId !== undefined ? { ownerId: sessionId(reply.ownerId) } : {}),
    ...(reply.recoveryPending === true ? { recoveryPending: true } : {}),
    ...(reply.recoveryIssue !== undefined ? { recoveryIssue: string(reply.recoveryIssue, 500) } : {}),
    ...(reply.partial !== undefined ? { partial: string(reply.partial, 4_800, true) } : {}),
    ...(reply.previewIssue !== undefined ? { previewIssue: string(reply.previewIssue, 500) } : {}),
    ...(typeof reply.microphoneLevel === 'number' && Number.isFinite(reply.microphoneLevel) && reply.microphoneLevel >= 0 && reply.microphoneLevel <= 1
      ? { microphoneLevel: reply.microphoneLevel } : {}),
  };
}
export function parseVoiceSession(value: unknown): VoiceSession {
  const reply = successful(value);
  return { sessionId: sessionId(reply.sessionId), maxDurationSeconds: integer(reply.maxDurationSeconds, 1, VOICE_MAX_SECONDS) };
}
export class VoiceRetryPending extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message: string) { super(message); this.sessionId = sessionId; this.name = 'VoiceRetryPending'; }
}
export function parseVoiceTranscript(value: unknown, expectedSession: string): VoiceTranscript {
  const pending = object(value);
  if (pending.ok === false && pending.error === 'preview_pending') {
    const id = sessionId(pending.sessionId);
    if (id.toLowerCase() !== sessionId(expectedSession).toLowerCase()) throw new Error('La recuperación de voz no corresponde al comando actual.');
    const message = typeof pending.message === 'string' && pending.message.length <= 500 ? pending.message : 'El audio está guardado. Reintenta la transcripción.';
    throw new VoiceRetryPending(id, message);
  }
  const reply = successful(value);
  const id = sessionId(reply.sessionId);
  if (id !== sessionId(expectedSession) || reply.source !== 'apple-speech-analyzer') throw new Error('La transcripción no corresponde al comando actual.');
  const duration = number(reply.durationSeconds, 0.001, VOICE_MAX_SECONDS + 1);
  if (!Array.isArray(reply.segments) || reply.segments.length < 1 || reply.segments.length > 2_000) throw new Error('La transcripción no contiene evidencia temporal válida.');
  const segments = reply.segments.map(value => {
    const part = object(value);
    const start = number(part.startSeconds, 0, duration + 0.1);
    return { text: string(part.text, 32_000), startSeconds: start, endSeconds: number(part.endSeconds, start, duration + 0.1) };
  });
  if (segments.some((segment, i) => i > 0 && segment.startSeconds < segments[i - 1]!.startSeconds)) throw new Error('La transcripción está fuera de orden.');
  const text = string(reply.text, 32_000);
  if (text !== segments.map(segment => segment.text).join(' ')) throw new Error('El texto no corresponde a la evidencia temporal.');
  return { sessionId: id, text, segments, durationSeconds: duration, locale: string(reply.locale, 40), source: 'apple-speech-analyzer' };
}

export function validateDocument(file: Pick<File, 'name' | 'type' | 'size'>): void {
  if (!file.name || file.name.length > 255 || /[\u0000-\u001f\u007f-\u009f]/u.test(file.name)) throw new Error('El nombre del archivo no es válido.');
  if (!DOCUMENT_MIMES.has(file.type)) throw new Error('Usa PNG, JPEG, HEIC, HEIF, WebP, TIFF de una página o PDF.');
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) throw new Error('El archivo debe contener datos y ocupar como máximo 12 MiB.');
}

export function parseRecognizedDocument(value: unknown, expected: { name: string; type: string; size: number; sha256: string }): RecognizedDocument {
  const reply = successful(value);
  const source = object(reply.source);
  if (source.name !== expected.name || source.mimeType !== expected.type || source.size !== expected.size
    || source.sha256 !== expected.sha256 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('La lectura no corresponde al archivo importado.');
  if (reply.engine !== 'apple-vision' || reply.coordinateSystem !== 'normalized-bottom-left') throw new Error('El origen de la lectura no es válido.');
  if (!Array.isArray(reply.pages) || reply.pages.length < 1 || reply.pages.length > 20) throw new Error('La lectura tiene un número de páginas no válido.');
  const pages = reply.pages.map((value, i): DocumentPage => {
    const page = object(value);
    if (page.page !== i + 1 || !Array.isArray(page.observations) || page.observations.length > 2_000) throw new Error('La evidencia del documento no es válida.');
    const observations = page.observations.map((value): DocumentObservation => {
      const observation = object(value);
      if (observation.kind !== 'text' && observation.kind !== 'barcode') throw new Error('El tipo de observación no es válido.');
      const bounds = object(observation.bounds);
      const x = number(bounds.x, 0, 1), y = number(bounds.y, 0, 1);
      return { kind: observation.kind, text: string(observation.text, 200_000, true), confidence: number(observation.confidence, 0, 1),
        bounds: { x, y, width: number(bounds.width, 0, 1 - x + 0.00001), height: number(bounds.height, 0, 1 - y + 0.00001) },
        ...(observation.symbology !== undefined ? { symbology: string(observation.symbology, 100) } : {}) };
    });
    const text = string(page.text, 200_000, true);
    if (text !== observations.map(observation => observation.text).join('\n')) throw new Error('El texto leído no corresponde a las observaciones.');
    return { page: i + 1, pixelWidth: integer(page.pixelWidth, 1, 2400), pixelHeight: integer(page.pixelHeight, 1, 2400), text, observations };
  });
  const text = string(reply.text, 200_000, true);
  if (text !== pages.map(page => page.text).join('\n\n')) throw new Error('El texto leído no corresponde a las páginas.');
  if (!Array.isArray(reply.warnings) || reply.warnings.length > 20) throw new Error('Los avisos del documento no son válidos.');
  return { source: { name: expected.name, mimeType: expected.type, size: expected.size, sha256: expected.sha256 }, pages, text,
    coordinateSystem: 'normalized-bottom-left', engine: 'apple-vision', warnings: reply.warnings.map(value => string(value, 500)) };
}

export async function checkVoice(): Promise<VoiceAvailability> {
  return parseVoiceAvailability(await withVoiceDeadline(native('check_voice'), 12_000,
    'La comprobación de voz no respondió. Vuelve a tocar el micrófono.'));
}
/** Explicit user action: Apple may download shared language assets using internet. */
export async function prepareVoice(ownerId?: string): Promise<VoiceAvailability> {
  const result = await native('prepare_voice', ownerId ? { ownerId: sessionId(ownerId) } : undefined);
  successful(result);
  return parseVoiceAvailability(result);
}
export async function startVoice(ownerId?: string): Promise<VoiceSession> {
  if (!ownerId) throw new Error('No pude identificar este dictado. Vuelve a intentarlo.');
  const owner = sessionId(ownerId);
  const reply = await voiceStartWithDeadline(native('start_voice', { ownerId: owner }), () => cancelVoice(owner));
  return parseVoiceSession(reply);
}
/** Returns a draft; it never sends the instruction to a conversation or service. */
export async function stopVoice(id: string): Promise<VoiceTranscript> {
  return parseVoiceTranscript(await native('stop_voice', { sessionId: sessionId(id) }), id);
}
export async function cancelVoice(ownerId?: string): Promise<void> { successful(await native('cancel_voice', ownerId ? { ownerId: sessionId(ownerId) } : undefined)); }
export async function cancelDocument(): Promise<void> { successful(await native('cancel_document')); }
export async function recognizeDocument(file: File): Promise<RecognizedDocument> {
  validateDocument(file);
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size) throw new Error('El archivo cambió durante la lectura. Vuelve a importarlo.');
  const sha256 = await hashSourceBytes(new Uint8Array(buffer));
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  const base64 = btoa(chunks.join(''));
  const result = await native('recognize_document', { request: { base64, mimeType: file.type, fileName: file.name } });
  return parseRecognizedDocument(result, { name: file.name, type: file.type, size: file.size, sha256 });
}
