import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { AssetReader } from "./assets.ts";

export const readLocalAsset: AssetReader = async name => {
 const bytes = await invoke<ArrayBuffer | number[]>("capri3d_asset", { name });
 return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
};
// Preserve order: a delayed mask must never reactivate the surface after unmount/fallback.
let publications = Promise.resolve();
export function publish3DSurface(active: boolean, mask?: number[]): Promise<void> {
 if (!isTauri()) return Promise.resolve();
 const publication = publications.then(async () => {
  await invoke("capri3d_surface", { active, mask: mask ?? null });
 });
 publications = publication.catch(() => {});
 return publication;
}
export function usePreferred3D(enabled: boolean): boolean {
 const [preferred, setPreferred] = useState(false);
 useEffect(() => {
  if (!enabled || !isTauri()) { setPreferred(false); return; }
  let live = true, revision = 0;
  let unlisten: (() => void) | undefined;
  void (async () => {
   const { listen } = await import("@tauri-apps/api/event");
   const stop = await listen<boolean>("dot://capri3d-form", event => {
    revision++;
    if (live) setPreferred(event.payload === true);
   });
   if (!live) { stop(); return; }
   unlisten = stop;
   const request = revision;
   const value = await invoke<boolean>("capri3d_surface");
   if (live && request === revision) setPreferred(value === true);
  })().catch(() => { if (live) setPreferred(false); });
  return () => { live = false; unlisten?.(); };
 }, [enabled]);
 return preferred;
}
