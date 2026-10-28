import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPersonalArtwork } from './personal-art.mjs';

/** The private workflow's GITHUB_SHA identifies the companion repo, not the app. */
export function readBuildStamp(repositoryRoot, artworkDirectory, expectedSource = '') {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Cannot identify the Capri source commit.');
  if (expectedSource && (!/^[a-f0-9]{40}$/.test(expectedSource) || sourceCommit !== expectedSource)) throw new Error('Checked-out source does not match the requested personal build commit.');
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().length > 0;
  let artworkSHA256 = null;
  if (existsSync(join(artworkDirectory, 'manifest.json'))) {
    const claimed = JSON.parse(readFileSync(join(artworkDirectory, 'manifest.json'), 'utf8')).sha256;
    artworkSHA256 = verifyPersonalArtwork(artworkDirectory, claimed).sha256;
  }
  return { schemaVersion: 1, sourceCommit, dirty, artworkSHA256 };
}
