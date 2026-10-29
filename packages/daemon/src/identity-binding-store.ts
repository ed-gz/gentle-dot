import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Experimental, disconnected host store. Its caller must establish identity
 * from an authenticated Pi lifecycle boundary; it never infers equivalence
 * from text and does not read, delete, merge or acknowledge message content. */
export type IdentityBinding = { scope: string; liveId: string; sessionId: string; entryId: string };
const APPLICATION_ID = 0x43415049; // CAPI
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
function validate(value: IdentityBinding): void {
  if (!value || Object.keys(value).sort().join(',') !== 'entryId,liveId,scope,sessionId' ||
    !identifier(value.scope) || !identifier(value.liveId) || !identifier(value.sessionId) || !identifier(value.entryId)) throw new Error('Identidad de origen inválida; no se creó ningún vínculo.');
}
const rowToBinding = (row: Record<string, unknown> | undefined): IdentityBinding | undefined => {
  if (!row) return;
  const value = {scope:row.scope,liveId:row.live_id,sessionId:row.session_id,entryId:row.entry_id} as IdentityBinding;
  validate(value); return value;
};

/** The database path must be inside a private, daemon-controlled directory.
 * This module does not authenticate callers and is intentionally not activated. */
export function openIdentityBindingStore(path: string) {
  if (!path || path.includes('\0')) throw new Error('Ruta de identidad inválida.');
  let created = false;
  try { closeSync(openSync(path, 'wx', 0o600)); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!lstatSync(path).isFile()) throw new Error('El archivo de identidad debe ser regular.');
  const db = new DatabaseSync(path, { timeout: 2000, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    try {
      const app = db.prepare('PRAGMA application_id').get()?.application_id;
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (app === 0 && version === 0) {
        if (!created) throw new Error('El archivo preexistente no tiene identidad de aplicación; no se modificó.');
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length) throw new Error('El archivo contiene otro esquema; no se modificó.');
        db.exec(`CREATE TABLE bindings (
          scope TEXT NOT NULL, live_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
          PRIMARY KEY(scope, live_id), UNIQUE(scope, session_id, entry_id)
        ) STRICT; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1`);
      } else if (app !== APPLICATION_ID || version !== 1) throw new Error('El archivo de identidad tiene una versión desconocida; no se modificó.');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  const byLive = db.prepare('SELECT scope, live_id, session_id, entry_id FROM bindings WHERE scope = ? AND live_id = ?');
  const bySource = db.prepare('SELECT scope, live_id, session_id, entry_id FROM bindings WHERE scope = ? AND session_id = ? AND entry_id = ?');
  const insert = db.prepare('INSERT INTO bindings(scope, live_id, session_id, entry_id) VALUES (?, ?, ?, ?)');
  return {
    /** Idempotent exact retry; either side already linked differently is a
     * conflict, never permission to replace or merge either source. */
    bind(value: IdentityBinding): 'created' | 'existing' {
      validate(value); db.exec('BEGIN IMMEDIATE');
      try {
        const a = rowToBinding(byLive.get(value.scope,value.liveId));
        const b = rowToBinding(bySource.get(value.scope,value.sessionId,value.entryId));
        if (a || b) {
          if (!a || !b || a.liveId !== value.liveId || a.sessionId !== value.sessionId || a.entryId !== value.entryId || b.liveId !== value.liveId) throw new Error('La identidad ya está vinculada de otra forma; se conservan ambas fuentes.');
          db.exec('COMMIT'); return 'existing';
        }
        insert.run(value.scope,value.liveId,value.sessionId,value.entryId); db.exec('COMMIT'); return 'created';
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    findLive(scope: string, liveId: string): IdentityBinding | undefined {
      if (!identifier(scope) || !identifier(liveId)) throw new Error('Identidad de origen inválida.');
      return rowToBinding(byLive.get(scope,liveId));
    },
    findSource(scope: string, sessionId: string, entryId: string): IdentityBinding | undefined {
      if (!identifier(scope) || !identifier(sessionId) || !identifier(entryId)) throw new Error('Identidad de origen inválida.');
      return rowToBinding(bySource.get(scope,sessionId,entryId));
    },
    close() { db.close(); },
  };
}
