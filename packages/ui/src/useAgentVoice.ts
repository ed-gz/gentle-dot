import { createContext, useContext } from "react";
import type { Send } from "./components/types.ts";
import { initialState, type DotState } from "./store.ts";
import { useVoice } from "./useVoice.ts";

/** Only transcription uses Dot's connection. Never route a chat/abort/TTS action there. */
export const AgentVoiceContext = createContext<{ state: DotState; send: Send } | undefined>(undefined);
export function useAgentVoice(enabled: boolean) {
 const context = useContext(AgentVoiceContext);
 return useVoice(context?.state ?? initialState, message => {
  if (message.type === "voice_transcribe") return context?.send(message) ?? false;
  return false;
 }, { inputOnly: true, enabled: enabled && (!context || context.state.connection === "open") });
}
