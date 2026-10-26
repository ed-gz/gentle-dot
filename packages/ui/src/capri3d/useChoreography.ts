import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { RestProgression, type RestPose } from "./choreography.ts";

export interface MotionCue { mode: "walk" | "teleport" | "fall" | "land" | "rest"; direction: number; duration: number }
/** Native events, not pointer polling. The only idle timer is the next rest checkpoint. */
export function useChoreography(enabled: boolean, active: boolean, identity?: string) {
 const [rest, setRest] = useState<RestPose>("float");
 const [motion, setMotion] = useState<MotionCue>();
 const progression = useRef<RestProgression | undefined>(undefined);
 useEffect(() => {
  if (!enabled) return;
  const machine = new RestProgression(setRest);
  progression.current = machine;
  machine.idle();
  return () => { machine.dispose(); progression.current = undefined; };
 }, [enabled]);
 useEffect(() => {
  const machine = progression.current;
  if (!machine) return;
  if (active) machine.cue(); else machine.idle();
 }, [enabled, active, identity]);
 useEffect(() => {
  if (!enabled || !isTauri()) return;
  let live = true, stop: (() => void) | undefined;
  void import("@tauri-apps/api/event").then(async ({ listen }) => {
   const unlisten = await listen<MotionCue>("dot://capri3d-motion", ({ payload }) => {
    if (!live || !["walk", "teleport", "fall", "land", "rest"].includes(payload.mode)) return;
    setMotion(payload);
   });
   if (live) stop = unlisten; else unlisten();
  }).catch(() => {});
  return () => { live = false; stop?.(); };
 }, [enabled]);
 useEffect(() => {
  if (motion?.mode !== "land") return;
  const timer = setTimeout(() => setMotion(undefined), motion.duration);
  return () => clearTimeout(timer);
 }, [motion]);
 return { rest, motion };
}
