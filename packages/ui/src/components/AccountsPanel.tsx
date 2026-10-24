import type { AuthEvent, AuthPrompt, AuthProvider } from "@gentle-dot/protocol";
import { type ReactNode, useState } from "react";
import type { AuthState, DotAction } from "../store.ts";
import "../accounts.css";
import type { Send } from "./types.ts";

interface AccountsPanelProps {
	auth: AuthState;
	send: Send;
	dispatch: (action: DotAction) => void;
	openUrl: (url: string) => void;
	mobile?: boolean;
}

/** Sign-in for subscriptions and API keys, without a terminal. */
export function AccountsPanel({ auth, send, dispatch, openUrl, mobile = false }: AccountsPanelProps) {
	const copy = (en: string, es: string) => (mobile ? es : en);
	const [filter, setFilter] = useState("");
	const [method, setMethod] = useState<"oauth" | "api_key" | undefined>(undefined);
	const flow = auth.flow;
	const busy = flow !== undefined && flow.done === undefined;
	const login = (provider: AuthProvider, method: "oauth" | "api_key") => {
		dispatch({ type: "auth_started", providerId: provider.id });
		send({ type: "auth_login", providerId: provider.id, method });
	};
	const providers = (auth.providers ?? []).filter((p) =>
		p.name.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	const connected = (auth.providers ?? []).filter((p) => p.configured);
	const providerName = (id: string) => auth.providers?.find((p) => p.id === id)?.name ?? id;

	return (
		<section className="accounts" aria-label={copy("Accounts", "Cuentas")}>
			<header className="accounts-header">
				<h2>{copy("Accounts", "Cuentas")}</h2>
				<button
					type="button"
					className="icon"
					aria-label={copy("Close accounts", "Cerrar cuentas")}
					onClick={() => dispatch({ type: "accounts", open: false })}
				>
					×
				</button>
			</header>
			<p className="muted">
				{copy(
					"Connect the AI service you already pay for, or paste an API key. Your sign-in stays on this computer.",
					"Conecta tu suscripción de IA o usa una clave de API. El acceso se guarda en tu equipo.",
				)}
			</p>

			{flow ? (
				<div className="auth-flow">
					<p className="auth-flow-title">
						{copy("Signing in to", "Conectando con")} {providerName(flow.providerId)}
					</p>
					{flow.events.map((event, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: events are append-only and never reordered
						<FlowEvent key={`${event.kind}-${i}`} event={event} openUrl={openUrl} mobile={mobile} />
					))}
					{flow.prompt ? (
						<FlowPrompt key={flow.prompt.message} prompt={flow.prompt} send={send} mobile={mobile} />
					) : null}
					{busy && !flow.prompt && flow.events.length === 0 ? (
						<p className="muted">{copy("Starting…", "Iniciando…")}</p>
					) : null}
					{flow.done ? (
						<p className={`auth-result ${flow.done.ok ? "ok" : "failed"}`} role="status">
							{flow.done.ok
								? copy(
										`Connected to ${providerName(flow.providerId)}.`,
										`Conectado con ${providerName(flow.providerId)}.`,
									)
								: (flow.done.message ?? copy("Sign-in did not finish.", "No se pudo completar el acceso."))}
						</p>
					) : null}
					<div className="auth-actions">
						{busy && flow.flowId ? (
							<button
								type="button"
								onClick={() => send({ type: "auth_reply", flowId: flow.flowId ?? "", cancelled: true })}
							>
								{copy("Cancel", "Cancelar")}
							</button>
						) : null}
						{flow.done ? (
							<button
								type="button"
								onClick={() => {
									setMethod(undefined);
									setFilter("");
									dispatch({ type: "accounts", open: true });
								}}
							>
								{copy("Back to accounts", "Volver a cuentas")}
							</button>
						) : null}
					</div>
				</div>
			) : method === undefined ? (
				<>
					{connected.length > 0 ? (
						<section className="provider-section" aria-labelledby="accounts-connected">
							<h3 id="accounts-connected">{copy("Connected", "Cuentas conectadas")}</h3>
							<ul className="providers">
								{connected.map((provider) => (
									<li key={provider.id} className="connected-row">
										<b>{provider.name}</b>
										{provider.source === "stored" ? (
											<button
												type="button"
												className="link"
												aria-label={copy(`Sign out of ${provider.name}`, `Cerrar sesión de ${provider.name}`)}
												onClick={() => send({ type: "auth_logout", providerId: provider.id })}
											>
												{copy("Sign out", "Cerrar sesión")}
											</button>
										) : (
											<span className="muted">
												{copy("from your computer's settings", "desde la configuración del equipo")}
											</span>
										)}
									</li>
								))}
							</ul>
						</section>
					) : null}
					<div className="method-choices">
						<button type="button" className="method-choice" onClick={() => setMethod("oauth")}>
							<b>{copy("Use a subscription", "Usar una suscripción")}</b>
							<span>
								{copy(
									"Sign in with a plan you already pay for, like ChatGPT, GitHub Copilot, or Grok.",
									"Conecta tu plan de ChatGPT, GitHub Copilot, Grok u otro servicio.",
								)}
							</span>
						</button>
						<button type="button" className="method-choice" onClick={() => setMethod("api_key")}>
							<b>{copy("Use an API key", "Usar una clave de API")}</b>
							<span>
								{copy(
									"Paste a key from the provider's website. Works with every service.",
									"Pega una clave generada en la página de tu proveedor.",
								)}
							</span>
						</button>
					</div>
				</>
			) : (
				<>
					<button
						type="button"
						className="link back"
						onClick={() => {
							setMethod(undefined);
							setFilter("");
						}}
					>
						{copy("Back", "Volver")}
					</button>
					<input
						type="search"
						className="accounts-search"
						aria-label={copy("Search providers", "Buscar proveedor")}
						placeholder={copy("Search providers", "Buscar proveedor")}
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					{method === "oauth" ? (
						<ProviderSection
							title={copy("Use a subscription", "Usar una suscripción")}
							hint={copy(
								"Sign in with a plan you already pay for.",
								"Conecta una suscripción que ya tengas.",
							)}
							mobile={mobile}
							providers={providers.filter((p) => p.methods.includes("oauth"))}
							label={(p) => p.name}
							plan={(p) => (p.oauthName && p.oauthName !== p.name ? p.oauthName : undefined)}
							action={(p) => (
								<button
									type="button"
									className="primary"
									aria-label={copy(
										`Sign in with ${p.oauthName ?? p.name}`,
										`Conectar ${p.oauthName ?? p.name}`,
									)}
									onClick={() => login(p, "oauth")}
								>
									{copy("Sign in", "Conectar")}
								</button>
							)}
							send={send}
						/>
					) : (
						<ProviderSection
							title={copy("Use an API key", "Usar una clave de API")}
							hint={copy("Paste the key from the provider's website.", "Pega la clave de tu proveedor.")}
							mobile={mobile}
							providers={providers.filter((p) => p.methods.includes("api_key"))}
							label={(p) => p.name}
							action={(p) => (
								<button
									type="button"
									aria-label={copy(`Use an API key for ${p.name}`, `Usar clave de API de ${p.name}`)}
									onClick={() => login(p, "api_key")}
								>
									{copy("Use an API key", "Usar clave de API")}
								</button>
							)}
							send={send}
						/>
					)}
				</>
			)}
		</section>
	);
}

interface ProviderSectionProps {
	mobile?: boolean;
	title: string;
	hint: string;
	providers: AuthProvider[];
	label: (provider: AuthProvider) => string;
	/** A second line under the name, for example the subscription plan. */
	plan?: (provider: AuthProvider) => string | undefined;
	action: (provider: AuthProvider) => ReactNode;
	send: Send;
}

function ProviderSection({
	title,
	hint,
	providers,
	label,
	plan,
	action,
	send,
	mobile = false,
}: ProviderSectionProps) {
	if (providers.length === 0) return null;
	const id = `providers-${title.toLowerCase().replace(/\W+/g, "-")}`;
	return (
		<section className="provider-section" aria-labelledby={id}>
			<h3 id={id}>{title}</h3>
			<p className="muted">{hint}</p>
			<ul className="providers">
				{providers.map((provider) => (
					<li key={provider.id}>
						<div className="provider-name">
							<b>{label(provider)}</b>
							{provider.configured ? (
								<span className="chip ok">{mobile ? "Conectado" : "Connected"}</span>
							) : null}
						</div>
						{plan?.(provider) ? <p className="provider-plan">{plan(provider)}</p> : null}
						<div className="provider-actions">
							{action(provider)}
							{provider.configured && provider.source === "stored" ? (
								<button
									type="button"
									className="link"
									onClick={() => send({ type: "auth_logout", providerId: provider.id })}
								>
									{mobile ? "Cerrar sesión" : "Sign out"}
								</button>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}

export function FlowEvent({
	event,
	openUrl,
	mobile = false,
}: {
	event: AuthEvent;
	openUrl: (url: string) => void;
	mobile?: boolean;
}) {
	switch (event.kind) {
		case "auth_url":
			return (
				<div className="auth-step">
					<p>
						{event.instructions ??
							(mobile
								? "Termina el acceso en la página del proveedor."
								: "Finish signing in on the provider's page.")}
					</p>
					<button type="button" className="primary" onClick={() => openUrl(event.url)}>
						{mobile ? "Abrir página de acceso" : "Open the sign-in page"}
					</button>
				</div>
			);
		case "device_code":
			return (
				<div className="auth-step">
					<p>
						{mobile ? "Abre la página e introduce este código:" : "Open the page below and enter this code:"}
					</p>
					<code className="device-code">{event.userCode}</code>
					<button type="button" className="primary" onClick={() => openUrl(event.verificationUri)}>
						{mobile ? "Abrir página" : "Open the page"}
					</button>
				</div>
			);
		case "info":
		case "progress":
			return <p className="muted">{event.message}</p>;
	}
}

export function FlowPrompt({
	prompt,
	send,
	mobile = false,
}: {
	prompt: AuthPrompt;
	send: Send;
	mobile?: boolean;
}) {
	const [value, setValue] = useState("");
	const answer = (text: string) => send({ type: "auth_reply", flowId: prompt.flowId, value: text });
	if (prompt.kind === "select") {
		return (
			<div className="auth-step">
				<p>{prompt.message}</p>
				<div className="ask-options">
					{(prompt.options ?? []).map((option) => (
						<button
							key={option.id}
							type="button"
							title={option.description}
							onClick={() => answer(option.id)}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>
		);
	}
	return (
		<form
			className="auth-step ask-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (value.trim()) answer(value.trim());
			}}
		>
			<label>
				<span>{prompt.message}</span>
				<input
					type={prompt.kind === "secret" ? "password" : "text"}
					autoComplete="off"
					placeholder={
						prompt.placeholder ??
						(prompt.kind === "manual_code"
							? mobile
								? "Pega el código o la dirección completa"
								: "Paste the code or the full address here"
							: "")
					}
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
			</label>
			<button type="submit" className="primary" disabled={!value.trim()}>
				{mobile ? "Continuar" : "Continue"}
			</button>
			{prompt.optional ? (
				<button type="button" onClick={() => answer("")}>
					{mobile ? "Omitir" : "Skip"}
				</button>
			) : null}
		</form>
	);
}
