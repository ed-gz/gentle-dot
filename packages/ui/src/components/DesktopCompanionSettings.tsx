import { useState } from "react";
import type {
	DesktopCompanionArea,
	DesktopCompanionControls,
	DesktopCompanionMonitor,
} from "../desktop-companion.ts";
import {
	CompanionSpaceEditor,
	type CompanionSpaceRect,
	FULL_COMPANION_SPACE,
} from "./CompanionSpaceEditor.tsx";

function MonitorMap({
	monitors,
	areas,
	selected,
}: {
	monitors: DesktopCompanionMonitor[];
	areas: DesktopCompanionArea[];
	selected: string;
}) {
	if (!monitors.length) return null;
	const left = Math.min(...monitors.map((monitor) => monitor.x));
	const top = Math.min(...monitors.map((monitor) => monitor.y));
	const width = Math.max(...monitors.map((monitor) => monitor.x + monitor.width)) - left;
	const height = Math.max(...monitors.map((monitor) => monitor.y + monitor.height)) - top;
	const scale = Math.min(300 / width, 140 / height);
	const dx = (320 - width * scale) / 2;
	const dy = (160 - height * scale) / 2;
	return (
		<div className="capri-monitor-map" style={{ aspectRatio: 2 }}>
			<svg
				viewBox="0 0 320 160"
				role="img"
				aria-label="Distribución de tus pantallas; las zonas marcadas son el espacio permitido"
			>
				{monitors.map((monitor, index) => {
					const area = areas.find((area) => area.monitor === monitor.name);
					const x = dx + (monitor.x - left) * scale;
					const y = dy + (monitor.y - top) * scale;
					return (
						<g key={monitor.name}>
							<rect
								x={x}
								y={y}
								width={monitor.width * scale}
								height={monitor.height * scale}
								rx="4"
								data-selected={monitor.name === selected}
								data-allowed={area?.enabled}
							/>
							{area?.enabled ? (
								<rect
									className="capri-monitor-zone"
									x={x + area.rect.x * monitor.width * scale}
									y={y + area.rect.y * monitor.height * scale}
									width={area.rect.width * monitor.width * scale}
									height={area.rect.height * monitor.height * scale}
									rx="4"
								/>
							) : null}
							<text x={x + (monitor.width * scale) / 2} y={y + (monitor.height * scale) / 2}>
								{index + 1}
							</text>
						</g>
					);
				})}
			</svg>
		</div>
	);
}

export function DesktopCompanionSettings({ controls }: { controls: DesktopCompanionControls }) {
	const { state, pending, error } = controls;
	const monitors = state.monitors ?? [];
	const saved = state.areas ?? [];
	const [selectedName, selectMonitor] = useState("");
	const selected = monitors.find((monitor) => monitor.name === selectedName) ?? monitors[0];
	const areas = monitors.map(
		(monitor) =>
			saved.find((area) => area.monitor === monitor.name) ?? {
				monitor: monitor.name,
				enabled: saved.length === 0,
				rect: FULL_COMPANION_SPACE,
			},
	);
	const current = areas.find((area) => area.monitor === selected?.name);
	const updateArea = (name: string, patch: { enabled?: boolean; rect?: CompanionSpaceRect }) => {
		// Keep disconnected displays and every other display's explicit choice intact.
		const disconnected = saved.filter((area) => !monitors.some((monitor) => monitor.name === area.monitor));
		void controls.change({
			areas: [
				...disconnected,
				...areas.map((area) => (area.monitor === name ? { ...area, ...patch } : area)),
			],
		});
	};
	const status = !state.enabled
		? "Desactivada en este equipo"
		: !state.available
			? "Esperando un espacio disponible"
			: state.pinned
				? "Fija donde la dejes"
				: !state.motion
					? "Paseos en pausa"
					: "Libre dentro de su espacio";
	return (
		<section className="capri-preferences desktop-companion-settings" aria-label="Capri en el escritorio">
			<header className="capri-preferences-header">
				<div>
					<h3>Capri</h3>
					<p className="capri-preferences-status" data-active={state.enabled && state.available}>
						{pending ? "Guardando cambios…" : status}
					</p>
				</div>
				<button
					type="button"
					role="switch"
					className="capri-activation"
					aria-label="Capri en el escritorio"
					aria-checked={state.enabled}
					disabled={pending || (!state.available && !state.enabled)}
					onClick={() => void controls.change({ enabled: !state.enabled })}
				>
					<span className="companion-switch-track" aria-hidden="true">
						<span />
					</span>
					<span>{state.enabled ? "Activa" : "Activar"}</span>
				</button>
			</header>
			{error ? (
				<p className="capri-preferences-error" role="alert">
					{error}
				</p>
			) : state.reason ? (
				<p role="status">{state.reason}</p>
			) : null}
			{!state.enabled ? (
				<p>Tu compañera sobre las ventanas de este equipo. Estos ajustes se guardan aquí.</p>
			) : (
				<>
                    <div className="capri-preferences-block">
                        <label>Vista de Capri
                            <select aria-label="Vista de Capri" disabled={pending} value={state.renderMode ?? "sprites"}
                                onChange={event => void controls.change({ renderMode: event.target.value as "sprites" | "3d" | "2d" })}>
                                <option value="sprites">Sprites</option>
                                <option value="3d">Capri 3D</option>
                                <option value="2d">Capri 2D (beta)</option>
                            </select>
                        </label>
                    </div>
					<div className="capri-preferences-block">
						<fieldset className="capri-preferences-mode" aria-label="Cómo se mueve Capri">
							<button
								type="button"
								aria-pressed={!state.pinned}
								disabled={pending}
								onClick={() => void controls.change({ pinned: false, motion: true })}
							>
								Libre
							</button>
							<button
								type="button"
								aria-pressed={state.pinned}
								disabled={pending}
								onClick={() => void controls.change({ pinned: true })}
							>
								Fija aquí
							</button>
						</fieldset>
						<p>
							{state.pinned
								? "Se queda donde la dejes y sigue animada. Arrástrala para cambiar su sitio."
								: "Pasea sólo por las pantallas y zonas que permitas."}
						</p>
					</div>
					<div className="capri-preferences-block">
						<h4>Su espacio</h4>
						{monitors.length ? (
							<>
								<MonitorMap monitors={monitors} areas={areas} selected={selected?.name ?? ""} />
								<fieldset className="capri-monitor-list" aria-label="Pantallas permitidas">
									{monitors.map((monitor, index) => {
										const area = areas.find((area) => area.monitor === monitor.name);
										return (
											<div
												className="capri-monitor-row"
												key={monitor.name}
												data-selected={monitor.name === selected?.name}
											>
												<label>
													<input
														type="checkbox"
														checked={area?.enabled ?? false}
														disabled={pending}
														aria-label={`Permitir Capri en ${monitor.name}`}
														onChange={(event) => updateArea(monitor.name, { enabled: event.target.checked })}
													/>
													<span>
														{index + 1} · {monitor.name}
													</span>
												</label>
												<button
													type="button"
													aria-label={`Editar zona de ${monitor.name}`}
													aria-pressed={monitor.name === selected?.name}
													onClick={() => selectMonitor(monitor.name)}
												>
													Editar zona
												</button>
											</div>
										);
									})}
								</fieldset>
								{!areas.some((area) => area.enabled) ? (
									<p role="status">Sin pantallas permitidas. Capri volverá cuando habilites una.</p>
								) : null}
								{selected && current ? (
									<>
										<p>
											<strong>{selected.name}</strong>
											{current.enabled
												? " · Ajusta el espacio marcado."
												: " · Habilita esta pantalla para ajustar su zona."}
										</p>
										<CompanionSpaceEditor
											key={selected.name}
											label={`Zona de ${selected.name}`}
											rect={current.rect}
											aspectRatio={selected.width / selected.height}
											disabled={pending || !current.enabled}
											onChange={(rect) => updateArea(selected.name, { rect })}
										/>
									</>
								) : null}
							</>
						) : (
							<p role="status">No hay pantallas disponibles para configurar.</p>
						)}
					</div>
					<div className="capri-preferences-secondary">
						<label>
							<span>Descansar de vez en cuando</span>
							<input
								type="checkbox"
								checked={state.appearances}
								disabled={pending}
								onChange={(event) => void controls.change({ appearances: event.target.checked })}
							/>
						</label>
						<div className="capri-preferences-actions">
							<button
								type="button"
								disabled={pending || !state.available}
								onClick={() => void controls.recall()}
							>
								Traer a Capri
							</button>
							{state.visible ? (
								<button type="button" disabled={pending} onClick={() => void controls.hide()}>
									Ocultar por ahora
								</button>
							) : null}
						</div>
					</div>
				</>
			)}
		</section>
	);
}
