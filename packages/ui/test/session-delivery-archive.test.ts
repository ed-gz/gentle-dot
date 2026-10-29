import { webcrypto } from 'node:crypto';
import { IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import { compactDeliveryArchive, prepareDeliveryArchive, persistDeliveries, reconcileDeliveries, restoreDeliveries, type OutgoingMessage } from '../src/session-delivery.ts';

beforeEach(() => { localStorage.clear(); Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: webcrypto.subtle }); });
function item(id: string, status: OutgoingMessage['status'] = 'dismissed'): OutgoingMessage {
 return { id, identity:'session-v2:test', text:`text ${id}`, payload:`payload ${id}`, createdAt:1, status, baseline:new Set(), ...(status === 'delivered' ? { evidence:'correlated-v1' as const } : {}) };
}
it('verifies downloaded bytes before archiving only resolved records and suppressing old receipts', async () => {
 const dismissed = item('d'), delivered = item('ok','delivered'), pending = item('pending','unconfirmed');
 expect(await persistDeliveries([dismissed, delivered, pending])).toBe(true);
 const archive = await prepareDeliveryArchive(); expect(archive.count).toBe(2); expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
 const edited = archive.bytes.slice(); edited[0] ^= 1;
 await expect(compactDeliveryArchive(archive, edited)).rejects.toThrow(/no coincide/);
 expect((await restoreDeliveries()).filter(x => x.archived)).toHaveLength(0);
 expect(await compactDeliveryArchive(archive, archive.bytes.slice())).toBe(2);
 const restored = await restoreDeliveries();
 expect(restored.find(x => x.id === 'pending')).toMatchObject({ status:'unconfirmed', payload:'payload pending' });
 expect(restored.filter(x => x.archived)).toHaveLength(2);
 expect(reconcileDeliveries(restored, {messages:[], deliveries:[{id:'d', status:'queued', deliverAs:'steer', acceptedAt:new Date(1).toISOString()}]}, dismissed.identity).find(x => x.id === 'd')?.status).toBe('dismissed');
 expect(await persistDeliveries([{...dismissed, status:'unconfirmed'}])).toBe(false);
});
it('does not delete any record when a reviewed record changes concurrently', async () => {
 const first = item('a'), second = item('b'); await persistDeliveries([first,second]);
 const archive = await prepareDeliveryArchive();
 expect(await persistDeliveries([{...second, text:'updated'}])).toBe(true);
 await expect(compactDeliveryArchive(archive, archive.bytes.slice())).rejects.toThrow(/cambió/);
 const restored = await restoreDeliveries(); expect(restored.filter(x => x.archived)).toHaveLength(0); expect(restored).toHaveLength(2);
});
it('leaves legacy records intact because an older view may still write them', async () => {
 const legacy = item('old'); localStorage.setItem('gentle-dot:session-outbox:v1', JSON.stringify([{...legacy, baseline:[]}]));
 const original = await restoreDeliveries(); expect(original).toHaveLength(1);
 await expect(prepareDeliveryArchive()).rejects.toThrow(/heredados se conservan/);
 const result = await restoreDeliveries(); expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id:'old', text:'text old', status:'dismissed' });
 const changed = JSON.stringify([{...legacy, text:'stale old view', baseline:[]}]);
 localStorage.setItem('gentle-dot:session-outbox:v1', changed);
 expect((await restoreDeliveries())[0]?.archived).toBeUndefined();
 expect(localStorage.getItem('gentle-dot:session-outbox:v1')).toBe(changed);
});
it('rolls back both stores if writing a suppression marker fails', async () => {
 await persistDeliveries([item('one'),item('two')]); const archive = await prepareDeliveryArchive();
 const original = IDBObjectStore.prototype.put;
 const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
  if (this.name === 'archived') throw new Error('quota');
  return original.apply(this, args);
 });
 try { await expect(compactDeliveryArchive(archive, archive.bytes.slice())).rejects.toThrow(/quota/); }
 finally { spy.mockRestore(); }
 const restored = await restoreDeliveries(); expect(restored).toHaveLength(2); expect(restored.filter(x => x.archived)).toHaveLength(0);
});
it('an older IndexedDB opener cannot write after the archive schema upgrade', async () => {
 await persistDeliveries([item('one')]);
 const archive = await prepareDeliveryArchive(); await compactDeliveryArchive(archive, archive.bytes.slice());
 const error = await new Promise<DOMException | null>(resolve => {
  const request = indexedDB.open('gentle-dot:session-outbox:v2', 1);
  request.onerror = () => resolve(request.error);
  request.onsuccess = () => { request.result.close(); resolve(null); };
 });
 expect(error?.name).toBe('VersionError');
 expect((await restoreDeliveries())[0]).toMatchObject({id:'one', status:'dismissed', archived:true});
});
