#!/usr/bin/env node
// The private icon is built from the same verified Capri artwork as the rig.
// It is generated only for personal builds and must not enter the repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPersonalArtwork } from './personal-art.mjs';

export function personalIconSVG(directory, sha256) {
  verifyPersonalArtwork(directory, sha256);
  const image = readFileSync(join(directory, 'capri-full.png')).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#281333"/><stop offset=".52" stop-color="#100d1c"/><stop offset="1" stop-color="#090e16"/></linearGradient><linearGradient id="pink" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ff5eae"/><stop offset="1" stop-color="#8f246b"/></linearGradient></defs>
<rect width="1024" height="1024" fill="url(#background)"/>
<path d="M0 144 432 0H634L0 218Z" fill="#fa4b9c" opacity=".2"/><path d="M1024 716 577 1024H453L1024 633Z" fill="#bbf85a" opacity=".12"/>
<path d="M114 392 114 178 329 107M909 632 909 846 694 917" fill="none" stroke="#e153a4" stroke-width="11" opacity=".68"/>
<circle cx="512" cy="474" r="318" fill="none" stroke="url(#pink)" stroke-width="5" opacity=".45"/>
<path d="M180 767h170M674 257h170" stroke="#c4fb67" stroke-width="9" opacity=".8"/>
<image x="277" y="94" width="470" height="823" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/png;base64,${image}"/>
</svg>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: personal-icon.mjs ART_DIRECTORY SHA256 OUTPUT.svg');
    writeFileSync(process.argv[4], personalIconSVG(process.argv[2], process.argv[3]), { mode: 0o600 });
    console.log('Personal Capri app icon generated from verified artwork.');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Could not generate the personal icon.'); process.exitCode = 1; }
}
