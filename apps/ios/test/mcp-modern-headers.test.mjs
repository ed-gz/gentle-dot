import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modernMCPParameterHeaders } from '../src/mcp-modern-headers.ts';
import { modernMCPRequest, validateModernHTTPHeaders } from '../src/mcp-modern-protocol.ts';

const schema = { type:'object', properties:{
  region:{type:'string','x-mcp-header':'Region'}, nested:{type:'object',properties:{
    greeting:{type:'string','x-mcp-header':'Greeting'}, enabled:{type:'boolean','x-mcp-header':'Enabled'}, number:{type:'integer','x-mcp-header':'Number'},
    optional:{type:['string','null'],'x-mcp-header':'Optional'},
  }},
} };
test('parameter headers mirror exact nested values with safe UTF-8 sentinel encoding', () => {
  const args = {region:'us-west1',nested:{greeting:'Hello, 世界',enabled:false,number:-7,optional:null}};
  const headers = modernMCPParameterHeaders(schema,args);
  assert.deepEqual(headers, {'Mcp-Param-Region':'us-west1','Mcp-Param-Greeting':'=?base64?SGVsbG8sIOS4lueVjA==?=',
    'Mcp-Param-Enabled':'false','Mcp-Param-Number':'-7'});
  const request = modernMCPRequest('1','tools/call',{name:'tool',arguments:args},headers);
  assert.equal(request.headers['Mcp-Param-Greeting'],headers['Mcp-Param-Greeting']);
  assert.deepEqual(JSON.parse(request.body).params.arguments,args);
});
test('whitespace, controls, empty strings and sentinel-looking text cannot inject HTTP fields', () => {
  for (const [value, expected] of [[' padded ','IHBhZGRlZCA='], ['line1\nline2','bGluZTEKbGluZTI='], ['', ''], ['=?base64?bad?=','PT9iYXNlNjQ/YmFkPz0=']]) {
    const headers = modernMCPParameterHeaders(schema,{region:value});
    assert.equal(headers['Mcp-Param-Region'],`=?base64?${expected}?=`);
  }
  assert.throws(() => modernMCPParameterHeaders(schema,{region:'\ud800'}));
});
test('annotations cannot escape prefix or use invalid placement, type, duplicate names or unsafe integers', () => {
  const bad = [
    {type:'object','x-mcp-header':'Host'},
    {type:'object',properties:{v:{type:'string','x-mcp-header':'Host\nAuthorization'}}},
    {type:'object',properties:{v:{type:'number','x-mcp-header':'Value'}}},
    {type:'object',properties:{v:{type:'array',items:{type:'string','x-mcp-header':'Value'}}}},
    {type:'object',properties:{v:{oneOf:[{type:'string','x-mcp-header':'Value'}]}}},
    {type:'object',$defs:{v:{type:'string','x-mcp-header':'Value'}}},
    {type:'object',properties:{v:{$ref:'#/$defs/a','x-mcp-header':'Value'}},$defs:{a:{type:'string'}}},
    {type:'object',properties:{a:{type:'string','x-mcp-header':'ID'},b:{type:'string','x-mcp-header':'id'}}},
  ];
  for (const value of bad) assert.throws(() => modernMCPParameterHeaders(value,{}));
  assert.throws(() => modernMCPParameterHeaders(schema,{nested:{number:2**53}}));
  assert.throws(() => modernMCPParameterHeaders(schema,{nested:{enabled:'true'}}));
  assert.deepEqual(modernMCPParameterHeaders({type:'object',properties:{v:{type:'string','x-mcp-header':'Authorization'}}},{v:'x'}), {'Mcp-Param-Authorization':'x'});
  for (const name of ['Authorization','Host','Cookie','Content-Length','Mcp-Method']) {
    assert.throws(() => modernMCPRequest('1','tools/call',{name:'tool',arguments:{}},{[name]:'evil'}));
  }
});
test('parameter count and aggregate headers respect native limits before dispatch', () => {
  const properties = Object.fromEntries(Array.from({length:25},(_,i) => [`p${i}`,{type:'string','x-mcp-header':`P${i}`} ]));
  assert.throws(() => modernMCPParameterHeaders({type:'object',properties},{}));
  assert.throws(() => modernMCPParameterHeaders(schema,{region:'x'.repeat(12001)}));
  assert.throws(() => validateModernHTTPHeaders({'Mcp-Param-A':'x'.repeat(16000),'Mcp-Param-B':'x'.repeat(16000),Authorization:'x'.repeat(1000)}));
});
