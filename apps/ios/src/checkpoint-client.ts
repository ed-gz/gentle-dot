import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import type { ToolDefinition } from './agent-tools.ts';
import { validateAgentDecision, type AgentDecision } from './local-intelligence.ts';
import { hashSourceBytes } from './perception.ts';

/** This bridge plans with Apple's model but does not execute tool proposals.
 * A caller must durably anchor the checkpoint ID to the originating conversation
 * before creation. Never run or execute a recovered proposal automatically; a
 * foreground executor still needs validated arguments, approval and receipts. */
export type CheckpointState = 'ready' | 'running' | 'awaitingForeground' | 'executingForeground' | 'uncertainForeground' | 'budgetExhausted' | 'answer' | 'interrupted' | 'cancelled';
export type CheckpointSummary = { id: string; revision: string; sourceFingerprint: string; state: CheckpointState; stepId?: string; decision?: AgentDecision };
export type CheckpointSnapshot = { items: CheckpointSummary[]; activeId?: string };
export type CheckpointInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const states = new Set<CheckpointState>(['ready', 'running', 'awaitingForeground', 'executingForeground', 'uncertainForeground', 'budgetExhausted', 'answer', 'interrupted', 'cancelled']);
const nativeCall: CheckpointInvoke = (command, args) => {
  if (!isTauri()) return Promise.reject(new Error('El análisis nativo necesita Capri instalado en el iPhone.'));
  return tauriInvoke(`plugin:local-intelligence|${command}`, args);
};
type FrozenTool = { name: string; description: string; schemaJSON: string };
export async function checkpointFingerprint(instruction: string, context: string, tools: FrozenTool[]): Promise<string> {
  return hashSourceBytes(new TextEncoder().encode(JSON.stringify([instruction, context, tools])));
}
async function record(value: unknown): Promise<CheckpointSummary> {
  if (!object(value) || !uuid(value.id) || !uuid(value.revision) || typeof value.state !== 'string' || !states.has(value.state as CheckpointState)) throw new Error('El registro del análisis no es válido. El original se conserva.');
  const state = value.state as CheckpointState;
  if ((state === 'running' && !uuid(value.stepID)) || (state !== 'running' && value.stepID != null)) throw new Error('El paso del análisis no coincide. El original se conserva.');
  const needsDecision = ['answer', 'awaitingForeground', 'executingForeground', 'uncertainForeground'].includes(state);
  if ((needsDecision && !validateAgentDecision(value.decision)) || (!needsDecision && value.decision != null) || (needsDecision && object(value.decision) && ((state === 'answer') !== (value.decision.kind === 'answer')))) throw new Error('La propuesta del análisis no es válida. El original se conserva.');
  if (typeof value.instruction !== 'string' || !value.instruction.trim() || Array.from(value.instruction).length > 2400 || typeof value.context !== 'string' || Array.from(value.context).length > 8000 || !Array.isArray(value.tools) || value.tools.length > 64) throw new Error('El contenido del análisis no es válido. El original se conserva.');
  const names = new Set<string>();
  const tools: FrozenTool[] = value.tools.map(tool => {
    if (!object(tool) || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string' || Array.from(tool.description).length > 4000 || typeof tool.schemaJSON !== 'string' || new TextEncoder().encode(tool.schemaJSON).length > 16_384) throw new Error('El catálogo del análisis no es válido. El original se conserva.');
    let schema: unknown;
    try { schema = JSON.parse(tool.schemaJSON); } catch { throw new Error('El catálogo del análisis no es válido. El original se conserva.'); }
    if (!object(schema) || schema.type !== 'object') throw new Error('El catálogo del análisis no es válido. El original se conserva.');
    names.add(tool.name);
    return { name: tool.name, description: tool.description, schemaJSON: tool.schemaJSON };
  });
  if (needsDecision && object(value.decision) && value.decision.kind === 'tool' && (typeof value.decision.toolName !== 'string' || !names.has(value.decision.toolName))) throw new Error('La propuesta no pertenece al catálogo guardado. El original se conserva.');
  const sourceFingerprint = await checkpointFingerprint(value.instruction, value.context, tools);
  return { id: value.id, revision: value.revision, sourceFingerprint, state, ...(uuid(value.stepID) ? { stepId: value.stepID } : {}), ...(needsDecision ? { decision: value.decision as AgentDecision } : {}) };
}
function success(value: unknown): Record<string, unknown> {
  if (!object(value) || value.ok !== true) {
    const message = object(value) && typeof value.message === 'string' && value.message.length <= 500 ? value.message : 'No se confirmó el análisis nativo. Revisa el registro antes de reintentar.';
    throw new Error(message);
  }
  return value;
}
function identity(id: string, revision: string): void {
  if (!uuid(id) || !uuid(revision)) throw new Error('La identidad del análisis no es válida.');
}
async function snapshot(value: unknown): Promise<CheckpointSnapshot> {
  const reply = success(value);
  if (!Array.isArray(reply.items) || reply.items.length > 20 || (reply.activeId != null && !uuid(reply.activeId))) throw new Error('La lista de análisis no es válida. Los registros se conservan.');
  const items = await Promise.all(reply.items.map(record));
  if (new Set(items.map(item => item.id)).size !== items.length || (reply.activeId && !items.some(item => item.id === reply.activeId))) throw new Error('Las identidades del análisis no coinciden. Los registros se conservan.');
  return { items, ...(reply.activeId ? { activeId: reply.activeId as string } : {}) };
}
function catalog(definitions: ToolDefinition[]): { name: string; description: string; schemaJSON: string }[] {
  if (!Array.isArray(definitions) || definitions.length > 64) throw new Error('El catálogo de herramientas supera el límite.');
  const names = new Set<string>();
  const frozen = definitions.map(definition => {
    if (!definition || !/^[a-z][a-z0-9_]{0,63}$/.test(definition.name) || names.has(definition.name) || typeof definition.description !== 'string' || Array.from(definition.description).length > 4000 || !object(definition.parameters) || definition.parameters.type !== 'object') throw new Error('El catálogo de herramientas no es válido.');
    names.add(definition.name);
    const schemaJSON = JSON.stringify(definition.parameters);
    if (new TextEncoder().encode(schemaJSON).length > 16_384) throw new Error('El esquema de una herramienta supera el límite.');
    return { name: definition.name, description: definition.description, schemaJSON };
  });
  if (new TextEncoder().encode(JSON.stringify(frozen)).length > 1_048_576) throw new Error('El catálogo de herramientas supera el límite.');
  return frozen;
}
export function fingerprintForCheckpoint(instruction: string, context: string, tools: ToolDefinition[]): Promise<string> {
  if (!instruction.trim() || Array.from(instruction).length > 2400 || Array.from(context).length > 8000) throw new Error('La solicitud del análisis no es válida.');
  return checkpointFingerprint(instruction, context, catalog(tools));
}
export function createCheckpointClient(call: CheckpointInvoke = nativeCall) {
  return {
    async create(id: string, instruction: string, context: string, tools: ToolDefinition[]): Promise<CheckpointSummary> {
      if (!uuid(id) || !instruction.trim() || Array.from(instruction).length > 2400 || Array.from(context).length > 8000) throw new Error('La solicitud del análisis no es válida.');
      const frozen = catalog(tools);
      const expected = await checkpointFingerprint(instruction, context, frozen);
      const reply = success(await call('checkpoint_create', { id, instruction, context, tools: frozen }));
      const created = await record(reply.record);
      if (created.id !== id || created.sourceFingerprint !== expected || created.state !== 'ready') throw new Error('La identidad del análisis no coincide. El original se conserva.');
      return created;
    },
    async list(): Promise<CheckpointSnapshot> { return snapshot(await call('checkpoint_list')); },
    async run(id: string, revision: string, allowBackground = false): Promise<CheckpointSummary> {
      identity(id, revision);
      const reply = success(await call('checkpoint_run', { id, revision, allowBackground }));
      const result = await record(reply.record);
      if (result.id !== id || !['answer', 'awaitingForeground', 'budgetExhausted'].includes(result.state)) throw new Error('El resultado del análisis no coincide. El original se conserva.');
      return result;
    },
    /** Call only in response to an explicit user gesture, never on restoration. */
    async resume(id: string, revision: string, confirmedByUser: boolean): Promise<CheckpointSummary> {
      identity(id, revision);
      if (!confirmedByUser) throw new Error('Continuar requiere una indicación tuya.');
      const result = await record(success(await call('checkpoint_resume', { id, revision })).record);
      if (result.id !== id || !['ready', 'budgetExhausted'].includes(result.state)) throw new Error('El análisis cambió. El original se conserva.');
      return result;
    },
    async cancel(id: string, revision: string): Promise<CheckpointSummary> {
      identity(id, revision);
      const result = await record(success(await call('checkpoint_cancel', { id, revision })).record);
      if (result.id !== id || result.state !== 'cancelled') throw new Error('La cancelación no quedó confirmada.');
      return result;
    },
    /** A live stop is a request, not proof the native task has already exited. */
    async stop(id: string, revision: string): Promise<CheckpointSummary | undefined> {
      identity(id, revision);
      const reply = success(await call('checkpoint_stop', { id, revision }));
      if (reply.record == null) return undefined;
      const result = await record(reply.record);
      if (result.id !== id || result.state !== 'cancelled') throw new Error('La cancelación no quedó confirmada.');
      return result;
    },
    async remove(id: string, revision: string): Promise<void> {
      identity(id, revision); success(await call('checkpoint_remove', { id, revision }));
    },
  };
}
