#!/usr/bin/env node
// Provisions private build CODE and a private binary release asset. Never dispatches CI.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePersonalPNG, downloadPrivateArtwork } from './personal-art.mjs';

function require(condition, message) { if (!condition) throw new Error(message); }
function api(path, payload) {
  const args = ['api', path, ...(payload ? ['--method', 'PUT', '--input', '-'] : [])];
  const result = spawnSync('gh', args, { input: payload ? JSON.stringify(payload) : undefined, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    if (!payload && /\b404\b/.test(result.stderr)) return undefined;
    throw new Error('GitHub private repository operation failed.');
  }
  return JSON.parse(result.stdout);
}
try {
  const [repository, png, sha256] = process.argv.slice(2);
  require(process.argv.length === 5 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Usage: prepare-personal-build.mjs OWNER/PRIVATE_REPO PNG SHA256');
  require(statSync(png).size <= 5 * 1024 * 1024, 'Personal PNG exceeds 5 MiB.');
  validatePersonalPNG(readFileSync(png), sha256);
  let repo = api(`repos/${repository}`);
  if (!repo) {
    execFileSync('gh', ['repo', 'create', repository, '--private', '--add-readme', '--description', 'Private personal Capri iOS builds. Artwork is a release asset, never Git source.'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    repo = api(`repos/${repository}`);
  }
  require(repo?.private === true && repo.full_name.toLowerCase() === repository.toLowerCase(), 'Refusing to provision artwork outside a private repository.');
  const workflow = readFileSync(new URL('../../../.github/workflows/ios-personal.yml', import.meta.url));
  const workflowPath = `repos/${repository}/contents/.github/workflows/ios-personal.yml`;
  const existing = api(workflowPath);
  if (!existing || Buffer.from(existing.content.replace(/\s/g, ''), 'base64').compare(workflow) !== 0) {
    api(workflowPath, { message: 'build: install pinned private Capri workflow', content: workflow.toString('base64'), ...(existing ? { sha: existing.sha } : {}) });
  }
  const verified = api(workflowPath);
  require(verified && Buffer.from(verified.content.replace(/\s/g, ''), 'base64').equals(workflow), 'Private workflow verification failed.');
  const tag = `capri-art-${sha256}`;
  let release = api(`repos/${repository}/releases/tags/${tag}`);
  if (!release) {
    execFileSync('gh', ['release', 'create', tag, '--repo', repository, '--target', repo.default_branch, '--title', 'Personal Capri 2D artwork', '--notes', `Original 240×420 rig PNG. SHA-256: ${sha256}. Kept outside Git history.`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    release = api(`repos/${repository}/releases/tags/${tag}`);
  }
  require(release && Array.isArray(release.assets), 'Private release verification failed.');
  if (!release.assets.some(asset => asset.name === 'capri-full.png')) {
    require(resolve(png).endsWith('/capri-full.png'), 'Expected the original capri-full.png filename.');
    execFileSync('gh', ['release', 'upload', tag, resolve(png), '--repo', repository], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    release = api(`repos/${repository}/releases/tags/${tag}`);
  }
  const assets = release.assets.filter(asset => asset.name === 'capri-full.png');
  require(assets.length === 1, 'Expected one original personal release asset.');
  // Re-download under the same private API and hash contract used in Actions.
  downloadPrivateArtwork(repository, String(assets[0].id), sha256);
  console.log(JSON.stringify({ repository, private: true, workflow: 'ios-personal.yml', artwork_asset_id: String(assets[0].id), artwork_sha256: sha256, dispatched: false }));
} catch (error) {
  console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Private Capri provisioning failed.');
  process.exitCode = 1;
}
