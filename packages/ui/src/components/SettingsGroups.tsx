import { type Dispatch, isValidElement, type ReactNode } from "react";
import type { DotAction, DotState } from "../store.ts";
import type { CompanionControls } from "../useCompanion.ts";
import type { VoiceControls } from "../useVoice.ts";
import { CompanionSettings } from "./CapriCompanion.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { RequestPresentationSetting } from "./RequestPresentation.tsx";
import type { Send } from "./types.ts";
import { UsageBadgeSettings } from "./UsageBadgeSettings.tsx";

interface PhoneSettingsSlots {
	capri: ReactNode;
	avisos: ReactNode;
	equipo: ReactNode;
}

/** Named shell-owned controls travel through the existing ReactNode mobileControls seam. */
export function PhoneSettings({ capri, avisos, equipo }: PhoneSettingsSlots) {
	return <>{capri}{avisos}{equipo}</>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<details className="mobile-settings-group">
			<summary>{title}</summary>
			<div className="mobile-tool-list">{children}</div>
		</details>
	);
}

interface SettingsGroupsProps {
	controls: CompanionControls;
	mobileControls: ReactNode;
	state: DotState;
	send: Send;
	dispatch: Dispatch<DotAction>;
	ready: boolean;
	voice: VoiceControls;
	usage: boolean;
	watchers: boolean;
	conversations: boolean;
	settings: boolean;
	openUsage(): void;
	openWatchers(): void;
	openAppearance(): void;
	openAccounts(): void;
	openProfiles(): void;
	openConnectors(): void;
	openConversations(): void;
	newConversation(): void;
	openSettings(): void;
	advanced: ReactNode;
}

export function SettingsGroups({
	controls, mobileControls, state, send, dispatch, ready, voice,
	usage, watchers, conversations, settings, openUsage, openWatchers, openAppearance,
	openAccounts, openProfiles, openConnectors, openConversations, newConversation, openSettings, advanced,
}: SettingsGroupsProps) {
	const phone = isValidElement<PhoneSettingsSlots>(mobileControls) && mobileControls.type === PhoneSettings
		? mobileControls.props : undefined;
	return (
		<>
			<Group title="Capri">
				<CompanionSettings controls={controls} />
				{phone?.capri}
			</Group>
			<Group title="Avisos">
				{phone ? phone.avisos : mobileControls}
				<RequestPresentationSetting />
			</Group>
			<Group title="Personalización">
				<section className="mobile-menu-model" aria-label="Modelo de IA">
					<h3>Modelo</h3>
					<ModelPicker models={state.models} send={send} dispatch={dispatch} disabled={!ready}
						{...(state.model ? { model: state.model } : {})} />
				</section>
				<button type="button" onClick={openAppearance}>Apariencia del chat</button>
				{voice.mic ? (
					<button type="button" aria-pressed={!voice.muted} onClick={() => voice.setMuted(!voice.muted)}>
						Respuestas en voz alta <small>{voice.muted ? "Desactivadas" : "Activadas"}</small>
					</button>
				) : null}
			</Group>
			<Group title="Cuenta y equipo">
				<button type="button" onClick={openAccounts}>Cuentas de IA</button>
				<button type="button" onClick={openProfiles}>Perfiles</button>
				<button type="button" onClick={openConnectors}>
					Conexiones{state.connectors.issue ? <small>Revisar acceso</small> : null}
				</button>
				{phone?.equipo}
			</Group>
			<Group title="Avanzado">
				{usage ? (
					<>
						<button type="button" onClick={openUsage}>Consumo</button>
						<UsageBadgeSettings />
					</>
				) : null}
				{watchers ? <button type="button" onClick={openWatchers}>Dot 24/7</button> : null}
				{conversations ? (
					<>
						<button type="button" onClick={openConversations}>Conversaciones</button>
						<button type="button" disabled={!ready} onClick={newConversation}>Nueva conversación</button>
					</>
				) : null}
				{settings ? <button type="button" onClick={openSettings}>Ajustes del asistente</button> : null}
				{advanced}
			</Group>
		</>
	);
}
