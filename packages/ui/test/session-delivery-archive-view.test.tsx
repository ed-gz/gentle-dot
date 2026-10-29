import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { OrchestrationPanel } from '../src/components/OrchestrationPanel.tsx';
import * as store from '../src/session-delivery.ts';
import type { OrchestrationClient, OrchestrationSnapshot } from '../src/orchestration.ts';
import type { OrchestrationControls } from '../src/useOrchestration.ts';

async function renderStorageFailure(exportDeliveryArchive: (bytes: Uint8Array, sha256: string) => Promise<boolean>, includePending = false) {
 localStorage.clear();
 const identity = store.sessionDeliveryIdentity('', 'pane', 'session');
 await store.persistDeliveries([{id:'resolved',identity,text:'done',payload:'',createdAt:1,status:'dismissed',baseline:new Set()},
  ...(includePending ? [{id:'pending',identity,text:'pendiente offline',payload:'pendiente offline',createdAt:2,status:'unconfirmed' as const,baseline:new Set<string>()}] : [])]);
 vi.spyOn(store, 'persistDeliveries').mockResolvedValue(false);
 const snapshot: OrchestrationSnapshot = {available:true, approvals:[], policies:[], events:[], sessions:[{paneId:'pane',sessionId:'session',terminalId:'term',workspaceId:'work',label:'Proyecto',state:'working',connected:true,managed:true,capabilities:{inspect:true,prompt:true,abort:true,approvals:true,deliveryReceipts:true,deliveryModes:['steer','followUp']}}]};
 const controls: OrchestrationControls = {snapshot,busy:false,refresh:vi.fn(),act:vi.fn(async () => true)};
 const client: OrchestrationClient = {snapshot:vi.fn(),act:vi.fn(),inspect:vi.fn(async () => ({sessionId:'session',status:'working',messages:[],question:null,
  deliveries:[{id:'resolved',status:'queued' as const,deliverAs:'steer' as const,acceptedAt:new Date(1).toISOString(),preview:'recibo antiguo'}]}))};
 render(<OrchestrationPanel client={client} controls={controls} capriMobile mobile exportDeliveryArchive={exportDeliveryArchive} hashDeliveryArchive={async () => 'a'.repeat(64)} />);
 await userEvent.click(screen.getByRole('button',{name:'Proyecto · Trabajando'}));
 const composer = await screen.findByLabelText('Continuar esta sesión'); await waitFor(() => expect(composer).toBeEnabled());
 fireEvent.change(composer,{target:{value:'hello'}}); fireEvent.click(screen.getByRole('button',{name:'Enviar instrucción'}));
 await screen.findByText(/No se pudieron leer o guardar los envíos/);
 fireEvent.click(screen.getByText('Guardar y liberar registros resueltos'));
 return controls;
}
it('native export cancellation leaves storage intact and cannot start compaction', async () => {
 try {
  const exporter = vi.fn(async () => false); await renderStorageFailure(exporter);
  fireEvent.click(screen.getByRole('button',{name:'Descargar copia'}));
  expect(await screen.findByText(/Guardado cancelado/)).toBeVisible();
  expect(screen.queryByLabelText('Comprobar copia y liberar espacio')).toBeNull();
  expect((await store.restoreDeliveries()).some(item => item.archived)).toBe(false);
 } finally { vi.restoreAllMocks(); }
});
it('keeps archive review through session navigation while suppressing late receipts and retaining pending work', async () => {
 try {
  let exported!: Uint8Array; await renderStorageFailure(async bytes => { exported = bytes.slice(); return true; }, true);
  expect(await screen.findByText('pendiente offline')).toBeVisible();
  expect(screen.queryByText('recibo antiguo')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Descargar copia'}));
  await screen.findByLabelText('Comprobar copia y liberar espacio');
  fireEvent.click(screen.getByRole('button',{name:'Todos los agentes'}));
  fireEvent.click(screen.getByText('Guardar y liberar registros resueltos'));
  const picker = await screen.findByLabelText('Comprobar copia y liberar espacio');
  const file = new File([exported as BlobPart], 'correct.json', {type:'application/json'});
  Object.defineProperty(file,'arrayBuffer',{value:async () => exported.slice().buffer});
  fireEvent.change(picker,{target:{files:[file]}});
  expect(await screen.findByText(/registros resueltos archivados en la copia verificada/)).toBeVisible();
  await userEvent.click(screen.getByRole('button',{name:'Proyecto · Trabajando'}));
  expect(await screen.findByText('pendiente offline')).toBeVisible();
  expect(screen.queryByText('recibo antiguo')).toBeNull();
  expect((await store.restoreDeliveries()).find(item => item.id === 'pending')).toMatchObject({status:'unconfirmed',payload:'pendiente offline'});
 } finally { vi.restoreAllMocks(); }
});
it('rejects excessive selected file before reading; verified bytes compact resolved records', async () => {
 try {
  let exported!: Uint8Array; const exporter = vi.fn(async (bytes: Uint8Array) => {exported = bytes.slice(); return true;}); await renderStorageFailure(exporter);
  fireEvent.click(screen.getByRole('button',{name:'Descargar copia'}));
  const picker = await screen.findByLabelText('Comprobar copia y liberar espacio');
  const huge = new File(['x'.repeat(exported.length + 1)], 'large.json', {type:'application/json'}); const read = vi.fn(); Object.defineProperty(huge,'arrayBuffer',{value:read});
  fireEvent.change(picker,{target:{files:[huge]}}); expect(await screen.findByText(/tamaño del archivo no coincide/)).toBeVisible(); expect(read).not.toHaveBeenCalled();
  expect((await store.restoreDeliveries()).some(item => item.archived)).toBe(false);
  const correct = new File([exported as BlobPart], 'correct.json', {type:'application/json'}); Object.defineProperty(correct,'arrayBuffer',{value:async () => exported.slice().buffer});
  fireEvent.change(picker,{target:{files:[correct]}}); expect(await screen.findByText(/registros resueltos archivados en la copia verificada/)).toBeVisible();
  expect((await store.restoreDeliveries()).find(item => item.id === 'resolved')?.archived).toBe(true);
 } finally { vi.restoreAllMocks(); }
});
