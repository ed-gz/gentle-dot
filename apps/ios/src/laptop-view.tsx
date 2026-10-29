import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OrchestrationPanel } from '@gentle-dot/ui/src/components/OrchestrationPanel.tsx';
import { useOrchestration } from '@gentle-dot/ui/src/useOrchestration.ts';
import { createLaptopClient } from './laptop-client.ts';
import type { DesktopConnection } from './desktop-tools.ts';
import { AgentVoiceOverrideContext, AgentAttachmentDraftContext } from '@gentle-dot/ui/src/components/AgentAttachments.tsx';
import { SharedLinkContext } from '@gentle-dot/ui/src/components/SharedMarkdown.tsx';
import { useAppleVoice } from './use-apple-voice.ts';
import { localIdentifier } from './local-identifiers.ts';
import { openExternalURL } from './device-bridge.ts';
import { sessionAttachmentDraft } from './session-attachment-drafts.ts';
import '@gentle-dot/ui/src/mobile-navigation.css';
import './laptop-view.css';

type State = { connection?: DesktopConnection; active: boolean };
export function mountLaptopView(container: HTMLElement, onConnect: () => void, onPresence: (state: string) => void) {
  container.classList.add('chat-mobile');
  const root = createRoot(container);
  let current: DesktopConnection | undefined;
  function Laptop({ connection, active }: State) {
    const client = useMemo(() => connection ? createLaptopClient(connection, { current: () => current }) : undefined,
      [connection?.url, connection?.token, connection?.deviceId]);
    const controls = useOrchestration(client, active);
    const attachmentDrafts = useMemo(() => connection ? (paneId: string, sessionId: string) => sessionAttachmentDraft(connection.url, paneId, sessionId) : undefined, [connection?.url]);
    const [visiblePane, setVisiblePane] = useState<string>();
    const session = controls.snapshot?.sessions.find(item => item.paneId === visiblePane);
    const voice = useAppleVoice(active && Boolean(client) && Boolean(session), session && connection ? JSON.stringify([connection.url, session.paneId, session.sessionId]) : undefined);
    useEffect(() => { if (active) onPresence(controls.error ? 'unknown' : session?.state ?? 'idle'); }, [active, controls.error, session?.state]);
    const [linkError, setLinkError] = useState('');
    if (!client) return <section className="laptop-empty"><p className="eyebrow">TU LAPTOP</p><h2>Tus sesiones, aquí.</h2><p>Vincula Gentle Dot para abrir las conversaciones de Herdr, seguir su trabajo y responder cuando te necesiten.</p><button type="button" onClick={onConnect}>Vincular laptop</button></section>;
    return <AgentAttachmentDraftContext.Provider value={attachmentDrafts}><AgentVoiceOverrideContext.Provider value={voice}><SharedLinkContext.Provider value={url => {
      setLinkError(''); void openExternalURL(url).catch(error => setLinkError(error.message));
    }}>{linkError ? <p role="alert">{linkError}</p> : null}{active && session && voice.retryPending ? <button type="button" className="voice-discard-pending" disabled={voice.discarding} onClick={voice.discardPending}>{voice.discarding ? 'Descartando…' : 'Descartar audio pendiente'}</button> : null}<OrchestrationPanel key={connection?.url} createMessageId={localIdentifier} identityScope={`${connection?.url}|`} onVisibleSession={value => setVisiblePane(value?.paneId)} client={client} controls={controls} active={active} mobile capriMobile /></SharedLinkContext.Provider></AgentVoiceOverrideContext.Provider></AgentAttachmentDraftContext.Provider>;
  }
  return {
    update(state: State) { current = state.connection; root.render(<Laptop {...state} />); },
    destroy() { current = undefined; root.unmount(); },
  };
}
