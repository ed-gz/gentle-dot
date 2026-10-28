export type BuildInfo = Readonly<{ schemaVersion: 1; sourceCommit: string | null; dirty: boolean; artworkSHA256: string | null }>;
declare const __CAPRI_BUILD_INFO__: unknown;
export function parseBuildInfo(value: unknown): BuildInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({ schemaVersion: 1, sourceCommit: null, dirty: true, artworkSHA256: null });
  const item = value as Partial<BuildInfo>;
  if (item.schemaVersion !== 1 || typeof item.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(item.sourceCommit) ||
      typeof item.dirty !== 'boolean' || (item.artworkSHA256 !== null && (typeof item.artworkSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.artworkSHA256)))) return parseBuildInfo(null);
  return Object.freeze({ schemaVersion: 1, sourceCommit: item.sourceCommit, dirty: item.dirty, artworkSHA256: item.artworkSHA256 });
}
export const buildInfo = parseBuildInfo(typeof __CAPRI_BUILD_INFO__ === 'undefined' ? null : __CAPRI_BUILD_INFO__);
export function buildLabel(info: BuildInfo = buildInfo): string {
  if (!info.sourceCommit) return 'Capri · compilación sin identificar';
  return `Capri ${info.sourceCommit.slice(0, 8)} · ${info.artworkSHA256 ? 'personal' : 'sin arte incluido'}${info.dirty ? ' · cambios locales' : ''}`;
}
