export const ASSET_NAMES = [
 "roja.glb", "roja_baile.glb", "roja_brazos.glb", "roja_flotando.glb", "roja_guino.glb",
 "roja_inclinada.glb", "roja_recostada_abiertos.glb", "roja_recostada_cerrados.glb",
 "roja_sentada.glb", "roja_transformacion.glb",
] as const;
export type AssetName = typeof ASSET_NAMES[number];
export function assetName(name: string): name is AssetName {
 return (ASSET_NAMES as readonly string[]).includes(name);
}
export type AssetReader = (name: AssetName) => Promise<ArrayBuffer>;
export async function loadBaseAsset(read: AssetReader): Promise<ArrayBuffer | null> {
 try { return await read("roja.glb"); } catch { return null; }
}
