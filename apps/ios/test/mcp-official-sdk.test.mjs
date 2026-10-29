import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { discoverMCPTools } from '../src/remote-mcp.ts';

const root = process.env.CAPRI_MCP_OFFICIAL_ROOT;
test('official MCP SDK v2 modern-only server preserves approval and journal', { skip: !root && 'run scripts/check-official-mcp-sdk.sh' }, async () => {
  const require = createRequire(`${root}/package.json`);
  assert.equal(JSON.parse(readFileSync(`${root}/node_modules/@modelcontextprotocol/server/package.json`, 'utf8')).version, '2.4.0');
  const { createMcpHandler, McpServer } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/server')).href);
  const z = await import(pathToFileURL(require.resolve('zod')).href);
  const id = 'e5e3f759-62cb-44e7-a1bd-4912012aa961';
  const connection = { id, kind:'mcp', label:'SDK fixture', endpoint:'https://fixture.example/mcp', revision:1, enabled:true, createdAt:1, updatedAt:1 };
  let executions = 0; const methods = [], journal = [], requests = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({name:'fixture', version:'1'});
    server.registerTool('echo', {description:'echo', inputSchema:z.object({text:z.string().meta({'x-mcp-header':'Text'})})}, async ({text}) => {
      executions++; return {content:[{type:'text',text}]};
    });
    return server;
  }, { legacy:'reject' });
  const [tool] = await discoverMCPTools(id, {
    prepare:async()=>connection, getConnection:async()=>connection, token:async()=>null,
    hash:async text=>createHash('sha256').update(text).digest('hex'), begin:async entry=>journal.push(entry),
    finish:async (requestId,state)=>{journal.find(entry=>entry.requestId===requestId).state=state;},
    request:async request=>{
      const rpc = JSON.parse(request.body); methods.push(rpc.method); requests.push(request);
      const response = await handler.fetch(new Request(request.url,{method:request.method,headers:request.headers,body:request.body}));
      return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()};
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await tool.execute({text:'synthetic'}, {signal,askApproval:async()=>false}), {executed:false,approved:false});
  assert.equal(executions,0); assert.equal(journal.length,0);
  let review;
  const result = await tool.execute({text:'México'}, {signal,askApproval:async value => { review=JSON.parse(value.details); return true; }});
  assert.equal(result.confirmed,true); assert.equal(executions,1); assert.equal(journal[0].state,'succeeded');
  assert.equal(requests.at(-1).headers['Mcp-Param-Text'], '=?base64?TcOpeGljbw==?=');
  assert.equal(review.parameterHeaders['Mcp-Param-Text'],requests.at(-1).headers['Mcp-Param-Text']);
  assert.deepEqual(methods,['initialize','server/discover','tools/list','tools/list','tools/call']);
});
