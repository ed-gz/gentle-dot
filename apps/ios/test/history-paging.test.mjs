import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPaging } from '../src/history-paging.ts';
const scope={epoch:1,host:'wss://host/ws',conversationId:'chat'};
test('pages require exact request, cursor, host, conversation and connection epoch',()=>{
 const p=createHistoryPaging();p.reset(scope,'current',true);
 const request=p.start(scope,'req-1');assert.equal(request.before,'current');assert.equal(p.start(scope,'req-2'),undefined);
 for(const response of [{before:'other',requestId:'req-1',conversationId:'chat'}, {before:'current',requestId:'old',conversationId:'chat'}, {before:'current',requestId:'req-1',conversationId:'other'}, {before:'current',conversationId:'chat'}]) assert.equal(p.accept(scope,response,'older',true),false);
 assert.equal(p.accept({...scope,epoch:2},{before:'current',requestId:'req-1',conversationId:'chat'},'older',true),false);
 assert.equal(p.accept({...scope,host:'wss://other/ws'},{before:'current',requestId:'req-1',conversationId:'chat'},'older',true),false);
 assert.equal(p.accept(scope,{before:'current',requestId:'req-1',conversationId:'chat'},'older',true),true);
 assert.equal(p.accept(scope,{before:'current',requestId:'req-1',conversationId:'chat'},'older',true),false);
 assert.equal(p.start(scope,'req-2').before,'older');
});
test('new snapshot and explicit failure fence late responses; retry gets fresh identity',()=>{
 const p=createHistoryPaging();p.reset(scope,'a',true);p.start(scope,'one');p.reset(scope,'b',true);
 assert.equal(p.accept(scope,{before:'a',requestId:'one',conversationId:'chat'},'old',true),false);
 p.start(scope,'two');assert.equal(p.fail(scope,'one'),false);assert.equal(p.fail(scope,'two'),true);
 p.start(scope,'three');assert.equal(p.accept(scope,{before:'b',requestId:'two',conversationId:'chat'},'old',true),false);
 assert.equal(p.accept(scope,{before:'b',requestId:'three',conversationId:'chat'},undefined,false),true);assert.equal(p.available(),false);
});
test('server cannot claim another page without advancing cursor',()=>{
 const p=createHistoryPaging();p.reset(scope,'a',true);p.start(scope,'one');
 assert.equal(p.accept(scope,{before:'a',requestId:'one',conversationId:'chat'},'a',true),false);assert.equal(p.busy(),true);
});
