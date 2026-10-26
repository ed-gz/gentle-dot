import manifest from './assets/capri-faces-v1.json' with { type: 'json' };

/** One offline atlas for every phone action. Unknown poses fail safely to face idle. */
export const CAPRI_FACES = manifest;
export type FaceAnimation = keyof typeof manifest.animations;
export function faceAnimation(action: string): FaceAnimation {
 return Object.hasOwn(manifest.animations, action) ? action as FaceAnimation : 'idle';
}
