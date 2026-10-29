import type { AttachmentRef } from "@gentle-dot/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { OrchestrationClient } from "../orchestration.ts";
import { useAttachments, type AttachmentDraftStore } from "../useAttachments.ts";
import { AgentVoiceContext, useAgentVoice } from "../useAgentVoice.ts";
import { Composer } from "./Composer.tsx";
import "../agent-attachments.css";
import type { VoiceControls } from "../useVoice.ts";

/** Platforms can supply their own transcriber without initializing desktop capture. */
export const AgentVoiceOverrideContext = createContext<VoiceControls | undefined>(undefined);
/** Optional platform storage; never includes credentials or uploaded host references. */
export const AgentAttachmentDraftContext = createContext<((paneId: string, sessionId: string) => AttachmentDraftStore) | undefined>(undefined);

/** Files belong to client + pane + session; availability only cancels capture/pre-dispatch work. */
interface AgentAttachmentsProps {
 client: OrchestrationClient;
 paneId: string;
 sessionId: string;
 text: string;
 onText(text: string): void;
 onSend(text: string, refs?: AttachmentRef[]): Promise<boolean>;
 disabled: boolean;
 busy?: boolean;
 images: boolean;
 filesEnabled?: boolean;
 capriMobile?: boolean;
}
export function AgentAttachments(props: AgentAttachmentsProps) {
 const voice = useContext(AgentVoiceOverrideContext);
 return voice ? <AgentAttachmentsBody {...props} voice={voice} /> : <DesktopAgentAttachments {...props} />;
}
function DesktopAgentAttachments(props: AgentAttachmentsProps) {
 const voice = useAgentVoice(!props.disabled && !props.busy);
 return <AgentAttachmentsBody {...props} voice={voice} />;
}
function AgentAttachmentsBody(props: AgentAttachmentsProps & { voice: VoiceControls }) {
 const { client, paneId, sessionId, text, onText, onSend, disabled, busy = false, filesEnabled = true } = props;
 const context = useContext(AgentVoiceContext);
 const disconnected = disabled || Boolean(context && context.state.connection !== "open");
 const controller = useRef(new AbortController());
 const mounted = useRef(true);
 const unavailable = useRef(disconnected);
 unavailable.current = disconnected;
 const [pending, setPending] = useState(false);
 const uploader = useMemo(() => filesEnabled && client.uploadAttachment
  ? (file: File, options: { uploadId?: string }) => client.uploadAttachment!(paneId, sessionId, file, options.uploadId, controller.current.signal)
  : undefined, [client, paneId, sessionId, filesEnabled]);
 const draftFactory = useContext(AgentAttachmentDraftContext);
 const draftStore = useMemo(() => filesEnabled ? draftFactory?.(paneId, sessionId) : undefined, [draftFactory, paneId, sessionId, filesEnabled]);
 const attachments = useAttachments(uploader, draftStore);
 const voice = props.voice;
 useEffect(() => () => voice.cancel(), [client, paneId, sessionId, voice.cancel]);
 const guardedAttachments = attachments ? { ...attachments, upload: async () => {
  if (controller.current.signal.aborted && !attachments.uploading) controller.current = new AbortController();
  const signal = controller.current.signal;
  const refs = await attachments.upload();
  return mounted.current && !signal.aborted && !unavailable.current ? refs : undefined;
 } } : undefined;
 useEffect(() => {
  mounted.current = true;
  if (controller.current.signal.aborted) controller.current = new AbortController();
  return () => { mounted.current = false; controller.current.abort(); };
 }, [client, paneId, sessionId]);
 useEffect(() => { if (disconnected) controller.current.abort(); }, [disconnected]);
 return <div className="agent-reply agent-attachments">
  <Composer mobile inputOnly capriMobile={props.capriMobile} busy={false} disabled={disconnected || busy || Boolean(attachments?.storageError)} send={() => false}
   text={text} onText={onText} attachments={guardedAttachments} voice={voice}
   labels={{ text: "Continuar esta sesión", send: "Enviar instrucción", files: "Archivos para esta sesión", remove: "Quitar" }}
   onSubmitText={async (value, refs) => {
    if (!mounted.current || unavailable.current || busy) return false;
    // Composer skips upload for a fresh no-file attempt. Renew only that lifetime;
    // file pipelines keep their captured signal and cannot revive cancelled work.
    if (refs === undefined && !attachments?.files.length && !attachments?.uploading && controller.current.signal.aborted) {
     controller.current = new AbortController();
    }
    const signal = controller.current.signal;
    if (signal.aborted) return false;
    setPending(true);
    try {
     const accepted = await onSend(value, refs);
     // Once dispatched, hiding/disconnecting cannot retract a matching acceptance.
     // Clear consumed refs for this mounted owner, never make them ready to resend.
     return accepted && mounted.current;
    } finally { if (mounted.current) setPending(false); }
   }} />
  {attachments?.storageNote ? <p className="voice-status" role="status">{attachments.storageNote}</p> : null}
  {attachments?.storageError ? <p className="voice-status" role="alert">{attachments.storageError} <button type="button" disabled={attachments.saving} onClick={attachments.retrySave}>Reintentar guardado</button></p> : null}
  {attachments?.uploading && !pending ? <button type="button" aria-label="Cancelar subida" onClick={() => {
   controller.current.abort(); if (!draftStore) attachments.clear();
  }}>×</button> : null}
 </div>;
}
