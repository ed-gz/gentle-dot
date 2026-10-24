import { useId } from "react";
import type { ChatAppearanceControls, ChatAppearanceSettings } from "../useChatAppearance.ts";
import "../chat-appearance.css";

export function ChatAppearance({ controls }: { controls: ChatAppearanceControls }) {
	const { settings, change, reset, storageFailed } = controls;
	const id = useId();
	const choose = <K extends keyof ChatAppearanceSettings>(key: K, value: ChatAppearanceSettings[K]) =>
		change({ ...settings, [key]: value });
	return (
		<section className="chat-appearance" aria-label="Personalizar chat">
			<p className="appearance-intro">
				A tu gusto, sólo en este teléfono. Los cambios se aplican al instante.
			</p>
			<section className="appearance-preview" aria-label="Vista previa del chat">
				<span className="appearance-preview-label">Vista previa</span>
				<p className="appearance-preview-user">Organiza mi día.</p>
				<p className="appearance-preview-assistant">Claro. Empecemos por lo más importante.</p>
			</section>
			<fieldset className="appearance-options appearance-three">
				<legend>Tema</legend>
				{(
					[
						["dark", "Oscuro"],
						["light", "Claro"],
						["system", "Sistema"],
					] as const
				).map(([value, label]) => (
					<label key={value}>
						<input
							type="radio"
							name={`${id}-theme`}
							value={value}
							checked={settings.theme === value}
							onChange={() => choose("theme", value)}
						/>
						<span>{label}</span>
					</label>
				))}
			</fieldset>
			<fieldset className="appearance-options appearance-colors">
				<legend>Color de acento</legend>
				{(
					[
						["gentle", "Rosa Gentle"],
						["blue", "Azul"],
						["green", "Verde"],
						["amber", "Ámbar"],
					] as const
				).map(([value, label]) => (
					<label key={value}>
						<input
							type="radio"
							name={`${id}-accent`}
							value={value}
							checked={settings.accent === value}
							onChange={() => choose("accent", value)}
						/>
						<span className={`appearance-swatch appearance-swatch-${value}`} aria-hidden="true" />
						<span>{label}</span>
					</label>
				))}
			</fieldset>
			<fieldset className="appearance-options appearance-sizes">
				<legend>Tamaño del texto</legend>
				{([14, 16, 18, 20] as const).map((value) => (
					<label key={value}>
						<input
							type="radio"
							name={`${id}-font`}
							value={value}
							checked={settings.fontSize === value}
							onChange={() => choose("fontSize", value)}
						/>
						<span>{value}</span>
					</label>
				))}
			</fieldset>
			<fieldset className="appearance-options">
				<legend>Espaciado</legend>
				{(
					[
						["comfortable", "Cómodo"],
						["compact", "Compacto"],
					] as const
				).map(([value, label]) => (
					<label key={value}>
						<input
							type="radio"
							name={`${id}-density`}
							value={value}
							checked={settings.density === value}
							onChange={() => choose("density", value)}
						/>
						<span>{label}</span>
					</label>
				))}
			</fieldset>
			<fieldset className="appearance-options">
				<legend>Estilo de mensajes</legend>
				{(
					[
						["bubbles", "Burbujas"],
						["reading", "Lectura"],
					] as const
				).map(([value, label]) => (
					<label key={value}>
						<input
							type="radio"
							name={`${id}-layout`}
							value={value}
							checked={settings.layout === value}
							onChange={() => choose("layout", value)}
						/>
						<span>{label}</span>
					</label>
				))}
			</fieldset>
			<fieldset className="appearance-options appearance-three">
				<legend>Fondo</legend>
				{(
					[
						["plain", "Liso"],
						["rose", "Rosa suave"],
						["dots", "Puntos"],
					] as const
				).map(([value, label]) => (
					<label key={value}>
						<input
							type="radio"
							name={`${id}-background`}
							value={value}
							checked={settings.background === value}
							onChange={() => choose("background", value)}
						/>
						<span>{label}</span>
					</label>
				))}
			</fieldset>
			{storageFailed ? (
				<p className="appearance-storage-note" role="status">
					El cambio está aplicado, pero este teléfono no permite guardar la preferencia.
				</p>
			) : null}
			<button type="button" className="appearance-reset" onClick={reset}>
				Restaurar Gentle
			</button>
		</section>
	);
}
