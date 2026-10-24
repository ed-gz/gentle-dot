// Isolated native-frontend fixture. Never imports the real daemon, sessions or user settings.
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {WebSocketServer} from '../../../../packages/daemon/node_modules/ws/wrapper.mjs';
const port=Number(process.argv[2]);
let server, sockets, round=0;
async function stop() {
  if (!server) return;
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  await new Promise(resolve=>server.close(resolve));
  server=undefined;
}
async function start() {
  if (server) return;
  round++;
  server=createServer((request,response)=>{
    response.setHeader('Access-Control-Allow-Origin','*');
    response.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    if(request.method==='OPTIONS') {response.writeHead(204);response.end();return;}
    response.setHeader('Content-Type','application/json');
    if(request.url==='/api/mobile/companion') response.end(JSON.stringify({mode:'gentle'}));
    else {response.writeHead(404);response.end('{}');}
  });
  sockets=new WebSocketServer({server,path:'/ws'});
  sockets.on('connection',socket=>socket.on('message',raw=>{
    const message=JSON.parse(String(raw));
    if(message.type==='hello') socket.send(JSON.stringify({type:'ready',agentState:'idle',seq:1,clientId:'native-fixture'}));
    if(message.type==='get_history') socket.send(JSON.stringify({type:'history',seq:2,messages:[{id:`fixture-${round}`,role:'assistant',text:`Native fixture round ${round}`}]}));
    if(message.type==='list_conversations') socket.send(JSON.stringify({type:'conversations',seq:3,conversations:[]}));
    if(message.type==='auth_list') socket.send(JSON.stringify({type:'auth_providers',seq:4,providers:[]}));
  }));
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
}
let queue=Promise.resolve();
createInterface({input:process.stdin}).on('line',line=>{
  queue=queue.then(async()=>{if(line==='start')await start();else if(line==='stop')await stop();else if(line==='exit'){await stop();process.exit(0);}}).catch(()=>process.exit(1));
});
process.stdin.on('end',()=>void stop().then(()=>process.exit(0)));
