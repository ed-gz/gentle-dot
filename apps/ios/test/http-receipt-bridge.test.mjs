import assert from 'node:assert/strict';
import {test} from 'node:test';
import {httpsReceiptState,httpsReceiptCancelBeforeStart} from '../src/device-bridge.ts';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('receipt lookup and pre-start tombstone use only exact UUID identity',async()=>{
 const calls=[];const call=async(command,input)=>{calls.push({command,input});return {ok:true,receiptState:command==='https_receipt_state'?'active':'cancelledBeforeStart'};};
 assert.equal(await httpsReceiptState(id,owner,call),'active');await httpsReceiptCancelBeforeStart(id,owner,call);
 assert.deepEqual(calls,[{command:'https_receipt_state',input:{id,owner}},{command:'https_receipt_cancel_before_start',input:{id,owner}}]);
 await assert.rejects(httpsReceiptState(id.toUpperCase(),owner,call),/inválida/);assert.equal(calls.length,2);
});
test('invalid or rejected native receipts cannot be treated as evidence',async()=>{
 await assert.rejects(httpsReceiptState(id,owner,async()=>({ok:true,receiptState:'delivered'})),/inválido/);
 await assert.rejects(httpsReceiptCancelBeforeStart(id,owner,async()=>({ok:true,receiptState:'terminal'})),/no quedó confirmada/);
 await assert.rejects(httpsReceiptState(id,owner,async()=>({ok:false,error:'storage'})));
});
