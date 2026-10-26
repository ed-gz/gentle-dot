import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { RestProgression, type RestPose } from "./choreography.ts";

export interface MotionCue { mode: "walk" | "teleport" | "fall" | "land" | "rest"; direction: number; duration: number }
/** Native events, not pointer polling. The only idle timer is the next rest checkpoint. */
export function useChoreography(enabled: boolean, active: boolean, identity?: string) {
 const [rest, setRest] = useState<RestPose>("float");
 const [absent, setAbsent] = useState(false);
 const [motion, setMotion] = useState<MotionCue>();
 const progression = useRef<RestProgression | undefined>(undefined);
 const activity = useRef(active); activity.current = active;
 const lastAbsence = useRef<boolean | undefined>(undefined);
 useEffect(() => {
  if (!enabled) return;
  setAbsent(false); lastAbsence.current = undefined;
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
   const unabsence = await listen<boolean>("dot://capri3d-absence", ({ payload }) => {
    if (!live || typeof payload !== "boolean" || lastAbsence.current === payload) return;
    lastAbsence.current = payload;
    setAbsent(payload);
    const machine = progression.current;
    machine?.absent(payload);
    if (!payload && machine) { if (activity.current) machine.cue(); else machine.idle(); }
   });
   const cleanup = () => { unlisten(); unabsence(); };
   if (live) stop = cleanup; else cleanup();
  }).catch(() => {});
  return () => { live = false; stop?.(); };
 }, [enabled]);
 useEffect(() => {
  if (motion?.mode !== "land") return;
  const timer = setTimeout(() => setMotion(undefined), motion.duration);
  return () => clearTimeout(timer);
 }, [motion]);
 return { rest, motion, absent };
}
