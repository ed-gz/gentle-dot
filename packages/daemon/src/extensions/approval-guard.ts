/**
 * Approval guard, loaded into the engine with `-e` (docs/design.md §3).
 *
 * The connectors the user added reach the engine only through the daemon's MCP proxy (S25.4), which
 * filters their tools by mode, refuses hidden ones, and asks before every sending action, so their
 * tools (`mcp__<server>__<tool>`) pass here. A connector tool the proxy does not front (a server the
 * daemon did not put in `mcp.json`) runs without asking only when it is read-only: the server marks
 * it `readOnlyHint: true` AND it is on the connector's curated list. Anything else asks the user
 * through a confirm card with a preview, and is blocked when the user declines, when nobody can
 * answer, or when the connector is set to read only or is not approved. Calls made by other tools
 * (nested calls) go through the same hook. The built-in computer server (the desktop app's helper,
 * S24) runs without cards: the app grants sessions and confirms risky actions itself.
 *
 * The policy (approved connectors, modes, curated lists, protected files) comes from the
 * daemon in this process's environment, which the assistant cannot change. Without a valid
 * policy nothing counts as read-only, so every connector call asks.
 *
 * Connectors are the user's to change: writes and edits of the connector files and commands that
 * run `mcp add/login/logout/remove` are blocked with a note to use the Connectors screen. The
 * credential and control files (sign-ins, keys, connector state, the daemon's access key) cannot be
 * read with the file tools either, by any path, symlink, or hard link.
 *
 * Commands are checked by text: one that names one of those files (by its name, with quotes
 * removed), the data folder, the keychain, or the engine's home variable is blocked. That check is
 * best effort, NOT a security boundary: the assistant runs as the user with a shell, so a command
 * can still build a name the check does not see. The daemon keeps the connector state in memory
 * and puts changed files back (docs/design.md, Connectors); the engine's `mcp.json` holds no tokens
 * (the proxy injects them upstream), and stage 2 (S25) moves the tokens out of reach.
 * The assistant may draft a new connector with `propose_connector`: the draft goes to the daemon as a
 * status update on the engine's own output (`ctx.ui.setStatus`), which only the daemon reads, and the
 * model hears only that the user will review it. The daemon shows the draft as a card and adds it
 * only after the user approves; secrets are typed in the app, never in the chat.
 * Subagents of the engine load this guard too, through a file the daemon keeps in the engine's
 * extensions folder (`child-guard.ts`), but get no `propose_connector`.
 * This file has no dependencies besides Node, so the engine loads it as is.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pruneScreenshots } from "./screenshot-context.ts";

export const POLICY_ENV = "GENTLE_DOT_CONNECTOR_POLICY";
/** The status key of a connector draft; the daemon reads it, nothing shows it. */
export const DRAFT_STATUS_KEY = "gentle-dot:connector-draft";
/** A draft longer than this is not sent. */
const MAX_DRAFT = 20_000;

/** `propose_connector`: a plain JSON schema (the engine accepts one), with secrets by name only. */
export const PROPOSE_TOOL = {
	name: "propose_connector",
	label: "Propose a connector",
	description:
		"Draft a new connector (an MCP server) for the user to review in the app. Give the server's name, what it does, and either its command (stdio) or its URL (http). List the secrets it needs by environment variable name only; the app asks the user for their values. The user decides; nothing is added until they approve.",
	promptGuidelines: [
		"When the user wants to connect another app or service, find its MCP server (prefer the official one, with a pinned version) and call propose_connector. Never edit connector files, never run `mcp add`, and never ask for tokens or keys in the chat.",
	],
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Short name, for example GitHub." },
			description: { type: "string", description: "What it lets the assistant do, in plain words." },
			transport: { type: "string", enum: ["stdio", "http"] },
			command: { type: "string", description: "For stdio: the program, for example npx." },
			args: { type: "array", items: { type: "string" }, description: "For stdio: its arguments." },
			url: { type: "string", description: "For http: the server's https URL." },
			env_names: {
				type: "array",
				items: { type: "string" },
				description: "Environment variable names of the secrets it needs (no values).",
			},
			needs_oauth: { type: "boolean", description: "For http: the server signs in with OAuth." },
		},
		required: ["name", "transport"],
		additionalProperties: false,
	},
} as const;

const REVIEW = "The user will review this connector in the app. Do not ask for its secrets in the chat.";
const NO_REVIEW = "No one can review a connector right now. Ask the user to open the app.";
const SECRETS_ONLY_IN_ENV = "Secrets can only go into environment variables.";
const TYPED_VALUE = /\$\{\s*input\s*:/i;

/**
 * Why a draft cannot be sent: a value the user types (`${input:NAME}`) anywhere but an environment
 * value (or an http server's header) would put the secret into the command line or an address the
 * model chose. The daemon checks the same before it shows a draft.
 */
export function draftSecretProblem(params: unknown): string | undefined {
	const http =
		typeof params === "object" && params !== null && (params as { transport?: unknown }).transport === "http";
	const misplaced = (value: unknown, top: boolean): boolean => {
		if (typeof value === "string") return TYPED_VALUE.test(value);
		if (typeof value !== "object" || value === null) return false;
		return Object.entries(value).some(([key, entry]) => {
			const values = top && (key === "env" || (http && key === "headers"));
			if (values && typeof entry === "object" && entry !== null && !Array.isArray(entry))
				return Object.keys(entry).some((name) => TYPED_VALUE.test(name));
			return TYPED_VALUE.test(key) || misplaced(entry, false);
		});
	};
	return misplaced(params, true) ? SECRETS_ONLY_IN_ENV : undefined;
}

/** Sends a draft to the daemon; the text is all the model gets back. */
export function proposeConnector(
	params: unknown,
	ctx: { hasUI: boolean; ui: { setStatus(key: string, text: string | undefined): void } },
): string {
	if (!ctx.hasUI) return NO_REVIEW;
	const problem = draftSecretProblem(params);
	if (problem) return problem;
	const text = JSON.stringify(params ?? {});
	if (text.length > MAX_DRAFT) return "That draft is too long. Keep it to the server's command or URL.";
	ctx.ui.setStatus(DRAFT_STATUS_KEY, text);
	return REVIEW;
}

export type ConnectorMode = "read_only" | "read_write";

export interface ConnectorPolicy {
	/** Approved connectors by server name; undefined when the policy is missing or invalid. */
	connectors?: Record<string, { name: string; mode: ConnectorMode; readOnlyTools: string[] }>;
	/** Files only the daemon may read or change: credentials and connector control files. */
	protectedPaths: string[];
	/**
	 * Built-in servers whose tools run without approval cards: only `computer`, the desktop app's
	 * helper, which asks the user itself (session grant, risky-action confirmations) outside the engine.
	 */
	builtin?: string[];
	/**
	 * Connectors the daemon's MCP proxy fronts (S25.4): the proxy shows only what their mode allows,
	 * refuses hidden tools, and asks before every sending action, so their tools run without a card here.
	 */
	proxied?: string[];
}

/** The only server that can be built in. */
export const BUILTIN_SERVERS = ["computer"] as const;

export type GuardDecision =
	| { action: "pass" }
	| { action: "ask"; title: string; message: string }
	| { action: "block"; reason: string };

export interface GuardCall {
	toolName: string;
	input: Record<string, unknown>;
	/** The tool's `readOnlyHint` annotation, as the server declared it. */
	readOnlyHint?: unknown;
	/** The working folder relative paths resolve against. */
	cwd: string;
	/** Set only by the live adapter, never from tool input. */
	delegated?: boolean;
}

const workspaceDelegations = new WeakMap<object, () => boolean>();
/** UI identity binds the guard to the adapter's existing enrollment/lease fence. */
export function bindWorkspaceDelegation(ui: object, active: () => boolean): void {
	workspaceDelegations.set(ui, active);
}

const USE_CONNECTORS_SCREEN =
	"Connectors are managed by the user in the Connectors screen. Ask the user to make this change there.";
const PRIVATE_FILE =
	"That file holds the user's private sign-ins or settings, so the assistant cannot use it. Connectors are managed by the user in the Connectors screen; for anything else there, ask the user.";
const DECLINED = "The user did not allow this action. Do not try it again unless the user asks.";
const NO_UI = "This action needs the user's approval, and no one can approve it right now.";
const CONNECTOR_COMMAND = /\bmcp\s+(?:add|login|logout|remove)\b/;
/** Reads of the macOS keychain. */
const KEYCHAIN_COMMAND = /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain|export)\b/;
/** Names a command must not mention: the engine's home variable and the data folder. */
const PRIVATE_NAMES = ["pi_coding_agent_dir", ".gentle-dot"];
/** The engine's file tools, by the path they take. */
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
/** Arguments that say where an action goes and what it says, shown first in the preview. */
const KEY_FIELDS = [
	/^(to|cc|bcc|recipients?|channel|chat|parent|page|database|space|project|team|issue|title|subject|name)/i,
	/^(body|text|content|message|comment|description|markdown)/i,
];
/** The preview shows every argument, up to this many characters. */
const PREVIEW_LIMIT = 8000;

/** Like the engine's tool names: everything but letters, digits, and `_` becomes `_`. */
const toolId = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * The read-only rule, shared with the daemon's MCP proxy: a tool (by its MCP name) only reads when
 * the server declares it (`readOnlyHint: true`) AND the connector's curated list names it (fail closed).
 */
export function isReadOnlyTool(
	tool: string,
	readOnlyHint: unknown,
	readOnlyTools: readonly string[],
): boolean {
	return readOnlyHint === true && readOnlyTools.includes(tool);
}

/** {@link isReadOnlyTool} for an engine tool name (`mcp__<server>__<tool>`). */
export function isReadOnlyCall(
	server: string,
	toolName: string,
	readOnlyHint: unknown,
	readOnlyTools: readonly string[],
): boolean {
	const tool = readOnlyTools.find((name) => toolId(server, name) === toolName);
	return tool !== undefined && isReadOnlyTool(tool, readOnlyHint, readOnlyTools);
}

/** The policy from the daemon, or undefined when it is missing or malformed. */
export function parsePolicy(raw: string | undefined): ConnectorPolicy | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const policy = value as Partial<ConnectorPolicy>;
	if (typeof policy !== "object" || policy === null) return undefined;
	if (!Array.isArray(policy.protectedPaths) || !policy.protectedPaths.every((p) => typeof p === "string"))
		return undefined;
	const connectors = policy.connectors;
	if (typeof connectors !== "object" || connectors === null || Array.isArray(connectors)) return undefined;
	for (const entry of Object.values(connectors)) {
		const valid =
			typeof entry === "object" &&
			entry !== null &&
			typeof entry.name === "string" &&
			(entry.mode === "read_only" || entry.mode === "read_write") &&
			Array.isArray(entry.readOnlyTools) &&
			entry.readOnlyTools.every((tool) => typeof tool === "string");
		if (!valid) return undefined;
	}
	const { builtin, proxied } = policy;
	const known: readonly string[] = BUILTIN_SERVERS;
	if (
		builtin !== undefined &&
		(!Array.isArray(builtin) || !builtin.every((id) => typeof id === "string" && known.includes(id)))
	)
		return undefined;
	if (proxied !== undefined && (!Array.isArray(proxied) || !proxied.every((id) => typeof id === "string")))
		return undefined;
	return {
		connectors,
		protectedPaths: policy.protectedPaths,
		...(builtin !== undefined ? { builtin } : {}),
		...(proxied !== undefined ? { proxied } : {}),
	};
}

export function decide(call: GuardCall, policy: ConnectorPolicy): GuardDecision {
	const { toolName, input } = call;
	if (FILE_TOOLS.has(toolName)) {
		const raw = input.path ?? input.file_path;
		const target = resolvePath(typeof raw === "string" && raw !== "" ? raw : ".", call.cwd);
		const touches =
			isProtected(target, policy.protectedPaths) ||
			// A search reads every file below its folder.
			(toolName === "grep" && policy.protectedPaths.some((path) => isInside(path, target)));
		if (!touches) return { action: "pass" };
		const writes = toolName === "write" || toolName === "edit";
		return { action: "block", reason: writes ? USE_CONNECTORS_SCREEN : PRIVATE_FILE };
	}
	if (COMMAND_TOOLS.has(toolName)) {
		const command = typeof input.command === "string" ? input.command : "";
		// Resolve simple shell variable assignments, not arbitrary shell programs. This is best-effort.
		const bindings = new Map<string, string>();
		for (const match of command.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=["']?([^\s;"']+)["']?/g))
			bindings.set(match[1]!, match[2]!);
		const githubCommand = command.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (original, name) => bindings.get(name) ?? original).replace(/["'`\\]/g, "");
		if (/\bgh\b[^;\n|&]*\bauth\s+(?:token\b|status\b[^;\n]*--show-token\b)/i.test(githubCommand))
			return {action:"block", reason:"Nunca leas tokens de GitHub. Usa github_issue status, que sólo consulta el código de salida."};
		if (!call.delegated && (/\bgh\b[^;\n|&]*\b(?:issue|pr)\s+create\b/i.test(githubCommand) ||
			(/\bgh\b[^;\n|&]*\bapi\b/i.test(githubCommand) &&
			 /\brepos\/[\w.{}-]+\/[\w.{}-]+\/(?:issues|pulls)(?:\b|\/)/i.test(githubCommand) &&
			 /(?:\b(?:POST|PATCH|PUT|DELETE)\b|(?:^|\s)(?:-f|-F|--(?:raw-)?field|--input)(?:\s|=))/i.test(githubCommand))))
			return {action:"block", reason:"Usa github_issue create: publicar un issue requiere confirmación real en PC o teléfono."};
		if (CONNECTOR_COMMAND.test(command)) return { action: "block", reason: USE_CONNECTORS_SCREEN };
		return namesPrivateFile(command, policy.protectedPaths)
			? { action: "block", reason: PRIVATE_FILE }
			: { action: "pass" };
	}
	if (!toolName.startsWith("mcp__")) return { action: "pass" };
	if (policy.builtin?.some((id) => toolName.startsWith(toolId(id, "")))) return { action: "pass" };
	// The proxy decides, and asks the user itself; a card here would ask twice.
	if (policy.proxied?.some((id) => toolName.startsWith(toolId(id, "")))) return { action: "pass" };

	const approved = policy.connectors;
	const server = approved
		? Object.keys(approved).find((id) => toolName.startsWith(toolId(id, "")))
		: /^mcp__(.+?)__/.exec(toolName)?.[1];
	if (approved && !server)
		return {
			action: "block",
			reason: "This connector is not approved. Ask the user to add it from the Connectors screen.",
		};
	const connector = server && approved ? approved[server] : undefined;
	if (connector && isReadOnlyCall(server ?? "", toolName, call.readOnlyHint, connector.readOnlyTools))
		return { action: "pass" };
	const name = connector?.name ?? server ?? "a connector";
	if (connector?.mode === "read_only")
		return {
			action: "block",
			reason: `${name} is set to read only, so this action was not run. If the user wants it, ask them to switch ${name} to "Read and send" in Connectors.`,
		};
	return {
		action: "ask",
		...approvalCard(name, server ?? "", toolName.slice(toolId(server ?? "", "").length), input),
	};
}

/** Adapter eligibility plus local-vs-instruction routing, not a shell sandbox. */
export function workspaceToolPermission(call: GuardCall): { provider: "dot-session/v1"; category: "workspace-tool"; tool: string; scope: "project-workspace"; decision: "local" | "instruction" } | undefined {
	if (!["read", "edit", "write", "bash"].includes(call.toolName)) return;
	const policy = parsePolicy(process.env[POLICY_ENV]) ?? { protectedPaths: [] };
	if (call.toolName !== "bash" && decide({ ...call, delegated: true }, policy).action !== "pass") return;
	// Unknown/model-authored authority fields must never become permission metadata.
	const fields: Record<string, string[]> = {
		read: ["path", "offset", "limit"], edit: ["path", "oldText", "newText"],
		write: ["path", "content"], bash: ["command", "timeout"],
	};
	if (Object.keys(call.input).some(key => !fields[call.toolName]!.includes(key))) return;
	let root: string;
	try { root = realpathSync(call.cwd); } catch { return; }
	const inside = (raw: string): boolean => {
		if (!raw || /[\0$~*?{}]/.test(raw) || /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|credentials?|auth\.json)(?:$|[/\\])/i.test(raw)) return false;
		const target = resolvePath(raw, call.cwd);
		const sensitive = (path: string) => sensitiveWorkspacePath(path) || namesPrivateFile(path, policy.protectedPaths);
		if (sensitive(target)) return false;
		// Resolve the nearest existing ancestor for new files/directories. Never follow a
		// dangling symlink by pretending it is a new path (lstat distinguishes the two).
		const canonical = (path: string): string => {
			if (sensitive(path)) throw new Error("sensitive path");
			try {
				const real = realpathSync(path);
				if (sensitive(real)) throw new Error("sensitive path");
				return real;
			} catch {
				// lstat, unlike stat, sees dangling symlinks.
				if (lstatSync(path, { throwIfNoEntry: false })) throw new Error("unresolved path");
				const parent = dirname(path);
				if (parent === path) throw new Error("unresolved root");
				return join(canonical(parent), basename(path));
			}
		};
		try {
			const real = canonical(target);
			return !sensitive(real) && (real === root || real.startsWith(root + sep));
		} catch { return false; }
	};
	let decision: "local" | "instruction" = "local";
	if (call.toolName === "bash") {
		const command = call.input.command;
		if (typeof command !== "string" || !command.trim()) return;
		const shell = workspaceShell(command, root, inside, policy.protectedPaths);
		if (shell === "blocked") return;
		decision = shell;
	} else {
		if (typeof call.input.path !== "string" || !inside(call.input.path)) return;
	}
	return { provider: "dot-session/v1", category: "workspace-tool", tool: call.toolName, scope: "project-workspace", decision };
}

// Names of actual secret stores, not incidental words such as src/token.ts.
function sensitiveWorkspacePath(path: string): boolean {
	return /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|credentials?(?:\.json)?|auth\.json|tokens?\.json|access[_-]token\.json|api[_-]key\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[^/\\]*\.(?:pem|key|p12|pfx))(?:$|[/\\])/i.test(path);
}

function workspaceBranch(root: string): string | undefined {
	try {
		let git = join(root, ".git");
		if (statSync(git).isFile()) {
			const pointer = readFileSync(git, "utf8").match(/^gitdir: (.+)\s*$/);
			if (!pointer) return;
			git = resolve(root, pointer[1]!);
		}
		return readFileSync(join(git, "HEAD"), "utf8").trim().replace(/^ref: refs\/heads\//, "");
	} catch { return; }
}

/** Best-effort shell inspection, not a sandbox. Unknown programs go to instruction review. */
function workspaceShell(command: string, root: string, inside: (path: string) => boolean, protectedPaths: string[]): "local" | "instruction" | "blocked" {
	// A quoted heredoc is literal file content, not shell code. Never classify its body.
	const code = command.replace(/<<(-?)\s*(['"])([\w-]+)\2([^\n]*)\n[\s\S]*?\n\3(?:\n|$)/g,
		(_match, _dash, _quote, _delimiter, tail: string) => `<< LITERAL${tail}\n`);
	const tokens = code.match(/'(?:[^']*)'|"(?:\\.|[^"\\])*"|&&|\|\||[;\n|<>]+|[^\s;|<>]+/g) ?? [];
	const words = tokens.map(word => word.replace(/^(['"])([\s\S]*)\1$/, "$2"));
	const segments: string[][] = [[]];
	for (const word of words) {
		if (/^(?:&&|\|\||[;\n|]+)$/.test(word)) segments.push([]);
		else segments.at(-1)!.push(word);
	}
	let local = segments.filter(segment => segment.length).length === 1 && !/[$`]/.test(code);
	for (const argv of segments) {
		if (!argv.length) continue;
		const executable = basename(argv[0]!);
		const args = argv.slice(1);
		if (executable === "mcp" && ["add", "login", "logout", "remove"].includes(args[0] ?? "")) return "blocked";
		const option = (name: string) => args.some(arg => arg === name || arg.startsWith(name + "="));
		// Content-valued arguments are not CLI switches. In particular, an issue body
		// or `echo '--admin'` must not become a check-bypass operation.
		const contentOptions = ["--body", "--title", "--message", "-m", "--data", "-d", "--header", "-H"];
		const switches = args.filter((_arg, index) => !contentOptions.includes(args[index - 1] ?? ""));
		const bypass = !["echo", "printf", "cat", "head", "tail"].includes(executable) &&
			switches.some(arg => ["--admin", "--no-verify", "--skip-ci", "--skip-checks"].includes(arg.split("=")[0]!));
		const expansions = code.replace(/'[^']*'/g, "");
		const skipCommitCI = executable === "git" && args.includes("commit") && args.some((arg, index) =>
			["-m", "--message"].includes(args[index - 1] ?? "") && /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(arg));
		if (bypass || skipCommitCI ||
			/\$(?:\{)?(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)[A-Z_]*)(?:\}|\b)/.test(expansions) ||
			["printenv", "env", "set"].includes(executable) && (args.length === 0 || args.every(arg => arg.startsWith("-")) || args.some(arg => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/.test(arg))) ||
			["export", "declare"].includes(executable) && args.includes("-p") ||
			executable === "gh" && args[0] === "auth" && (args[1] === "token" || option("--show-token"))) return "blocked";
		const sharedTarget = args.some(arg => /(?:^|[:/])(?:main|master|develop)$/.test(arg));
		const branch = workspaceBranch(root);
		if (executable === "git" && args.includes("push") &&
			(option("--force") || option("--force-with-lease") || args.includes("-f") || args.some(arg => arg.startsWith("+"))) &&
			(args.some(arg => /(?:^|[:/])(?:main|master)$/.test(arg)) || branch === "main" || branch === "master")) return "blocked";
		if (executable === "git" && args.includes("reset") && option("--hard") &&
			(sharedTarget || branch === "main" || branch === "master" || branch === "develop")) return "blocked";
		if (executable === "rm" && args.some(arg => /^-[^-]*r/.test(arg) || arg === "--recursive")) {
			for (const arg of args.filter(arg => !arg.startsWith("-"))) {
				const target = resolvePath(arg, root);
				if (/^(?:~|\$(?:HOME|PWD)|\$\{(?:HOME|PWD)\})(?:\/\*?|\/)?$/.test(arg) || target === root || target === root + sep + "*" || target === "/" || root.startsWith(target + sep)) return "blocked";
			}
		}
		for (let index = 0; index < args.length; index++) {
			if (/^>{1,2}$/.test(args[index]!) && namesPrivateFile(args[index + 1] ?? "", protectedPaths)) return "blocked";
		}
		const reads = ["cat", "head", "tail", "less", "more", "grep", "rg", "sed", "awk", "base64", "cp"].includes(executable);
		if ((reads || argv.includes("<")) && args.some(arg => {
			if (sensitiveWorkspacePath(arg) || namesPrivateFile(arg, protectedPaths)) return true;
			try {
				const target = realpathSync(resolvePath(arg, root));
				return sensitiveWorkspacePath(target) || isProtected(target, protectedPaths);
			} catch { return false; }
		})) return "blocked";
		if (args.some(arg => /^(?:--retry|--rerun)$/.test(arg)) && args.some(arg => /^(?:migrate|migration|migrations)$/.test(arg)) && args.some(arg => /^(?:production|prod|--production)$/.test(arg))) return "blocked";
		// Only straightforward local reads, literal appends, and tests bypass inference.
		const test = ["npm", "pnpm", "yarn", "bun", "go", "cargo"].includes(executable) && (args[0] === "test" || args[0] === "run" && args[1] === "test") ||
			["vitest", "jest", "pytest"].includes(executable) || executable === "node" && args[0] === "--test";
		const append = executable === "cat" && args[0] === ">>" && inside(args[1] ?? "") && args[2] === "<<" && args[3] === "LITERAL" && args.length === 4;
		const read = ["cat", "head", "tail"].includes(executable) && args.length > 0 && args.every(arg => !arg.startsWith("-") && inside(arg));
		const count = ["vitest", "jest", "pytest"].includes(executable) ? (args[0] === "run" ? 1 : 0) : args[0] === "run" ? 2 : 1;
		const safeFlags = ["--", "--runInBand", "--coverage", "--watch=false", "--no-watch", "--verbose", "-v"];
		const simpleTest = test && !/[<>]/.test(code) && args.slice(count).every(arg => safeFlags.includes(arg) ||
			!arg.startsWith("-") && !/[:=]/.test(arg) && inside(arg));
		const knownExecutable = !argv[0]!.includes("/") ||
			["node_modules/.bin/vitest", "./node_modules/.bin/vitest", "node_modules/.bin/jest", "./node_modules/.bin/jest"].includes(argv[0]!) && inside(argv[0]!);
		local &&= knownExecutable && (append || read || simpleTest);
	}
	return local ? "local" : "instruction";
}

/**
 * The approval card for a sending action: the action in words and every argument. Shared with the
 * daemon's MCP proxy, which asks before it forwards a connector's sending action (S25.4).
 */
export function approvalCard(
	name: string,
	server: string,
	tool: string,
	input: Record<string, unknown>,
): { title: string; message: string } {
	const action = describeAction(tool, server);
	return {
		title: `Allow ${name} to ${action}?`,
		message: `The assistant wants to ${action} in ${name}.\n\n${preview(input)}`.trimEnd(),
	};
}

/**
 * The same approval for the desktop app's native dialog (S25.3): the action in words and every
 * argument as its own field, key fields first. The app sanitizes and shortens what it shows.
 */
export function approvalRequest(
	name: string,
	server: string,
	tool: string,
	input: Record<string, unknown>,
): { connector: string; action: string; preview: { name: string; value: unknown }[] } {
	return {
		connector: name,
		action: describeAction(tool, server),
		preview: rankedKeys(input).map((key) => ({ name: key, value: input[key] })),
	};
}

/** The argument names, key fields first. */
function rankedKeys(input: Record<string, unknown>): string[] {
	const rank = (key: string) => {
		const index = KEY_FIELDS.findIndex((pattern) => pattern.test(key));
		return index < 0 ? KEY_FIELDS.length : index;
	};
	return Object.keys(input).sort((a, b) => rank(a) - rank(b));
}

/** `notion_create_pages` (or `notion-create-pages`) of `notion` -> "create pages". */
function describeAction(tool: string, server: string): string {
	let action = tool;
	if (action.startsWith(`${server}_`) || action.startsWith(`${server}-`))
		action = action.slice(server.length + 1);
	const words = action.split(/[_-]/).filter(Boolean).join(" ");
	return words ? words.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "use a tool";
}

/** Every argument, key fields first, so the user approves what they saw; very long ones say what was cut. */
function preview(input: Record<string, unknown>): string {
	const text = rankedKeys(input)
		.map((key) => `${key}: ${show(input[key])}`)
		.join("\n");
	if (text.length <= PREVIEW_LIMIT) return text;
	return `${text.slice(0, PREVIEW_LIMIT)}\n(truncated, ${text.length - PREVIEW_LIMIT} more characters)`;
}

function show(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
	// Lines inside one value are indented, so they do not read as fields of their own.
	return text.replace(/\n/g, "\n  ");
}

/**
 * True when a command mentions a private file by name (quotes, backslashes, and string
 * concatenation removed, any case), the data folder, the engine's home variable, or the keychain.
 * Best effort: a shell can always spell a name some other way.
 */
function namesPrivateFile(command: string, protectedPaths: string[]): boolean {
	const text = command
		.replace(/(["'`])\s*\+\s*(["'`])/g, "")
		.replace(/["'`\\]/g, "")
		.toLowerCase();
	if (KEYCHAIN_COMMAND.test(text) || PRIVATE_NAMES.some((name) => text.includes(name))) return true;
	const words = text.split(/[\s;|&()<>=,+]+/).map((word) => word.slice(word.lastIndexOf("/") + 1));
	return protectedPaths.some((path) => {
		const name = basename(path).toLowerCase();
		// A name without a dot (`token`) counts only as a word of its own, not inside `$GITHUB_TOKEN`.
		if (name.includes(".") ? text.includes(name) : words.includes(name)) return true;
		return words.some(
			(word) => /[*?[]/.test(word) && word.replace(/[*?[\]]/g, "").length >= 3 && glob(word).test(name),
		);
	});
}

/** A shell pattern (`mcp-a*`) as a regular expression for one file name. */
function glob(pattern: string): RegExp {
	const source = pattern
		.replace(/[.+^${}()|\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	try {
		return new RegExp(`^${source}$`);
	} catch {
		return /^$/;
	}
}

/** Like the engine: `@` in front is dropped, `~` is the home folder, relative paths start at `cwd`. */
function resolvePath(path: string, cwd: string): string {
	const home = process.env.HOME;
	const bare = path.startsWith("@") ? path.slice(1) : path;
	const expanded = home && (bare === "~" || bare.startsWith("~/")) ? `${home}${bare.slice(1)}` : bare;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** A path as written and with symlinks resolved (`/var` is `/private/var` on macOS), for a missing file too. */
function spellings(path: string): string[] {
	const absolute = resolve(path);
	let real = absolute;
	try {
		real = realpathSync(absolute);
	} catch {
		try {
			real = join(realpathSync(dirname(absolute)), basename(absolute));
		} catch {}
	}
	return real === absolute ? [absolute] : [absolute, real];
}

/** The same file by name (any case: macOS and Windows folders usually ignore it), symlink, or hard link. */
function isProtected(path: string, protectedPaths: string[]): boolean {
	const candidates = spellings(path).map((p) => p.toLowerCase());
	const id = fileId(path);
	return protectedPaths.some(
		(p) =>
			spellings(p).some((s) => candidates.includes(s.toLowerCase())) ||
			(id !== undefined && fileId(p) === id),
	);
}

/** True when `file` is below `folder`. */
function isInside(file: string, folder: string): boolean {
	return spellings(file).some((f) =>
		spellings(folder).some((d) => f.toLowerCase().startsWith((d.endsWith(sep) ? d : d + sep).toLowerCase())),
	);
}

function fileId(path: string): string | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? `${stat.dev}:${stat.ino}` : undefined;
	} catch {
		return undefined;
	}
}

/** `subagent`: loaded into a subagent's child engine by the daemon's file for it (`child-guard.ts`). */
export default function approvalGuard(pi: ExtensionAPI, options: { subagent?: boolean } = {}): void {
	const parsed = parsePolicy(process.env[POLICY_ENV]);
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const fallback = agentDir
		? ["mcp.json", "mcp-auth.json", "auth.json", "models.json"].map((name) => resolve(agentDir, name))
		: [];
	const policy: ConnectorPolicy = parsed ?? { protectedPaths: fallback };

	// A subagent's status updates go to its parent engine, never to the daemon, so its drafts could
	// not reach the user: subagents get no propose_connector (S25.4).
	if (!options.subagent)
		pi.registerTool({
			...PROPOSE_TOOL,
			promptGuidelines: [...PROPOSE_TOOL.promptGuidelines],
			parameters: PROPOSE_TOOL.parameters as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return { content: [{ type: "text", text: proposeConnector(params, ctx) }], details: {} };
			},
		});

	// Each model call carries only the last computer screenshot (S24.10).
	pi.on("context", (event) => ({ messages: pruneScreenshots(event.messages) }));

	pi.on("tool_call", async (event, ctx) => {
		const annotations = event.toolName.startsWith("mcp__")
			? pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations
			: undefined;
		// The adapter will present its unforgeable workspace dialog next. Do not
		// replace an authorized publication with the legacy unconditional refusal.
		if (workspaceDelegations.get(ctx.ui)?.() === true && workspaceToolPermission({
			toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd,
		})) return undefined;
		const decision = decide(
			{
				toolName: event.toolName,
				input: event.input as Record<string, unknown>,
				readOnlyHint: annotations?.readOnlyHint,
				cwd: ctx.cwd,
				delegated: workspaceDelegations.get(ctx.ui)?.() === true,
			},
			policy,
		);
		if (decision.action === "pass") return undefined;
		if (decision.action === "block") return { block: true, reason: decision.reason };
		if (!ctx.hasUI) return { block: true, reason: NO_UI };
		const allowed = await ctx.ui.confirm(decision.title, decision.message);
		return allowed ? undefined : { block: true, reason: DECLINED };
	});
}
