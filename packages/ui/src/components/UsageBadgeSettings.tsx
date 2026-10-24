import { type BadgeProvider, useUsageBadges } from "../useUsageBadges.ts";
import { UsageGlyph } from "./UsageGlyph.tsx";
import "../usage-badges.css";

export function UsageBadgeSettings() {
	const [preferences, save] = useUsageBadges();
	const update = (id: BadgeProvider, patch: Partial<typeof preferences.providers.codex>) =>
		save({
			...preferences,
			providers: { ...preferences.providers, [id]: { ...preferences.providers[id], ...patch } },
		});
	return (
		<details className="usage-badge-settings">
			<summary>Porcentajes de consumo</summary>
			<label>
				<input
					type="checkbox"
					checked={preferences.visible}
					onChange={(event) => save({ ...preferences, visible: event.target.checked })}
				/>
				Mostrar porcentajes de consumo
			</label>
			{(["codex", "claude"] as const).map((id) => {
				const name = id === "codex" ? "Codex" : "Claude";
				return (
					<fieldset key={id} disabled={!preferences.visible}>
						<legend><UsageGlyph kind={id} />{name}</legend>
						<label>
							<input
								type="checkbox"
								checked={preferences.providers[id].visible}
								onChange={(event) => update(id, { visible: event.target.checked })}
							/>
							Mostrar {name}
						</label>
						<label>
							<input
								type="checkbox"
								checked={preferences.providers[id].fiveHour}
								onChange={(event) => update(id, { fiveHour: event.target.checked })}
							/>
							Ventana de 5 horas de {name}
						</label>
						<label>
							<input
								type="checkbox"
								checked={preferences.providers[id].weekly}
								onChange={(event) => update(id, { weekly: event.target.checked })}
							/>
							Ventana semanal de {name}
						</label>
						<label>
							Prioridad de {name}
							<select
								aria-label={`Prioridad de ${name}`}
								value={preferences.providers[id].priority}
								onChange={(event) => update(id, {
									priority: event.target.value === "weekly" ? "weekly" : "5h",
								})}
							>
								<option value="5h">5 horas antes que semanal</option>
								<option value="weekly">Semanal antes que 5 horas</option>
							</select>
						</label>
					</fieldset>
				);
			})}
		</details>
	);
}
