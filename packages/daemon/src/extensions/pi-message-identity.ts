/** Resolve a Pi message only by its exact in-process object identity, after Pi
 * has appended it to the current branch. The result is source evidence, not a
 * live/history mapping or an authorization to remove an archived copy.
 *
 * `message_end` fires before persistence in the installed Pi runtime; callers
 * must use a later lifecycle boundary and must never fall back to equal text.
 * A copied/rehydrated message, changed session or ambiguous branch fails closed. */
export function persistedPiMessageIdentity(
  manager: { getSessionId(): string; getBranch(): readonly unknown[] },
  expectedSession: string,
  message: object,
): { sessionId: string; entryId: string } | undefined {
  if (!expectedSession || expectedSession.length > 512 || manager.getSessionId() !== expectedSession) return;
  const role = (message as Record<string, unknown>).role;
  if (role !== 'user' && role !== 'assistant') return;
  const branch = manager.getBranch();
  const matches = branch.filter(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const value = entry as Record<string, unknown>;
    return value.type === 'message' && value.message === message;
  });
  if (matches.length !== 1) return;
  const entry = matches[0] as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 512) return;
  if (branch.filter(value => value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).id === entry.id).length !== 1) return;
  return { sessionId: expectedSession, entryId: entry.id };
}
