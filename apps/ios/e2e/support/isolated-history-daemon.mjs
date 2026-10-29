// Test-only daemon with synthetic Pi data and an ephemeral local TLS tunnel.
// Its parent supplies a disposable HOME and receives the generated token over IPC.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../../../../packages/daemon/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { startDaemon } from '../../../../packages/daemon/src/daemon.ts';
import { fakeAuthRuntime } from '../../../../packages/daemon/test/fake-auth-runtime.ts';

const dataDir = process.env.CAPRI_FIXTURE_DIR;
if (!dataDir || !process.send) throw new Error('This fixture requires an isolated directory and IPC.');
const sessions = join(dataDir, 'sessions'), agentHome = join(dataDir, 'agent');
mkdirSync(sessions); mkdirSync(agentHome);
const session = SessionManager.create(dataDir, sessions);
const root = session.appendMessage({ role: 'user', content: 'Mensaje raíz sintético', timestamp: 1 });
session.appendMessage({ role: 'user', content: 'Rama abandonada sintética', timestamp: 2 });
session.branch(root);
session.appendMessage({ role: 'user', content: 'Mensaje actual sintético', timestamp: 3 });
const executable = fileURLToPath(new URL('../../../../packages/daemon/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url));
const key = join(dataDir, 'fixture-key.pem'), cert = join(dataDir, 'fixture-cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const daemon = await startDaemon({
  port: 0, host: '127.0.0.1', dataDir, workspace: dataDir, uiDir: dataDir, historyPage: 1, conversations: false,
  allowedOrigins: [process.env.CAPRI_FIXTURE_ORIGIN], agentCommand: process.execPath, agentArgs: [executable],
  agentEnv: { PATH: process.env.PATH, HOME: dataDir, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: '1' },
  agentExtraArgs: ['--session', session.getSessionFile(), '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools'],
  authRuntime: async () => fakeAuthRuntime().runtime,
});
const sockets = new Set();
const tunnel = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  const upstream = createConnection({ host: '127.0.0.1', port: daemon.port });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  socket.pipe(upstream).pipe(socket);
});
await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve));
process.send({ url: `wss://127.0.0.1:${tunnel.address().port}/ws`, token: daemon.token });
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => tunnel.close(resolve)); await daemon.close(); process.exit(0);
}
process.on('message', message => { if (message === 'close') void shutdown(); });
process.on('disconnect', () => { void shutdown(); });
