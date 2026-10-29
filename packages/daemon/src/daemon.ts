import { createMeetingProcessor, createPiMeetingGenerator } from "./work-meeting.ts";
import { WorkSyncStore } from "./work-sync.ts";
import type { WorkSyncRequest, WorkSyncReply } from "@gentle-dot/protocol";
import { ComposerGeometry } from "./orchestration/composer-geometry.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { McpTransport } from "@earendil-works/pi-mcp";
import {
	type AttachmentLimits,
	type ClientMessage,
	CloseCode,
	PROTOCOL_VERSION,
	WORK_SYNC_LIMITS,
	parseClientMessage,
} from "@gentle-dot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { CompanionPreference } from "./companion.ts";
import { TerminalMoodController } from "./terminal-mood.ts";
import { AppChannel } from "./app-channel.ts";
import { AuthManager, type AuthRuntime, createModelAuthRuntime, resolveAgentHome } from "./auth.ts";
import { AuthHelper } from "./auth-helper.ts";
import { type BridgeClient, DotBridge } from "./bridge.ts";
import { BROWSER_EXTENSION_PATH, BrowserController, BrowserError } from "./browser.ts";
import { BrowserRequests } from "./browser-requests.ts";
import {
	COMPLETIONS_EXTENSION_PATH,
	CompletionReports,
	CompletionReportsError,
} from "./completion-reports.ts";
import { computerApproval, computerSnapshot } from "./computer-access.ts";
import { ComputerCaptureStore } from "./computer-capture.ts";
import {
	APPROVAL_GUARD,
	ConnectorManager,
	type ConnectorOAuthOptions,
	ConnectorStore,
	policyEnv,
} from "./connectors.ts";
import { directAccess, type EngineAccess, engineAccess } from "./engine-access.ts";
import { approvalRequest } from "./extensions/approval-guard.ts";
import {
	claimEngineHome,
	ensureMemoryProject,
	ensurePrivateDir,
	isolatedAgentEnv,
	privateMemory,
} from "./isolation.ts";
import { MailWatch, MailWatchError } from "./mail-watch.ts";
import {
	MCP_PREFIX,
	McpProxy,
	McpReadError,
	type ProxiedConnector,
	type UpstreamCredentials,
} from "./mcp-proxy.ts";
import { allowApi, bearer, jsonResponse, MobileAccess, MobileAccessError, readJson } from "./mobile.ts";
import { MobileApprovals } from "./mobile-approvals.ts";
import { MobilePresence, readIdleHint } from "./mobile-presence.ts";
import { ORCHESTRATOR_EXTENSION_PATH, OrchestrationError, Orchestrator } from "./orchestration/index.ts";
import { writePrivateFile } from "./private-file.ts";
import { defaultImportPath, ProfileStore } from "./profiles.ts";
import { type RotationLimits, rotationLimits } from "./rotation.ts";
import { runtimeDir } from "./runtime.ts";
import { FileSecretSource, SECRETS_FILE, SECRETS_KEY_VAR } from "./secret-file.ts";
import { AppSecretSource } from "./secret-source.ts";
import { sessionNotice } from "./session-notifications.ts";
import { GitHubIssues } from "./github-issues.ts";
import { SHARE_FILE_EXTENSION_PATH, SharedFileStore } from "./shared-files.ts";
import { SharedFilesGateway } from "./shared-files-http.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { UploadStore } from "./uploads.ts";
import { SubscriptionUsage } from "./usage.ts";
import { VoiceService } from "./voice.ts";
import { LocalVoice } from "./local-voice.ts";
import { CONNECTOR_HOME, chownHandOver, prepareVpsLayout, type VpsOptions } from "./vps.ts";
import { WATCH_EXTENSION_PATH, WatcherError, Watchers, WatchSourceError } from "./watchers.ts";
import { PIN_FILE, PinGate } from "./web-pin.ts";
import { identityArgs } from "./white-label.ts";
import { WorkflowAuthorization } from "./workflow-authorization.ts";
import { WORKFLOWS_EXTENSION_PATH, WorkflowContinuations, WorkflowError } from "./workflows.ts";

export interface DaemonOptions {
	port: number;
	host: string;
	dataDir: string;
	/** The engine's working folder, owned by the assistant; it names the memory project. */
	workspace: string;
	/** A folder the user prefers to work in; the engine is told about it but keeps its own workspace. */
	preferredFolder?: string;
	/** Directory with the built web UI (`index.html`). */
	uiDir: string;
	agentCommand: string;
	agentArgs?: string[];
	agentExtraArgs?: string[];
	agentEnv?: NodeJS.ProcessEnv;
	/** The assistant's own Gentle Shell home (`--home`); profiles go next to it. */
	agentHome?: string;
	/** Another setup's `profiles.json` offered for a one-time import; defaults to the user's Gentle Shell store. */
	profilesImportPath?: string;
	/** Creates the sign-in runtime; defaults to Pi's ModelRuntime on the agent home. */
	authRuntime?: () => Promise<AuthRuntime>;
	/** The fetch for voice requests to OpenAI; tests pass a fake one. */
	voiceFetch?: typeof fetch;
	/** Read-only subscription usage; tests provide a deterministic local source. */
	subscriptionUsage?: Pick<SubscriptionUsage, "read">;
	/** Fixed per-window palette controller; tests supply an isolated Kitty fixture. */
	terminalMood?: Pick<TerminalMoodController, "read" | "apply">;
	/** How connector sign-ins reach the provider and the browser; tests pass stand-ins. */
	connectorOAuth?: ConnectorOAuthOptions;
	/** The home folder "Import my MCP servers" reads other apps' configs from; default `GENTLE_DOT_IMPORT_HOME` or the user's. */
	importHome?: string;
	/** The connection the MCP proxy makes to a connector's real server; tests pass a stand-in. */
	connectorTransport?: (connector: ProxiedConnector, credentials: UpstreamCredentials) => McpTransport;
	/**
	 * The desktop app's end of its private channel (fd 3 when the app launched the daemon, S25.1).
	 * Without it, connector changes and approvals fail closed. With it, the daemon stops when the
	 * channel closes (S35.2): the app that launched it is gone.
	 */
	appChannel?: Duplex;
	/** How long an approval waits for the app's answer; default 130 s (the app declines at 120 s). */
	approvalWaitMs?: number;
	/**
	 * Server mode (S25.8, `GENTLE_DOT_VPS`): the engine runs as another user, connector secrets are
	 * encrypted in a daemon file, and without the app the web page uses a PIN for privileged actions.
	 */
	vps?: VpsOptions;
	/** Origins allowed to open the WebSocket, besides the daemon's own and the desktop app's. */
	allowedOrigins?: string[];
	backoffMs?: number[];
	/** Several conversations instead of one continuous chat; default `GENTLE_DOT_CONVERSATIONS=1`. */
	conversations?: boolean;
	/** When the chat's session is rotated; default from `GENTLE_DOT_ROTATE_BYTES` and `GENTLE_DOT_ROTATE_COMPACTIONS`. */
	rotation?: RotationLimits;
	/** Messages per history page; default `GENTLE_DOT_HISTORY_PAGE` or 100. */
	historyPage?: number;
	/** Upload limits; default 25 MB per file, 10 files and 50 MB per message (S31.3). */
	uploadLimits?: AttachmentLimits;
	log?: (line: string) => void;
}

export interface DotDaemon {
	port: number;
	token: string;
	url: string;
	bridge: DotBridge;
	supervisor: AgentSupervisor;
	/** Stops the daemon; calling it again returns the same stop. */
	close(): Promise<void>;
	/** Settles once the daemon stopped, whether `close` was called or the app's channel closed. */
	closed: Promise<void>;
}

const HELLO_TIMEOUT_MS = 5000;
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
};

/**
 * Reads the access token from `<dataDir>/token`, creating a random one when
 * absent. The data folder is kept at 0700 (0711 in server mode, so the engine reaches its own folders by name) and the token at 0600.
 */
export function ensureToken(dataDir: string): string {
	ensurePrivateDir(dataDir);
	const file = join(dataDir, "token");
	if (existsSync(file)) {
		chmodSync(file, 0o600);
		const existing = readFileSync(file, "utf8").trim();
		if (existing.length >= 32) return existing;
	}
	const token = randomBytes(32).toString("base64url");
	writePrivateFile(file, `${token}\n`);
	return token;
}

/**
 * The line printed at startup. The access key is shown only on an interactive
 * terminal; redirected output (a log file, `docker logs`) says where it is instead.
 */
export function startupMessage(url: string, dataDir: string, interactive: boolean): string {
	if (interactive) return `Gentle Dot is running at ${url}`;
	return `Gentle Dot is running at ${url.split("#")[0]} (the access key is in ${join(dataDir, "token")})`;
}

export async function startDaemon(options: DaemonOptions): Promise<DotDaemon> {
	const log = options.log ?? (() => {});
	const token = ensureToken(options.dataDir);
	const vps = options.vps;
	// Server mode (S25.8): the daemon's files stay its own, the engine's folders become the engine's,
	// and from here on the daemon reaches them only as the engine's user (B1, engine-access.ts).
	if (vps) prepareVpsLayout(options.dataDir, vps.handOver ?? chownHandOver(vps.engine, log), vps.connector);
	const access: EngineAccess = vps ? (vps.access ?? engineAccess(vps.engine)) : directAccess;
	// Before anything is written there: the engine skips its first-run setup in a home it did not
	// create (S35.3). Only the assistant's default home; a home the user chose is never marked.
	if (options.agentHome && resolve(options.agentHome) === resolve(options.dataDir, "agent"))
		claimEngineHome(options.agentHome, log, access);
	access(() => mkdirSync(options.workspace, { recursive: true, mode: 0o700 }));
	ensureMemoryProject(options.workspace, access);
	const mobile = new MobileAccess(options.dataDir);
	const mobileApprovals = new MobileApprovals({ waitMs: options.approvalWaitMs });
	const computerApprovals = new Map<string, AbortController>();
	const pairingInProgress = new Set<string>();
	const acceptsToken = (value: string) => sameToken(value, token) || mobile.accepts(value);
	const orchestrationKey = randomBytes(32).toString("base64url");
	const browserKey = randomBytes(32).toString("base64url");
	const githubKey = randomBytes(32).toString("base64url");
	const completionsKey = randomBytes(32).toString("base64url");
	let completionReports: CompletionReports | undefined;
	const workflowsKey = randomBytes(32).toString("base64url");
	let workflows: WorkflowContinuations | undefined;
	const workflowAuthorization = new WorkflowAuthorization();
	const watchersKey = randomBytes(32).toString("base64url");
	let watchers: Watchers | undefined;
	let watcherTimer: ReturnType<typeof setInterval> | undefined;
	const filesKey = randomBytes(32).toString("base64url");
	const browser = vps ? undefined : new BrowserController({ dataDir: options.dataDir });
	const subscriptionUsage = vps
		? undefined
		: (options.subscriptionUsage ??
			new SubscriptionUsage({
				env: options.agentEnv ?? process.env,
				...(options.agentHome ? { agentHome: options.agentHome } : {}),
			}));
	let notifySession: DotBridge["notifySession"] | undefined;
	let presentWatchQuestion: DotBridge["askWatchContinuation"] | undefined;
	const pendingWatchQuestions: Array<Parameters<DotBridge["askWatchContinuation"]>> = [];
	// Local display adapters must never launch processes as a VPS daemon user (which may be root).
	const orchestrator = vps
		? undefined
		: new Orchestrator({
				dataDir: options.dataDir,
				piCommand: process.env.GENTLE_DOT_PI_BIN,
				onApproval: (approval) => workflows?.tryApprove(approval) ?? Promise.resolve(false),
				onInteraction: (target, origin) => workflows?.onInteraction(target, origin),
				onEvent: (event) => {
					const followed = workflows?.onEvent(event);
					const watched = watchers?.onEvent(event, followed ?? false);
					if (watched) void watchers?.prepare();
					if (!followed && !watched) {
						completionReports?.onEvent(event);
						completionReports?.prepare();
					}
					const notice = sessionNotice(event);
					if (notice) notifySession?.(notice);
				},
			});
	if (orchestrator)
		completionReports = new CompletionReports({
			dataDir: options.dataDir,
			snapshot: () => orchestrator.snapshot(),
			inspect: (paneId, sessionId) =>
				orchestrator.dispatch({ action: "inspect", paneId, sessionId }, "agent"),
		});
	if (orchestrator)
		workflows = new WorkflowContinuations({
			dataDir: options.dataDir,
			snapshot: () => orchestrator.snapshot(),
			inspect: (paneId, sessionId) =>
				orchestrator.dispatch({ action: "inspect", paneId, sessionId }, "agent"),
			prompt: (paneId, sessionId, text, authorize) =>
				orchestrator.dispatch({ action: "prompt", paneId, sessionId, text }, "agent", authorize),
			approve: (request, authorize) => orchestrator.answerForWorkflow(request, authorize),
			askContinuation: (work, answer) => {
				const args: Parameters<DotBridge["askWatchContinuation"]> = [work.sessions.map(session => session.label ?? session.paneId).join(", "), answer, { pauseReason: work.pauseReason, lastMessage: work.lastMessage }];
				if (presentWatchQuestion) presentWatchQuestion(...args);
				else pendingWatchQuestions.push(args);
			},
		});
	const folderArgs = options.preferredFolder
		? [
				"--append-system-prompt",
				`The user's preferred working folder is ${options.preferredFolder}. Use absolute paths there unless told otherwise.`,
			]
		: [];
	let agentEnv = { ...(options.agentEnv ?? process.env) };
	// The server's secrets key is the daemon's only, whatever the engine is (S25.8).
	delete agentEnv[SECRETS_KEY_VAR];
	delete agentEnv.GENTLE_DOT_FILES_URL;
	delete agentEnv.GENTLE_DOT_FILES_KEY;
	delete agentEnv.GENTLE_DOT_COMPLETIONS_URL;
	delete agentEnv.GENTLE_DOT_COMPLETIONS_KEY;
	delete agentEnv.GENTLE_DOT_WORKFLOWS_URL;
	delete agentEnv.GENTLE_DOT_WORKFLOWS_KEY;
	delete agentEnv.GENTLE_DOT_WATCHERS_URL;
	delete agentEnv.GENTLE_DOT_WATCHERS_KEY;
	delete agentEnv.GENTLE_DOT_GITHUB_URL;
	delete agentEnv.GENTLE_DOT_GITHUB_KEY;
	delete agentEnv.GENTLE_DOT_HISTORY_DIR;
	delete agentEnv.GENTLE_DOT_COMPANION_URL;
	delete agentEnv.GENTLE_DOT_COMPANION_KEY;
	const homeArgs: string[] = [];
	const memory = options.agentHome ? await privateMemory(agentEnv, options.dataDir, log, access) : undefined;
	if (options.agentHome) {
		homeArgs.push("--home", options.agentHome);
		// The engine also writes under the home folder; it gets one of its own.
		agentEnv = isolatedAgentEnv(agentEnv, options.dataDir, access);
		agentEnv.GENTLE_PI_CONFIG_HOME = join(options.dataDir, "gentle-ai");
	}
	const agentHome = options.agentHome ?? resolveAgentHome(process.env, options.dataDir);
	const app = options.appChannel
		? new AppChannel(options.appChannel, {
				log,
				...(options.approvalWaitMs ? { approvalWaitMs: options.approvalWaitMs } : {}),
			})
		: undefined;
	// The approved connectors are read once, here; the engine cannot change them (docs/design.md).
	// Their secrets come from the app's secure store over its channel, and only into memory (S25.5).
	const connectorStore = new ConnectorStore({
		dataDir: options.dataDir,
		agentHome,
		workspace: options.workspace,
		guardPath: APPROVAL_GUARD,
		// The assistant's own engine: its subagents load the guard from its extensions folder (S25.4).
		...(options.agentHome ? { childGuard: true } : {}),
		...(vps ? { engineAccess: access } : {}),
		env: agentEnv,
		// On a server without the app, an encrypted file with a key from the daemon's environment (S25.8).
		secrets:
			vps && !app
				? new FileSecretSource({
						file: join(options.dataDir, SECRETS_FILE),
						key: vps.secretsKey,
						...(vps.secretsKeyProblem ? { problem: vps.secretsKeyProblem } : {}),
					})
				: new AppSecretSource(app),
		log,
	});
	// The engine reaches every connector through the proxy (S25.4); its key changes with every launch.
	let port = options.port;
	const proxy = new McpProxy({
		connector: (id) => connectorStore.proxyView(id),
		prepare: (id) => connectorStore.prepare(id),
		credentials: (id) => connectorStore.credentials(id),
		// In the desktop app's native dialog, outside the agent's reach (S25.3).
		approve: (preview, signal) =>
			bridge.askInApp(
				approvalRequest(preview.connector, preview.connectorId, preview.tool, preview.arguments),
				signal,
			),
		...(options.connectorTransport ? { transport: options.connectorTransport } : {}),
		env: agentEnv,
		cwd: options.workspace,
		...(vps?.connector
			? { stdio: { user: vps.connector, home: join(options.dataDir, CONNECTOR_HOME) } }
			: {}),
		log,
	});
	connectorStore.onUpdated = () => proxy.sync();
	const mailWatch = new MailWatch({ proxy, connector: (id) => connectorStore.proxyView(id) });
	if (orchestrator)
		watchers = new Watchers({
			dataDir: options.dataDir,
			notify: notice => notifySession?.(notice),
			snapshot: () => orchestrator.snapshot(),
			inspect: (paneId, sessionId) =>
				orchestrator.dispatch({ action: "inspect", paneId, sessionId }, "agent"),
			email: async (id, cursor, signal) => {
				try {
					return await mailWatch.email(id, cursor, signal);
				} catch (error) {
					if (error instanceof MailWatchError || error instanceof McpReadError) {
						const requiresAction = [
							"MAIL_GAP",
							"MAIL_ACCOUNT_CHANGED",
							"MAIL_SCHEMA",
							"MAIL_FORMAT",
							"MAIL_CURSOR",
							"MAIL_LIMIT",
							"MAIL_UNSUPPORTED",
						].includes(error.code);
						throw new WatchSourceError(error.code, error.message, !requiresAction);
					}
					throw error;
				}
			},
			isFollowed: (paneId, sessionId) =>
				!!workflows
					?.status()
					.workflows.some(
						(work) =>
							work.mode !== "session" &&
							["waiting", "running"].includes(work.state) &&
							work.sessions.some((session) => session.paneId === paneId && session.sessionId === sessionId),
					),
		});
	const watchSources = () => [
		{ id: "agents", kind: "agents", label: "Sesiones", available: !!orchestrator },
		...mailWatch.available().map((source) => ({ ...source, kind: "email" })),
	];
	// Independent extensions share one background turn. Do not lease two continuations at once.
	let backgroundClaiming = false;
	const claimBackground = async <T>(
		available: () => boolean,
		status: () => T,
		take: () => Promise<T>,
	): Promise<T> => {
		if (backgroundClaiming || !available()) return status();
		backgroundClaiming = true;
		try {
			return await take();
		} finally {
			backgroundClaiming = false;
		}
	};
	const workflowDelivering = () => !!workflows?.status().workflows.some((work) => work.state === "running");
	// The assistant's own engine loads the approval guard for connector actions.
	const companion = new CompanionPreference(options.dataDir);
	const terminalMood = options.terminalMood ?? new TerminalMoodController(orchestrator);
	const composerGeometry = new ComposerGeometry(
		new TerminalMoodController(orchestrator),
		() => orchestrator?.companionGeometryBindings() ?? [],
		(paneId) => orchestrator?.observeCompanionPane(paneId),
	);
	const companionKey = randomBytes(32).toString("base64url");
	const runtime = runtimeDir();
	const companionExtension = runtime
		? join(runtime, "daemon", "extensions", "dot-companion.ts")
		: fileURLToPath(new URL("./extensions/dot-companion.ts", import.meta.url));
	const githubExtension = runtime
		? join(runtime, "daemon", "extensions", "dot-github.ts")
		: fileURLToPath(new URL("./extensions/dot-github.ts", import.meta.url));
	const liveInputExtension = runtime
		? join(runtime, "daemon", "extensions", "dot-live-input.ts")
		: fileURLToPath(new URL("./extensions/dot-live-input.ts", import.meta.url));
	const historyExtension = runtime
		? join(runtime, "daemon", "extensions", "dot-history.ts")
		: fileURLToPath(new URL("./extensions/dot-history.ts", import.meta.url));
	const guardArgs = options.agentHome
		? [
				"-e",
				liveInputExtension,
				"-e",
				companionExtension,
				"-e",
				historyExtension,
				...(!vps
					? ["-e", COMPLETIONS_EXTENSION_PATH, "-e", WORKFLOWS_EXTENSION_PATH, "-e", WATCH_EXTENSION_PATH]
					: []),
				"-e",
				APPROVAL_GUARD,
				...(!vps
					? ["-e", ORCHESTRATOR_EXTENSION_PATH, "-e", BROWSER_EXTENSION_PATH, "-e", SHARE_FILE_EXTENSION_PATH, "-e", githubExtension]
					: []),
			]
		: [];
	const supervisor = new AgentSupervisor({
		command: options.agentCommand,
		...(options.agentHome ? { steeringMode: "all" as const, liveInput: true } : {}),
		args: [...(options.agentArgs ?? []), ...homeArgs],
		extraArgs: [
			...identityArgs(options.dataDir),
			...folderArgs,
			...guardArgs,
			...(options.agentExtraArgs ?? []),
		],
		cwd: options.workspace,
		dataDir: options.dataDir,
		env: agentEnv,
		...(vps ? { user: vps.engine } : {}),
		// mcp.json is read when a session starts: put back anything not approved, and hand the guard
		// its policy from the daemon's memory, never from the files.
		// The proxy's key changes with every launch (after the check, so a change is still reported).
		// Subagents start only with the guard in place for them; otherwise this launch has none.
		prepareSpawn: () => {
			connectors.enforce();
			connectorStore.setProxy({ url: `http://127.0.0.1:${port}/mcp`, key: proxy.rotateKey() });
			const env = policyEnv(connectorStore);
			if (options.agentHome && agentEnv.GENTLE_PI_AGENTS !== "0" && !connectorStore.childGuardReady()) {
				log("subagents are off for this engine start: their approval guard is not in place");
				env.GENTLE_PI_AGENTS = "0";
			}
			return {
				...env,
				...(options.agentHome ? { GENTLE_DOT_COMPANION_URL: `http://127.0.0.1:${port}/api/companion/agent`, GENTLE_DOT_COMPANION_KEY: companionKey, GENTLE_DOT_HISTORY_DIR: join(options.dataDir, "sessions") } : {}),
				...(!vps
					? {
							GENTLE_DOT_ORCHESTRATION_URL: `http://127.0.0.1:${port}/api/orchestration/agent`,
							GENTLE_DOT_ORCHESTRATION_KEY: orchestrationKey,
							GENTLE_DOT_BROWSER_URL: `http://127.0.0.1:${port}/api/browser/agent`,
							GENTLE_DOT_BROWSER_KEY: browserKey,
							GENTLE_DOT_GITHUB_URL: `http://127.0.0.1:${port}/api/github/agent`,
							GENTLE_DOT_GITHUB_KEY: githubKey,
							GENTLE_DOT_FILES_URL: `http://127.0.0.1:${port}/api/files/agent`,
							GENTLE_DOT_FILES_KEY: filesKey,
							GENTLE_DOT_COMPLETIONS_URL: `http://127.0.0.1:${port}/api/completions/agent`,
							GENTLE_DOT_COMPLETIONS_KEY: completionsKey,
							GENTLE_DOT_WORKFLOWS_URL: `http://127.0.0.1:${port}/api/workflows/agent`,
							GENTLE_DOT_WORKFLOWS_KEY: workflowsKey,
							GENTLE_DOT_WATCHERS_URL: `http://127.0.0.1:${port}/api/watchers/agent`,
							GENTLE_DOT_WATCHERS_KEY: watchersKey,
						}
					: {}),
			};
		},
		// The first start in a new home installs the engine's companion packages.
		...(options.agentHome ? { startTimeoutMs: 180_000 } : {}),
		...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
		log: (line) => log(`[agent] ${line}`),
	});
	const computerCaptures = new ComputerCaptureStore();
	supervisor.onEvent((event) => computerCaptures.observe(event));
	// In server mode Pi's ModelRuntime runs in a helper as the engine's user, never as root (B1).
	const authHelper =
		vps?.authHelper && !options.authRuntime
			? new AuthHelper({
					...vps.authHelper,
					user: vps.engine,
					env: agentEnv,
					agentHome,
					cwd: options.workspace,
					log,
				})
			: undefined;
	const auth = new AuthManager({
		runtime:
			options.authRuntime ??
			(authHelper
				? () => authHelper.runtime()
				: vps
					? () => Promise.reject(new Error("sign-in has no helper on this server"))
					: () => createModelAuthRuntime(agentHome, options.workspace)),
		log,
	});
	const profiles = new ProfileStore({
		configHome: join(options.dataDir, "gentle-ai"),
		agentHome,
		importPath: options.profilesImportPath ?? defaultImportPath(process.env),
		...(vps ? { access } : {}),
	});
	const connectors = new ConnectorManager({
		store: connectorStore,
		...(options.connectorOAuth ? { oauth: options.connectorOAuth } : {}),
		...((options.importHome ?? process.env.GENTLE_DOT_IMPORT_HOME)
			? { importHome: options.importHome ?? process.env.GENTLE_DOT_IMPORT_HOME }
			: {}),
		log,
	});
	const voice = new VoiceService({
		...(app ? { local: new LocalVoice(app) } : {}),
		apiKey: () => auth.openAIApiKey(),
		...(options.voiceFetch ? { fetch: options.voiceFetch } : {}),
		log,
	});
	const uploads = new UploadStore({
		workspace: options.workspace,
		...(vps ? { access } : {}),
		...(options.uploadLimits ? { limits: options.uploadLimits } : {}),
	});
	orchestrator?.setUploadStore(uploads);
	const historyPage = options.historyPage ?? Number(process.env.GENTLE_DOT_HISTORY_PAGE);
	const mobilePresence = new MobilePresence(Date.now, (key, summary) => bridge.releaseMobileSummary(key, summary));
	const bridge = new DotBridge(supervisor, {
		mobilePresence,
		dataDir: options.dataDir,
		onCaptureInvalidated: () => computerCaptures.clear(),
		log,
		auth,
		profiles,
		connectors,
		voice,
		uploads,
		...(app
			? { app, ...(!vps ? { mobileApprovals, hasApprovalClient: () => hasApprovalClient() } : {}) }
			: {}),
		...(vps && !app ? { pin: new PinGate({ file: join(options.dataDir, PIN_FILE) }) } : {}),
		...(options.approvalWaitMs ? { approvalWaitMs: options.approvalWaitMs } : {}),
		...(vps ? { engineAccess: access } : {}),
		onHumanPrompt: (text, engineText) => workflowAuthorization.record(text, engineText),
		features: { conversations: options.conversations ?? process.env.GENTLE_DOT_CONVERSATIONS === "1" },
		rotation: options.rotation ?? rotationLimits(process.env),
		...(Number.isInteger(historyPage) && historyPage > 0 ? { historyPage } : {}),
	});

	let presenceReading = false;
	const samplePresence = async () => {
		for (const key of mobilePresence.keys()) if (!mobile.accepts(key)) mobilePresence.forget(key);
		if (presenceReading || mobilePresence.keys().next().done) return;
		presenceReading = true;
		try {
			const idle = vps ? undefined : await readIdleHint();
			const context = orchestrator?.companion();
			// Reuse semantic editor activity; no global key/mouse logger. A stale feed fails open.
			const signals = context?.sessions.filter(session => session.activity.source === "pi" && session.activity.capabilities.typing) ?? [];
			const times = signals.map(session => Date.parse(session.activity.humanActivityAt ?? "")).filter(Number.isFinite);
			mobilePresence.sample(idle, context?.stale ? undefined : times.length ? Math.max(...times) : undefined, signals.length > 0);
		} catch {
			mobilePresence.sample(undefined);
		} finally { presenceReading = false; }
	};
	void samplePresence();
	const presenceTimer = setInterval(() => { mobilePresence.tick(); void samplePresence(); }, 2000);
	presenceTimer.unref();

	// connectors.json as read at start is checked against its signature before anything rewrites it,
	// watches it, or starts the engine (S25.6).
	const integrity = connectorStore
		.checkIntegrity()
		.catch((error: Error) => log(`could not check connectors.json: ${error.message}`));
	notifySession = (notice) => bridge.notifySession(notice);
	presentWatchQuestion = (label, answer, pause) => bridge.askWatchContinuation(label, answer, pause);
	for (const args of pendingWatchQuestions.splice(0)) presentWatchQuestion(...args);
	const github = new GitHubIssues({approve: (request, signal) => bridge.askInApp(request, signal)});

	if (app) {
		// This inherited private channel is already connected; there is no reconnect handshake.
		void bridge.refreshVoiceCapability();
		// Nothing the app asks changes connectors before connectors.json was checked (S25.6).
		app.handler = async (method, params) => {
			await integrity;
			if (method === "computer_unregister" || method === "computer_register") computerCaptures.clear();
			return appRequest(method, params, bridge, connectors, app, computerApprovals);
		};
		// The computer helper belongs to the app that registered it (S24.7).
		app.onClose(() => {
			log("the desktop app's channel closed");
			void bridge.refreshVoiceCapability();
			computerCaptures.clear();
			for (const pending of computerApprovals.values()) pending.abort();
			mobileApprovals.cancelAll();
			connectors.unregisterComputer(app);
			// Secrets read from the app are forgotten; connectors that need one fail closed until it is back.
			connectorStore.lock();
		});
	} else if (vps)
		log(
			`server mode: the engine runs as uid ${vps.engine.uid}; connector changes and approvals need the web PIN${vps.secretsKey ? "" : `; ${vps.secretsKeyProblem ?? "connector secrets are off"}`}`,
		);
	else
		log(
			"no desktop app channel: connector changes and approvals are refused, and connectors that need a secret fail closed; to use them, stop this assistant and open the Gentle Dot app, which starts its own",
		);

	const fileStore = vps ? undefined : new SharedFileStore(options.dataDir);
	const browserRequests =
		browser && fileStore
			? new BrowserRequests({
					browser,
					files: fileStore,
					ask: (request, signal) => {
						if (app?.connected) return bridge.askInApp(request, signal);
						// A previously desktop-trusted phone can decide this browser request even
						// when the model or the native app is unavailable. Connector trust is unchanged.
						const pending = mobileApprovals.begin(`browser-${randomUUID()}`, request, signal);
						return pending.answer.finally(pending.cancel);
					},
					...(app
						? {
								installAvailable: () => app.connected,
								install: (requestId: string) =>
									app.request(
										"privileged_operation",
										{ requestId, operation: "install_browser", browser: "chromium" },
										960_000,
									),
								cancelInstall: (requestId: string) => app.request("privileged_cancel", { requestId }, 10_000),
							}
						: {}),
				})
			: undefined;
	const files = new SharedFilesGateway({
		store: fileStore,
		...(fileStore
			? { shareComputerCapture: () => fileStore.publishCapture(computerCaptures.latest(), "computer") }
			: {}),
		acceptsHuman: acceptsToken,
		acceptsAgent: (key) => sameToken(key, filesKey),
		origins: () => allowedOrigins(port, options),
	});
	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url ?? "/", "http://localhost");
		if (pathname.startsWith("/api/files/")) {
			void files.handle(req, res);
			return;
		}
		if (
			pathname.startsWith("/api/mobile/") ||
			(pathname === "/orchestration" || pathname === "/orchestration/guarded-v1" || pathname.startsWith("/orchestration/companion")) ||
			pathname === "/api/orchestration/agent" ||
			pathname === "/browser" ||
			pathname === "/api/browser/agent" ||
			pathname === "/api/github/agent" ||
			pathname === "/api/completions/agent" ||
			pathname === "/api/workflows/agent" ||
			pathname === "/api/watchers/agent" ||
			pathname === "/api/companion/agent"
		) {
			void (async () => {
				if (!allowApi(req, res, allowedOrigins(port, options))) return;
				const key = bearer(req);
				if (pathname === "/api/mobile/pair" && req.method === "POST") {
					const body = await readJson(req);
					if (typeof body.code !== "string" || body.code.length > 100 || typeof body.deviceName !== "string")
						return jsonResponse(res, 400, { error: "Invalid pairing request" });
					mobile.assertCanRedeem(body.code);
					if (pairingInProgress.has(body.code))
						return jsonResponse(res, 409, {
							code: "PAIRING_IN_PROGRESS",
							error: "This pairing is already awaiting confirmation on the computer.",
						});
					pairingInProgress.add(body.code);
					try {
						let approvalAccess = false;
						if (app?.connected && !vps) {
							const controller = new AbortController();
							const disconnected = () => {
								if (!res.writableEnded) controller.abort();
							};
							res.once("close", disconnected);
							try {
								approvalAccess = await app.approve(
									{
										connector: "Gentle Dot Mobile",
										action: "vincular este teléfono",
										title: "¿Permitir acceso a este teléfono?",
										summary:
											"Podrá conversar, controlar sesiones y responder solicitudes concretas de permisos. Acepta sólo si acabas de escanear el QR en tu teléfono.",
										preview: [{ name: "Teléfono", value: body.deviceName.slice(0, 80) }],
									},
									controller.signal,
								);
							} finally {
								res.off("close", disconnected);
							}
							if (res.destroyed) return;
							if (!approvalAccess)
								return jsonResponse(res, 403, {
									code: "PAIRING_DECLINED",
									error:
										"El equipo no autorizó este teléfono. Confirma la vinculación en Gentle Dot y vuelve a intentar.",
								});
						}
						jsonResponse(res, 200, mobile.redeem(body.code, body.deviceName, approvalAccess));
					} finally {
						pairingInProgress.delete(body.code);
					}
					return;
				}
				if (pathname === "/api/companion/agent") {
					if (!sameToken(key, companionKey)) return jsonResponse(res, 401, { error: "Unauthorized" });
					if (req.headers.origin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? ""))
						return jsonResponse(res, 403, { error: "Local engine only" });
					if (req.method === "GET") return jsonResponse(res, 200, companion.read());
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					return jsonResponse(res, 200, await terminalMood.apply(await readJson(req), () => sameToken(key, companionKey) && !res.destroyed));
				}
				if (pathname === "/api/orchestration/agent") {
					if (!orchestrator)
						return jsonResponse(res, 503, { error: "Local session control is unavailable in VPS mode" });
					if (!sameToken(key, orchestrationKey)) return jsonResponse(res, 401, { error: "Unauthorized" });
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use POST" });
					return jsonResponse(res, 200, await orchestrator.dispatch(await readJson(req), "agent"));
				}
				if (pathname === "/api/browser/agent") {
					if (!browser)
						return jsonResponse(res, 503, { error: "Local browser control is unavailable in VPS mode" });
					if (!sameToken(key, browserKey)) return jsonResponse(res, 401, { error: "Unauthorized" });
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use POST" });
					const input = await readJson(req);
					const controller = new AbortController();
					const disconnected = () => controller.abort();
					res.once("close", disconnected);
					try {
						const result = await browserRequests?.action(input, "agent", () => true, controller.signal);
						if (!res.destroyed) return jsonResponse(res, 200, result);
					} finally {
						res.off("close", disconnected);
					}
					return;
				}
				if (pathname === "/api/completions/agent") {
					if (!sameToken(key, completionsKey)) return jsonResponse(res, 401, { error: "Unauthorized" });
					const peer = req.socket.remoteAddress;
					if (
						!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
						req.headers.origin ||
						Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-"))
					)
						return jsonResponse(res, 403, { error: "Completion reports are local to the assistant engine" });
					if (!completionReports)
						return jsonResponse(res, 503, { error: "Reports are unavailable in VPS mode" });
					if (req.method !== "GET") return jsonResponse(res, 405, { error: "Use GET" });
					const reports = completionReports;
					const statusOnly = new URL(req.url ?? "/", "http://localhost").searchParams.get("status") === "1";
					return jsonResponse(
						res,
						200,
						statusOnly
							? { ...completionReports.status(), reports: [] }
							: await claimBackground(
									() => !watchers?.hasDelivery() && !workflowDelivering(),
									() => ({ ...reports.status(), reports: [] }),
									async () => reports.takeReady(),
								),
					);
				}
				if (pathname === "/api/github/agent") {
					if (vps) return jsonResponse(res, 503, {error:"GitHub local no está disponible en modo servidor."});
					if (!sameToken(key, githubKey)) return jsonResponse(res, 401, {error:"Unauthorized"});
					if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || req.headers.origin || Object.keys(req.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-"))) return jsonResponse(res,403,{error:"GitHub control is local to the assistant engine"});
					if (req.method !== "POST") return jsonResponse(res,405,{error:"Use POST"});
					const abort = new AbortController();
					const cancel = () => abort.abort();
					res.on("close",cancel);
					try { return jsonResponse(res,200,await github.dispatch(await readJson(req),abort.signal)); }
					catch { return jsonResponse(res,400,{error:"GitHub no pudo completar la operación. Verifica los campos, gh y los permisos del repositorio antes de reintentar."}); }
					finally { res.off("close",cancel); }
				}
				if (pathname === "/api/workflows/agent") {
					if (!sameToken(key, workflowsKey)) return jsonResponse(res, 401, { error: "Unauthorized" });
					const peer = req.socket.remoteAddress;
					if (
						!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
						req.headers.origin ||
						Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-"))
					)
						return jsonResponse(res, 403, { error: "Workflow control is local to the assistant engine" });
					if (!workflows) return jsonResponse(res, 503, { error: "Workflows are unavailable in VPS mode" });
					const coordinator = workflows;
					if (req.method === "GET") {
						const statusOnly = new URL(req.url ?? "/", "http://localhost").searchParams.get("status") === "1";
						return jsonResponse(
							res,
							200,
							statusOnly
								? workflows.status()
								: await claimBackground(
										() => !watchers?.hasDelivery(),
										() => coordinator.status(),
										() => coordinator.poll(true),
									),
						);
					}
					if (req.method === "POST") {
						const body = await readJson(req);
						// The engine cannot invent the original human instruction. Only authenticated chat sends enter this ledger.
						delete body.authorization;
						delete body.claimId;
						if (["start", "update", "resume", "claim"].includes(String(body.action))) {
							const instruction = workflowAuthorization.resolve(body.sourceHash);
							if (instruction) {
								body.authorization = instruction;
								if (body.action === "claim") body.claimId = body.sourceHash;
							}
						}
						delete body.sourceHash;
						if (body.action === "claim") {
							if (!body.authorization)
								return jsonResponse(res, 403, {
									error: "Se necesita una instrucción humana actual verificada.",
								});
							if (backgroundClaiming || watchers?.hasDelivery())
								return jsonResponse(res, 409, {
									error: "Hay otra continuación en curso; el permiso sigue pendiente.",
								});
							backgroundClaiming = true;
							try {
								return jsonResponse(res, 200, await workflows.dispatch(body, "agent"));
							} finally {
								backgroundClaiming = false;
							}
						}
						return jsonResponse(res, 200, await workflows.dispatch(body, "agent"));
					}
					return jsonResponse(res, 405, { error: "Use GET or POST" });
				}
				if (pathname === "/api/watchers/agent") {
					if (!sameToken(key, watchersKey)) return jsonResponse(res, 401, { error: "Unauthorized" });
					const peer = req.socket.remoteAddress;
					if (
						!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
						req.headers.origin ||
						Object.keys(req.headers).some((name) => name === "forwarded" || name.startsWith("x-forwarded-"))
					)
						return jsonResponse(res, 403, { error: "Event watches are local to the assistant engine" });
					if (!watchers) return jsonResponse(res, 503, { error: "Watches are unavailable in VPS mode" });
					const observer = watchers;
					if (req.method === "GET") {
						const statusOnly = new URL(req.url ?? "/", "http://localhost").searchParams.get("status") === "1";
						return jsonResponse(res, 200, {
							...(statusOnly
								? watchers.status()
								: await claimBackground(
										() => !workflowDelivering(),
										() => observer.status(),
										() => observer.poll(true),
									)),
							sources: watchSources(),
						});
					}
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					const body = await readJson(req);
					delete body.authorization;
					if (["start", "resume"].includes(String(body.action))) {
						const instruction = workflowAuthorization.resolve(body.sourceHash);
						if (instruction) body.authorization = instruction;
					}
					delete body.sourceHash;
					// Unconfigured accounts are reported once at setup, never silently enabled.
					if (body.action === "start" && typeof body.source === "object" && body.source !== null) {
						const source = body.source as Record<string, unknown>;
						if (
							source.kind === "email" &&
							!mailWatch.available().some((item) => item.id === source.connectorId && item.configured)
						)
							return jsonResponse(res, 409, {
								error: "Conecta primero una cuenta Gmail compatible en Conexiones.",
							});
					}
					const result = await watchers.dispatch(body, "agent");
					return jsonResponse(res, 200, {
						...(typeof result === "object" && result !== null ? result : {}),
						sources: watchSources(),
					});
				}
				if (!acceptsToken(key)) {
					req.resume();
					return jsonResponse(res, 401, { error: "Unauthorized" });
				}
				if (pathname === "/api/mobile/terminal-mood") {
					const authorize = () => acceptsToken(key) && !res.destroyed;
					if (req.method === "GET")
						return jsonResponse(res, 200, await terminalMood.read(new URL(req.url ?? "/", "http://localhost").searchParams.get("paneId"), authorize));
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					return jsonResponse(res, 200, await terminalMood.apply(await readJson(req), authorize));
				}
				if (pathname === "/api/mobile/companion") {
					if (req.method === "GET") return jsonResponse(res, 200, companion.read());
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					const body = await readJson(req);
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					if (body.mode !== "gentle" && body.mode !== "capri") return jsonResponse(res, 400, { error: "Elige Gentle Dot o Capri." });
					return jsonResponse(res, 200, companion.set(body.mode));
				}
				if (pathname === "/api/mobile/watchers") {
					if (!watchers) return jsonResponse(res, 503, { error: "Watches are unavailable in VPS mode" });
					if (req.method === "GET") {
						const setup = new URL(req.url ?? "/", "http://localhost").searchParams.get("setup") === "1";
						const sessions =
							setup && orchestrator
								? (await orchestrator.snapshot()).sessions
										.filter((session) => session.connected && session.sessionId)
										.map((session) => ({
											paneId: session.paneId,
											sessionId: session.sessionId,
											label: session.label,
										}))
								: undefined;
						if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
						return jsonResponse(res, 200, {
							...watchers.status(),
							sources: watchSources(),
							...(sessions ? { sessions } : {}),
						});
					}
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					const body = await readJson(req);
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					if (!["start", "pause", "resume", "delete"].includes(String(body.action)))
						return jsonResponse(res, 400, {
							error: "Elige crear, pausar, reanudar o eliminar el seguimiento.",
						});
					if (body.action === "start" && typeof body.source === "object" && body.source !== null) {
						const source = body.source as Record<string, unknown>;
						if (
							source.kind === "email" &&
							!mailWatch.available().some((item) => item.id === source.connectorId && item.available)
						)
							return jsonResponse(res, 409, {
								error: "Conecta primero Gmail en Conexiones y comprueba que esté disponible.",
							});
					}
					// Only these explicit settings are accepted. Creating a watch never grants action or approval authority.
					const action =
						body.action === "start"
							? {
									action: "start",
									source: body.source,
									instruction: body.instruction,
									intervalMs: body.intervalMs,
								}
							: { action: body.action, watchId: body.watchId };
					const result = await watchers.dispatch(action, "human", () => acceptsToken(key));
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					return jsonResponse(res, 200, result);
				}
				if (pathname === "/api/mobile/workflows") {
					if (!workflows) return jsonResponse(res, 503, { error: "Workflows are unavailable in VPS mode" });
					if (req.method === "GET") return jsonResponse(res, 200, workflows.status());
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					const body = await readJson(req);
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					if (!["pause", "resume", "stop", "pauseAll"].includes(String(body.action)))
						return jsonResponse(res, 400, { error: "Elige pausar, reanudar o finalizar el seguimiento." });
					const result = await workflows.dispatch(body, "human", () => acceptsToken(key));
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					return jsonResponse(res, 200, result);
				}
				if (pathname === "/api/mobile/usage") {
					if (!subscriptionUsage)
						return jsonResponse(res, 503, { error: "Subscription usage is unavailable in VPS mode" });
					if (req.method !== "GET") return jsonResponse(res, 405, { error: "Use GET" });
					let result: Awaited<ReturnType<SubscriptionUsage["read"]>>;
					try {
						result = await subscriptionUsage.read();
					} catch {
						return jsonResponse(res, 502, { error: "No se pudo consultar el consumo de suscripciones." });
					}
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					return jsonResponse(res, 200, result);
				}
				if (pathname === "/api/mobile/completions") {
					if (!completionReports)
						return jsonResponse(res, 503, { error: "Reports are unavailable in VPS mode" });
					if (req.method === "GET") return jsonResponse(res, 200, completionReports.status());
					if (req.method !== "POST") return jsonResponse(res, 405, { error: "Use GET or POST" });
					const body = await readJson(req);
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					return jsonResponse(res, 200, completionReports.configure(body.enabled));
				}
				if (pathname === "/api/mobile/computer") {
					if (vps || !app?.connected)
						return jsonResponse(res, 503, {
							error: "Abre Gentle Dot en el equipo para controlar el escritorio.",
						});
					if (req.method !== "GET" && req.method !== "POST")
						return jsonResponse(res, 405, { error: "Use GET or POST" });
					if (req.method === "POST") {
						if (!sameToken(key, token) && !mobile.canApprove(key))
							return jsonResponse(res, 403, { error: "Este teléfono necesita autorización del equipo." });
						const body = await readJson(req);
						if (body.action !== "stop" || Object.keys(body).length !== 1)
							return jsonResponse(res, 400, { error: "Sólo se permite detener el control del equipo." });
						if (!sameToken(key, token) && !mobile.canApprove(key))
							return jsonResponse(res, 401, { error: "Unauthorized" });
					}
					if (req.method === "POST") {
						computerCaptures.clear();
						for (const pending of computerApprovals.values()) pending.abort();
					}
					const result = await app.request(
						req.method === "POST" ? "computer_stop" : "computer_status",
						{},
						10_000,
					);
					if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					return jsonResponse(res, 200, computerSnapshot(result));
				}
				if (pathname === "/api/mobile/approvals" || pathname === "/api/mobile/answer" || pathname === "/api/mobile/answer-v1") {
					if (!mobile.canApprove(key) || vps)
						return jsonResponse(res, 403, {
							error:
								"Vincula el teléfono con autorización de la app de escritorio para responder permisos de Dot.",
						});
					if (pathname === "/api/mobile/approvals" && req.method === "GET")
						return jsonResponse(res, 200, {
							approvals: mobileApprovals
								.list()
								.filter((approval) => app?.connected || approval.id.startsWith("browser-")),
						});
					if (pathname === "/api/mobile/answer-v1" && req.method === "POST") {
						const body = await readJson(req);
						if (!mobile.canApprove(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
						const candidate = body.review;
						if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
							return jsonResponse(res, 400, { error: "Exact reviewed approval required" });
						const view = candidate as Record<string, unknown>;
						if (typeof body.requestId !== "string" || typeof body.approved !== "boolean" || view.id !== body.requestId || typeof view.title !== "string" || typeof view.message !== "string" || typeof view.expiresAt !== "string" || typeof view.revision !== "string")
							return jsonResponse(res, 400, { error: "Exact reviewed approval required" });
						// Some producers supply summaries rather than all material arguments.
						if (body.approved) return jsonResponse(res, 403, { error: "Revisa y aprueba esta solicitud en la laptop." });
						if (!app?.connected && !body.requestId.startsWith("browser-")) return jsonResponse(res, 403, { error: "Esta solicitud requiere la app de escritorio." });
						if (!mobileApprovals.answerExact({ id: view.id, title: view.title, message: view.message, expiresAt: view.expiresAt, revision: view.revision }, body.approved))
							return jsonResponse(res, 409, { error: "La solicitud cambió, terminó o venció." });
						return jsonResponse(res, 200, { ok: true, requestId: body.requestId, revision: view.revision });
					}
					if (pathname === "/api/mobile/answer" && req.method === "POST") {
						const body = await readJson(req);
						if (!mobile.canApprove(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
						if (typeof body.requestId !== "string" || typeof body.approved !== "boolean")
							return jsonResponse(res, 400, { error: "Invalid approval response" });
						if (!app?.connected && !body.requestId.startsWith("browser-"))
							return jsonResponse(res, 403, { error: "Esta solicitud requiere la app de escritorio." });
						if (!mobileApprovals.answer(body.requestId, body.approved))
							return jsonResponse(res, 409, { error: "Esta solicitud ya terminó o venció." });
						return jsonResponse(res, 200, { ok: true });
					}
					return jsonResponse(res, 405, { error: "Method not allowed" });
				}
				if (pathname === "/browser") {
					if (!browser)
						return jsonResponse(res, 503, { error: "Local browser control is unavailable in VPS mode" });
					if (req.method === "GET") return jsonResponse(res, 200, browserRequests?.status());
					if (req.method === "POST") {
						const input = await readJson(req);
						const controller = new AbortController();
						const disconnected = () => controller.abort();
						res.once("close", disconnected);
						try {
							const result = await browserRequests?.action(
								input,
								"human",
								() => acceptsToken(key),
								controller.signal,
							);
							if (!res.destroyed) return jsonResponse(res, 200, result);
						} finally {
							res.off("close", disconnected);
						}
						return;
					}
					return jsonResponse(res, 405, { error: "Use GET or POST" });
				}
				if (pathname === "/orchestration/companion" || pathname === "/orchestration/companion/focus") {
					if (!orchestrator) return jsonResponse(res, 503, { error: "Local session control is unavailable in VPS mode" });
					if (pathname === "/orchestration/companion" && req.method === "GET") {
						const state = await composerGeometry.enrich(orchestrator.companion(), () => acceptsToken(key) && !res.destroyed);
						if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
						if (!res.destroyed) return jsonResponse(res, 200, state);
						return;
					}
					if (pathname === "/orchestration/companion/focus" && req.method === "POST")
						return jsonResponse(res, 200, await orchestrator.focusCompanion(await readJson(req), () => acceptsToken(key) && !res.destroyed));
					return jsonResponse(res, 405, { error: "Method not allowed" });
				}
				if (pathname === "/orchestration/guarded-v1") {
                    if (!orchestrator) return jsonResponse(res, 503, {error:"Local session control is unavailable in VPS mode"});
                    if (req.method !== "POST") return jsonResponse(res,405,{error:"Use POST"});
                    const body=await readJson(req);
                    if (!body || typeof body !== "object" || Array.isArray(body) || !["prompt","abort","answer","close","duplicate"].includes(String(body.action)) || typeof body.expectedInstanceId !== "string" || !body.expectedInstanceId)
                        return jsonResponse(res,400,{error:"Session instance precondition required"});
                    return jsonResponse(res,200,await orchestrator.dispatch(body,"human",()=>acceptsToken(key) && !res.destroyed,key));
                }
				if (pathname === "/orchestration") {
					if (!orchestrator)
						return jsonResponse(res, 503, { error: "Local session control is unavailable in VPS mode" });
					if (req.method === "GET") {
						const snapshot = await orchestrator.snapshot();
						if (!acceptsToken(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
						if (mobile.accepts(key)) {
							mobilePresence.configure(key, req.headers["x-gentle-presence"] === "off" ? false : req.headers["x-gentle-presence"] === "on" ? true : undefined);
							const summary = mobilePresence.summary(key);
							return jsonResponse(res, 200, {...snapshot,
								events: snapshot.events.map(event => ({...event, mobileNotificationSuppressed: mobilePresence.suppressed(key, event.id)})),
								mobileNotificationSummary: summary ? bridge.mobileSummaryPayload(summary) : undefined});
						}
						return jsonResponse(res, 200, snapshot);
					}
					if (req.method === "POST")
						return jsonResponse(
							res,
							200,
							await orchestrator.dispatch(await readJson(req), "human", () => acceptsToken(key) && !res.destroyed, key),
						);
					return jsonResponse(res, 405, { error: "Use GET or POST" });
				}
				if (pathname === "/api/mobile/disconnect" && req.method === "POST") {
					await readJson(req);
					if (!mobile.accepts(key)) return jsonResponse(res, 401, { error: "Unauthorized" });
					mobile.revokeToken(key);
					for (const client of wss.clients)
						if (clientKeys.has(client) && !acceptsToken(clientKeys.get(client) ?? ""))
							client.close(CloseCode.unauthorized, "device revoked");
					if (!hasApprovalClient()) mobileApprovals.cancelAll();
					return jsonResponse(res, 200, { ok: true });
				}
				// Pairing administration belongs to the computer's owner key.
				if (!sameToken(key, token))
					return jsonResponse(res, 403, { error: "Manage devices from the computer" });
				if (pathname === "/api/mobile/code" && req.method === "POST")
					return jsonResponse(res, 200, mobile.issue());
				if (pathname === "/api/mobile/devices" && req.method === "GET")
					return jsonResponse(res, 200, { devices: mobile.list() });
				if (pathname === "/api/mobile/revoke" && req.method === "POST") {
					const body = await readJson(req);
					if (typeof body.deviceId !== "string") return jsonResponse(res, 400, { error: "Missing deviceId" });
					mobile.revoke(body.deviceId);
					// Recheck live sessions immediately; a revoked connection must stop receiving data.
					for (const client of wss.clients)
						if (clientKeys.has(client) && !acceptsToken(clientKeys.get(client) ?? ""))
							client.close(CloseCode.unauthorized, "device revoked");
					if (!hasApprovalClient()) mobileApprovals.cancelAll();
					return jsonResponse(res, 200, { ok: true });
				}
				jsonResponse(res, 404, { error: "Unknown endpoint" });
			})().catch((error: Error) =>
				jsonResponse(
					res,
					error instanceof OrchestrationError ||
						error instanceof MobileAccessError ||
						error instanceof BrowserError ||
						error instanceof CompletionReportsError ||
						error instanceof WorkflowError ||
						error instanceof WatcherError
						? error.status
						: 400,
					{
						error: error.message,
						...(error instanceof MobileAccessError || error instanceof OrchestrationError ? { code: error.code } : {}),
					},
				),
			);
			return;
		}
		if (pathname === "/upload") {
			void handleUpload(req, res, acceptsToken, allowedOrigins(port, options), uploads, orchestrator);
			return;
		}
		if (pathname.startsWith(MCP_PREFIX)) {
			proxy.handle(req, res);
			return;
		}
		handleHttp(req, res, options.uiDir, bridge);
	});
	const workSync = new WorkSyncStore(join(options.dataDir, "work-inbox"), vps ? undefined : createMeetingProcessor({
		...(app ? { voice: new LocalVoice(app) } : {}), generate: createPiMeetingGenerator(agentHome, supervisor),
	}));
	const clientKeys = new WeakMap<WebSocket, string>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
	const hasApprovalClient = () =>
		[...wss.clients].some(
			(client) => client.readyState === client.OPEN && mobile.canApprove(clientKeys.get(client) ?? ""),
		);

	server.on("upgrade", (req, socket, head) => {
		// A client reset between the upgrade hand-off and ws taking over the raw socket would
		// otherwise emit an unhandled 'error' event and kill the daemon (ECONNRESET crash).
		socket.once("error", () => socket.destroy());
		const url = new URL(req.url ?? "/", "http://localhost");
		const origin = req.headers.origin;
		if (url.pathname !== "/ws" || (origin !== undefined && !allowedOrigins(port, options).has(origin))) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) =>
			acceptClient(
				ws,
				acceptsToken,
				bridge,
				(key) => clientKeys.set(ws, key),
				() => {},
				(key) => {
					if (!mobile.accepts(key)) return undefined;
					mobilePresence.configure(key, req.headers["x-gentle-presence"] === "off" ? false : req.headers["x-gentle-presence"] === "on" ? true : undefined);
					return key;
				},
				{ handle: (key, message) => workSync.handle(mobile.deviceIdForToken(key) ?? "desktop", message), meetingDrafts: !vps, limits: { audioBytes: WORK_SYNC_LIMITS.audioBytes, attachmentBytes: WORK_SYNC_LIMITS.attachmentBytes } },
			),
		);
	});

	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(options.port, options.host, () => done());
	});
	port = (server.address() as AddressInfo).port;

	let stopped = () => {};
	const closed = new Promise<void>((done) => {
		stopped = done;
	});
	const shutdown = async () => {
		clearInterval(presenceTimer);
		files.close();
		browserRequests?.close();
		// Not listening any more first, so an app relaunched meanwhile starts a daemon of its own.
		const serverClosed = new Promise<void>((done) => server.close(() => done()));
		app?.close();
		mobileApprovals.close();
		completionReports?.close();
		workflows?.close();
		if (watcherTimer) clearInterval(watcherTimer);
		watchers?.close();
		await Promise.all([orchestrator?.close(), browser?.close()]);
		for (const client of wss.clients) client.terminate();
		wss.close();
		await workSync.close();
		// Stops waiting approvals and the connectors' servers (stdio ones are processes of the daemon).
		await proxy.close();
		await serverClosed;
		await supervisor.stop();
		connectorStore.close();
		authHelper?.close();
		await memory?.stop();
	};
	let stopping: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (!stopping) {
			stopping = shutdown();
			stopping.then(stopped, (error: Error) => {
				log(`the assistant did not stop cleanly: ${error.message}`);
				stopped();
			});
		}
		return stopping;
	};
	// The daemon lives as long as the app that launched it (S35.2): a daemon left behind with no
	// channel would keep connectors locked, and a relaunched app could not get a channel to it.
	app?.onClose(() => {
		log("the desktop app's channel closed; stopping the assistant");
		void close().catch(() => {});
	});

	// Listening first keeps the app's health check answered while its store is asked for the key.
	await integrity;
	// Secrets that files still hold move into the app's store, once; on a server, into its encrypted file.
	if (app?.connected || (vps && !app && vps.secretsKey))
		void connectorStore
			.migrate()
			.catch((error: Error) => log(`connector secrets were not moved: ${error.message}`));
	// The files as the daemon writes them (an older version kept a hash), then watched.
	if (!stopping) {
		connectorStore.enforce(false);
		connectorStore.watch();
		if (watchers) {
			watcherTimer = setInterval(() => {
				void watchers
					?.tick()
					.then(() => watchers?.prepare())
					.catch(() => {});
				void watchers?.prepare();
				void workflows?.prepare();
				completionReports?.prepare();
			}, 15_000);
			watcherTimer.unref();
		}
		await supervisor
			.start()
			.catch((error: Error) => log(`agent failed to start: ${error.message}; retrying`));
	}

	return {
		port,
		token,
		url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${port}/#token=${token}`,
		bridge,
		supervisor,
		close,
		closed,
	};
}

/** What the desktop app asks over its channel: a window's connector change, or its computer helper. */
async function appRequest(
	method: string,
	params: unknown,
	bridge: DotBridge,
	connectors: ConnectorManager,
	app: AppChannel,
	computerApprovals: Map<string, AbortController>,
): Promise<object> {
	const fields = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
	switch (method) {
		case "command":
			await bridge.handleFromApp(String(fields.clientId ?? ""), fields.message);
			return {};
		case "computer_register": {
			const parsed = parseClientMessage(JSON.stringify({ ...fields, type: "computer_register" }));
			if (parsed?.type !== "computer_register") throw new Error("That is not the computer helper's address.");
			connectors.registerComputer(app, { url: parsed.url, token: parsed.token });
			return {};
		}
		case "computer_approval": {
			const preview = computerApproval(params);
			const requestId = fields.requestId as string;
			if (computerApprovals.has(requestId)) throw new Error("Duplicate computer approval");
			const controller = new AbortController();
			computerApprovals.set(requestId, controller);
			try {
				return { approved: await bridge.askInApp(preview, controller.signal) };
			} finally {
				computerApprovals.delete(requestId);
			}
		}
		case "computer_approval_cancel":
			if (
				Object.keys(fields).length !== 1 ||
				typeof fields.requestId !== "string" ||
				!/^[a-f0-9]{64}$/.test(fields.requestId)
			)
				throw new Error("Invalid cancellation");
			computerApprovals.get(fields.requestId)?.abort();
			return {};
		case "computer_unregister":
			for (const pending of computerApprovals.values()) pending.abort();
			connectors.unregisterComputer(app);
			return {};
		default:
			throw new Error(`Unknown request: ${method}`);
	}
}

function allowedOrigins(port: number, options: DaemonOptions): Set<string> {
	return new Set([
		`http://127.0.0.1:${port}`,
		`http://localhost:${port}`,
		"tauri://localhost",
		"http://tauri.localhost",
		"https://localhost",
		...(options.allowedOrigins ?? []),
	]);
}

function acceptClient(
	ws: WebSocket,
	acceptsToken: (key: string) => boolean,
	bridge: DotBridge,
	onAuth: (key: string) => void,
	onDisconnect: () => void,
	mobileKey: (key: string) => string | undefined,
	syncWork?: { handle(key: string, message: WorkSyncRequest): Promise<WorkSyncReply>; meetingDrafts: boolean; limits?: { audioBytes: number; attachmentBytes: number } },
): void {
	let seq = 0;
	let clientKey: string | undefined;
	let detach: (() => void) | undefined;
	const client: BridgeClient = {
		send(payload) {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...payload, seq: ++seq }));
		},
	};
	const helloTimer = setTimeout(() => ws.close(CloseCode.unauthorized, "hello required"), HELLO_TIMEOUT_MS);

	ws.on("message", (data) => {
		if (clientKey !== undefined && !acceptsToken(clientKey)) {
			ws.close(CloseCode.unauthorized, "device revoked");
			return;
		}
		const message = parseClientMessage(String(data));
		if (!detach) {
			clearTimeout(helloTimer);
			if (message?.type !== "hello" || !acceptsToken(message.token)) {
				ws.close(CloseCode.unauthorized, "unauthorized");
				return;
			}
			if (message.protocol !== PROTOCOL_VERSION) {
				ws.close(CloseCode.badProtocol, "unsupported protocol");
				return;
			}
			clientKey = message.token;
			client.mobileKey = mobileKey(message.token);
			if (syncWork) client.workSync = { handle: request => syncWork.handle(message.token, request), meetingDrafts: syncWork.meetingDrafts, ...(syncWork.limits ? { limits: syncWork.limits } : {}) };
			onAuth(message.token);
			detach = bridge.attach(client);
			return;
		}
		if (!message) {
			client.send({
				type: "error",
				code: "bad_message",
				message: "The app sent a message the assistant did not understand.",
			});
			return;
		}
		void bridge.handle(client, message as ClientMessage);
	});
	ws.on("close", () => {
		clearTimeout(helloTimer);
		detach?.();
		onDisconnect();
	});
}

function sameToken(given: string, expected: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `POST /upload` (S31.2): one file per request, the raw bytes as the body, its name in
 * `X-File-Name` (URI-encoded), and `X-Upload-Id` to add it to the message folder of an earlier
 * file. The same access key and Origin rules as the WebSocket: the key only in
 * `Authorization: Bearer`, never in the address.
 */
async function handleUpload(
	req: IncomingMessage,
	res: ServerResponse,
	acceptsToken: (key: string) => boolean,
	origins: Set<string>,
	uploads: UploadStore,
	orchestrator?: Orchestrator,
): Promise<void> {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	const refuse = (status: number, code: string, message: string) => {
		// The rest of the body is discarded, never stored.
		res.setHeader("Connection", "close");
		reply(res, status, { code, message });
		req.resume();
	};
	const origin = req.headers.origin;
	if (origin !== undefined && !origins.has(origin))
		return refuse(403, "forbidden", "This page may not upload.");
	if (origin !== undefined) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
	}
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Methods": "POST",
			"Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Upload-Id, X-Agent-Pane, X-Agent-Session",
			"Access-Control-Max-Age": "600",
		});
		res.end();
		return;
	}
	if (req.method !== "POST") return refuse(405, "method_not_allowed", "Upload files with POST.");
	const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
	if (!bearer || !acceptsToken(bearer)) return refuse(401, "unauthorized", "The access key is not valid.");
	let name: string;
	try {
		name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
	} catch {
		name = "";
	}
	if (name.trim() === "") return refuse(400, "bad_request", "The file has no name.");
	const uploadId = req.headers["x-upload-id"];
	if (uploadId !== undefined && (typeof uploadId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(uploadId))) {
		return refuse(400, "bad_request", "That upload is not valid.");
	}
	let owner: string | undefined;
	if (req.headers["x-agent-pane"] !== undefined || req.headers["x-agent-session"] !== undefined) {
		try {
			if (!orchestrator) return refuse(409, "unsupported_attachments", "Esta conexión no admite archivos de agentes.");
			const target = await orchestrator.attachmentDestination({ paneId: req.headers["x-agent-pane"], sessionId: req.headers["x-agent-session"] }, bearer, () => acceptsToken(bearer) && !res.destroyed);
			owner = target.owner;
		} catch (error) {
			return refuse(error instanceof OrchestrationError ? error.status : 409, error instanceof OrchestrationError ? error.code : "unavailable", error instanceof Error ? error.message : "La sesión no está disponible.");
		}
	}
	const declared = Number(req.headers["content-length"]);
	const outcome = await uploads.receive(req, {
		name,
		...(owner ? { owner } : {}),
		authorize: () => acceptsToken(bearer) && !res.destroyed,
		...(uploadId ? { uploadId } : {}),
		...(Number.isFinite(declared) && req.headers["content-length"] !== undefined ? { length: declared } : {}),
	});
	if (!outcome.ok) return refuse(outcome.status, outcome.code, outcome.message);
	reply(res, 200, outcome.file);
}

function reply(res: ServerResponse, status: number, body: object): void {
	if (res.headersSent || res.destroyed) return;
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function handleHttp(req: IncomingMessage, res: ServerResponse, uiDir: string, bridge: DotBridge): void {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405).end();
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/health") {
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ ok: true, agentState: bridge.agentState }));
		return;
	}
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		res.writeHead(400).end();
		return;
	}
	const root = resolve(uiDir);
	const target = resolve(root, `.${pathname}`);
	if (target !== root && !target.startsWith(root + sep)) {
		res.writeHead(403).end();
		return;
	}
	const file = existsSync(target) && statSync(target).isFile() ? target : join(root, "index.html");
	if (!existsSync(file)) {
		res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("The interface is not built yet. Run `pnpm build`.");
		return;
	}
	const isIndex = file.endsWith("index.html");
	res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
		"Cache-Control": isIndex ? "no-store" : "public, max-age=3600",
	});
	res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}
