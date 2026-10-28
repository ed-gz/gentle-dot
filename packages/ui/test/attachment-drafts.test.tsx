import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAttachments, type AttachmentDraftStore } from '../src/useAttachments.ts';
import type { Uploader } from '../src/uploads.ts';

const file = (name: string) => new File(['original'], name, { type: 'text/plain' });
const uploader = () => vi.fn<Uploader>(async file => ({ uploadId: 'u_fixture123', name: file.name, size: file.size, mime: file.type, path: `uploads/u_fixture123/${file.name}` }));

it('blocks uploading until restoration and the actual save promise settle; restored files require a new upload', async () => {
  const restore = Promise.withResolvers<File[]>();
  const save = Promise.withResolvers<void>();
  const store: AttachmentDraftStore = { load: () => restore.promise, save: vi.fn(() => save.promise) };
  const upload = uploader();
  const { result } = renderHook(() => useAttachments(upload, store));
  expect(result.current?.saving).toBe(true);
  expect(await result.current!.upload()).toBeUndefined();
  await act(async () => { restore.resolve([file('restored.txt')]); });
  expect(result.current?.files.map(item => item.file.name)).toEqual(['restored.txt']);
  expect(result.current?.storageNote).toContain('Revisa el historial');
  expect(upload).not.toHaveBeenCalled();
  act(() => result.current!.add([file('new.txt')]));
  expect(store.save).toHaveBeenCalledWith([expect.objectContaining({ name: 'restored.txt' }), expect.objectContaining({ name: 'new.txt' })]);
  expect(result.current?.saving).toBe(true);
  expect(await result.current!.upload()).toBeUndefined();
  await act(async () => { save.resolve(); });
  expect(result.current?.saving).toBe(false);
  await act(async () => { expect(await result.current!.upload()).toHaveLength(2); });
  expect(upload).toHaveBeenCalledTimes(2);
  expect(store.save).toHaveBeenCalledTimes(1); // Progress and host receipts are never persisted as draft files.
});

it('keeps files and refuses upload after a storage failure; explicit retry can save them and removal persists', async () => {
  const save = vi.fn<AttachmentDraftStore['save']>().mockRejectedValueOnce(new Error('Sin espacio')).mockResolvedValue(undefined);
  const store = { load: async () => [], save };
  const upload = uploader();
  const { result } = renderHook(() => useAttachments(upload, store));
  await waitFor(() => expect(result.current?.saving).toBe(false));
  await act(async () => result.current!.add([file('kept.txt')]));
  expect(result.current?.storageError).toBe('Sin espacio');
  expect(result.current?.files[0]?.file.name).toBe('kept.txt');
  expect(await result.current!.upload()).toBeUndefined();
  expect(upload).not.toHaveBeenCalled();
  await act(async () => result.current!.retrySave!());
  expect(result.current?.storageError).toBe('');
  expect(result.current?.storageNote).toContain('guardados');
  await act(async () => result.current!.remove(result.current!.files[0]!.id));
  expect(save).toHaveBeenLastCalledWith([]);
  expect(result.current?.files).toEqual([]);
});

it('late restoration for the old store cannot replace files belonging to a different owner', async () => {
  const late = Promise.withResolvers<File[]>();
  const oldStore: AttachmentDraftStore = { load: () => late.promise, save: vi.fn(async () => {}) };
  const newStore: AttachmentDraftStore = { load: async () => [file('new-owner.txt')], save: vi.fn(async () => {}) };
  const upload = uploader();
  const { result, rerender } = renderHook(({ store }) => useAttachments(upload, store), { initialProps: { store: oldStore } });
  rerender({ store: newStore });
  await waitFor(() => expect(result.current?.files[0]?.file.name).toBe('new-owner.txt'));
  await act(async () => { late.resolve([file('wrong-owner.txt')]); });
  expect(result.current?.files.map(item => item.file.name)).toEqual(['new-owner.txt']);
  expect(newStore.save).not.toHaveBeenCalled();
});

it('a restoration error can retry without silently replacing the unread saved draft', async () => {
  const load = vi.fn<AttachmentDraftStore['load']>().mockRejectedValueOnce(new Error('Almacenamiento ocupado')).mockResolvedValue([file('saved.txt')]);
  const store = { load, save: vi.fn(async () => {}) };
  const upload = uploader();
  const { result } = renderHook(() => useAttachments(upload, store));
  await waitFor(() => expect(result.current?.storageError).toBe('Almacenamiento ocupado'));
  act(() => result.current!.add([file('must-not-overwrite.txt')]));
  expect(store.save).not.toHaveBeenCalled();
  await act(async () => result.current!.retrySave!());
  expect(result.current?.files[0]?.file.name).toBe('saved.txt');
  expect(result.current?.storageError).toBe('');
});
