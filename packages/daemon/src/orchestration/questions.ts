import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { OrchestrationError, record } from "./herdr.ts";

/** Opaque revision of the exact serialized dialog, checked again inside Pi. */
export function questionRevision(question: Record<string, unknown>): string {
	const serialized = JSON.stringify(question);
	if (Buffer.byteLength(serialized) > 65_536) throw new OrchestrationError("QUESTION_CHANGED", "La solicitud no puede verificarse.");
	return createHash("sha256").update(serialized).digest("hex");
}

/** Adapter-owned metadata only: generic UI titles/tool names never confer authority. */
export function humanOnlyQuestion(question: unknown): boolean {
	if (!record(question)) return true;
	const permission = question.workflowPermission;
	if (!record(permission) || permission.provider !== "dot-session/v1") return true;
	const workspace = permission.category === "workspace-tool" &&
		permission.scope === "project-workspace" &&
		["read", "edit", "write", "bash"].includes(String(permission.tool)) &&
		question.kind === "confirm";
	const review = permission.category === "native-review-consent" && question.kind === "select";
	if (!workspace && !review) return true;
	// Eligibility is adapter-owned. Titles, filenames and preview contents are data,
	// never authority and never an incidental-word veto on the user's instruction.
	try { return Buffer.byteLength(JSON.stringify(question)) > 65_536; } catch { return true; }
}

export interface RemoteQuestion {
	kind: "confirm" | "select" | "input" | "questionnaire" | "editor" | "custom";
	requiresConfirmation?: true;
	options?: Array<{ id: string; label: string; description?: string; effect?: string; consequence?: string }>;
	placeholder?: string;
	questions?: Array<{
		id: string;
		question: string;
		header?: string;
		multiSelect: boolean;
		options: Array<{ label: string; description?: string; preview?: string }>;
	}>;
}

/** Keep the authored prompt intact. Oversize/unknown dialogs stay in their native UI. */
export function questionDetails(question: Record<string, unknown>): RemoteQuestion | undefined {
	if (Buffer.byteLength(JSON.stringify(question)) > 65_536) return;
	if (!["confirm", "select", "input", "questionnaire", "editor", "custom"].includes(String(question.kind)))
		return;
	if (
		typeof question.title !== "string" ||
		(question.message !== undefined && typeof question.message !== "string")
	)
		return;
	const result: RemoteQuestion = { kind: question.kind as RemoteQuestion["kind"] };
	if (question.kind === "select") {
		if (!Array.isArray(question.options) || !question.options.length || question.options.length > 128) return;
		const options: NonNullable<RemoteQuestion["options"]> = [];
		for (const option of question.options) {
			if (!record(option) || typeof option.id !== "string" || !option.id || typeof option.label !== "string")
				return;
			const descriptions: { description?: string; effect?: string; consequence?: string } = {};
			for (const key of ["description", "effect", "consequence"] as const) {
				if (option[key] !== undefined && typeof option[key] !== "string") return;
				if (typeof option[key] === "string") descriptions[key] = option[key];
			}
			options.push({ id: option.id, label: option.label, ...descriptions });
		}
		if (new Set(options.map((option) => option.id)).size !== options.length) return;
		result.options = options;
		// Display-only brake: never project an opaque provider consent capability.
		if (question.requiresConfirmation === true || "consentBinding" in question ||
			(record(question.workflowPermission) && question.workflowPermission.category === "native-review-consent") ||
			/(?:review|rdd)[-_ ]consent/i.test(String(question.action ?? "")) ||
			String(question.message ?? "").includes("gentle-ai.review-integration.consent/") ||
			options.some(option => option.description || option.effect || option.consequence || /(?:effect|consequence|efecto|consecuencia)\s*:/i.test(option.label)))
			result.requiresConfirmation = true;
	}
	if (question.kind === "input" && question.placeholder !== undefined) {
		if (typeof question.placeholder !== "string") return;
		result.placeholder = question.placeholder;
	}
	if (question.kind === "questionnaire") {
		if (!Array.isArray(question.questions) || question.questions.length < 1 || question.questions.length > 4)
			return;
		const questions: NonNullable<RemoteQuestion["questions"]> = [];
		for (const item of question.questions) {
			if (
				!record(item) ||
				typeof item.id !== "string" ||
				!item.id ||
				typeof item.question !== "string" ||
				(item.header !== undefined && typeof item.header !== "string") ||
				(item.multiSelect !== undefined && typeof item.multiSelect !== "boolean") ||
				!Array.isArray(item.options) ||
				item.options.length < 2 ||
				item.options.length > 4
			)
				return;
			const options: NonNullable<RemoteQuestion["questions"]>[number]["options"] = [];
			for (const option of item.options) {
				if (
					!record(option) ||
					typeof option.label !== "string" ||
					(option.description !== undefined && typeof option.description !== "string") ||
					(option.preview !== undefined && typeof option.preview !== "string")
				)
					return;
				options.push({
					label: option.label,
					...(typeof option.description === "string" ? { description: option.description } : {}),
					...(typeof option.preview === "string" ? { preview: option.preview } : {}),
				});
			}
			questions.push({
				id: item.id,
				question: item.question,
				multiSelect: item.multiSelect === true,
				...(typeof item.header === "string" ? { header: item.header } : {}),
				options,
			});
		}
		if (new Set(questions.map((item) => item.id)).size !== questions.length) return;
		result.questions = questions;
	}
	return result;
}

export function canAnswerQuestion(
	managed: boolean,
	question: Record<string, unknown>,
	capabilities?: unknown,
): boolean {
	const details = questionDetails(question);
	if (!details || question.answerable !== true) return false;
	if (
		typeof question.expiresAt === "string" &&
		question.expiresAt &&
		(!Number.isFinite(Date.parse(question.expiresAt)) || Date.parse(question.expiresAt) <= Date.now())
	)
		return false;
	if (managed) return ["confirm", "select", "input", "editor", "questionnaire"].includes(details.kind);
	// Legacy HERDR has an explicit cooperative questionnaire transport; native dialogs have no resolver.
	return details.kind === "questionnaire" && record(capabilities) && capabilities.questions === true;
}

/** Project only a concrete response, never semantic guesses or arbitrary native result objects. */
export function questionAnswer(
	question: Record<string, unknown>,
	input: Record<string, unknown>,
): Record<string, unknown> {
	const details = questionDetails(question);
	const invalid = () =>
		new OrchestrationError(
			"INVALID_ANSWER",
			"La respuesta no corresponde a las opciones de esta solicitud.",
			400,
		);
	if (!details) throw invalid();
	const responseKeys = ["approved", "confirmed", "optionId", "text", "answers"];
	if (input.cancelled === true) {
		if (responseKeys.some((key) => input[key] !== undefined)) throw invalid();
		return { cancelled: true };
	}
	if (input.cancelled !== undefined && input.cancelled !== false) throw invalid();
	const allowed =
		details.kind === "confirm"
			? ["approved", "confirmed"]
			: details.kind === "select"
				? ["optionId"]
				: details.kind === "input" || details.kind === "editor"
					? ["text"]
					: ["answers"];
	if (responseKeys.some((key) => input[key] !== undefined && !allowed.includes(key))) throw invalid();
	if (details.kind === "confirm") {
		if (input.approved !== undefined && input.confirmed !== undefined) throw invalid();
		const confirmed = input.approved ?? input.confirmed;
		if (typeof confirmed !== "boolean") throw invalid();
		return { confirmed };
	}
	if (details.kind === "select") {
		if (
			typeof input.optionId !== "string" ||
			!details.options?.some((option) => option.id === input.optionId)
		)
			throw invalid();
		return { optionId: input.optionId };
	}
	if (details.kind === "input" || details.kind === "editor") {
		if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 65_536 || input.text.includes("\0"))
			throw invalid();
		return { text: input.text };
	}
	if (
		details.kind !== "questionnaire" ||
		!details.questions ||
		!Array.isArray(input.answers) ||
		input.answers.length !== details.questions.length
	)
		throw invalid();
	const submitted = input.answers;
	if (
		submitted.some((item) => !record(item) || typeof item.questionId !== "string") ||
		new Set(submitted.map((item) => item.questionId)).size !== submitted.length
	)
		throw invalid();
	const answers = details.questions.map((item) => {
		const value = submitted.find((answer) => answer.questionId === item.id);
		if (!record(value)) throw invalid();
		const indices = value.optionIndices ?? [];
		if (
			!Array.isArray(indices) ||
			indices.some((index) => !Number.isInteger(index) || index < 0 || index >= item.options.length) ||
			new Set(indices).size !== indices.length ||
			(!item.multiSelect && indices.length > 1)
		)
			throw invalid();
		if (
			value.text !== undefined &&
			(typeof value.text !== "string" || !value.text.trim() || value.text.length > 16_384 || value.text.includes("\0"))
		)
			throw invalid();
		if (
			value.text !== undefined
				? !item.multiSelect && indices.length !== 0
				: item.multiSelect
					? indices.length < 1
					: indices.length !== 1
		)
			throw invalid();
		return {
			questionId: item.id,
			optionIndices: [...indices],
			...(typeof value.text === "string" ? { text: value.text } : {}),
		};
	});
	if (Buffer.byteLength(JSON.stringify(answers)) > 65_536) throw invalid();
	return { answers };
}

export interface NativeQuestion {
	tool: "ask_user_question" | "ask_user_choice";
	details: Record<string, unknown>;
	/** Produces only the installed first-party dialog's original result shape. */
	result: (response: Record<string, unknown>) => unknown;
}

/** Match SDK source metadata to the installed, version-pinned first-party implementation. */
// Reviewed Gentle Shell builds add answer-capture instrumentation without changing
// the native dialog/result contract. Pin each exact source; a matching name alone
// must never grant a custom extension access to the remote answer resolver.
const COMPATIBLE_NATIVE_SOURCES: Record<string, readonly string[]> = {
	ask_user_question: ["dee4d94935fcd269753195f38af5c744141d276a96102afb9c8fcbd260091517"],
	ask_user_choice: ["d843a6e93dabdcc04701d7d06c615d59c0cd1650737c683e7d1b9bc3c52af6e6"],
};

export function isNativeQuestionSource(tool: string, path: unknown): boolean {
	if (!["ask_user_question", "ask_user_choice"].includes(tool) || typeof path !== "string") return false;
	try {
		const expected = createRequire(import.meta.url).resolve(
			`gentle-pi/extensions/${tool.replaceAll("_", "-")}.ts`,
		);
		if (realpathSync(path) === realpathSync(expected)) return true;
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 128 * 1024) return false;
		// A global installation may be another copy of the identical packaged extension.
		const source = readFileSync(path);
		return source.equals(readFileSync(expected)) ||
			(COMPATIBLE_NATIVE_SOURCES[tool]?.includes(createHash("sha256").update(source).digest("hex")) ?? false);
	} catch {
		return false;
	}
}

/** Narrow adapter for Gentle Pi's first-party forms, never a generic ui.custom responder. */
export function nativeQuestion(tool: string, args: unknown): NativeQuestion | undefined {
	if (!["ask_user_question", "ask_user_choice"].includes(tool) || !record(args)) return;
	try {
		if (Buffer.byteLength(JSON.stringify(args)) > 65_536) return;
		const source: Record<string, unknown> = JSON.parse(JSON.stringify(args));
		const choice = tool === "ask_user_choice";
		if (
			choice &&
			(typeof source.question !== "string" ||
				(source.allowCustomResponse !== undefined && typeof source.allowCustomResponse !== "boolean"))
		)
			return;
		const raw = choice ? [{ question: source.question, options: source.options }] : source.questions;
		if (!Array.isArray(raw)) return;
		const details: Record<string, unknown> = {
			kind: "questionnaire",
			title: choice ? source.question : "Tu sesión necesita una respuesta",
			questions: raw.map((item, index) => (record(item) ? { ...item, id: String(index) } : item)),
		};
		const normalized = questionDetails(details);
		if (!normalized?.questions) return;
		const questions = normalized.questions;
		const options = choice && Array.isArray(source.options) ? source.options : [];
		if (choice && options.some((option) => !record(option) || typeof option.value !== "string")) return;
		const closedChoice = choice && source.allowCustomResponse !== true;
		const view = closedChoice
			? {
					kind: "select",
					title: source.question,
					...(options.some(option => record(option) && (option.description || option.effect || option.consequence)) ? { requiresConfirmation: true } : {}),
					options: questions[0]?.options.map((option, index) => ({
						id: String(index),
						label: `${option.label}${option.description ? ` — ${option.description}` : ""}`,
					})),
				}
			: { ...details, questions };
		if (!questionDetails(view)) return;
		return {
			tool: tool as NativeQuestion["tool"],
			details: view,
			result(response) {
				if (response.cancelled) return choice ? undefined : { cancelled: true, answers: [] };
				if (closedChoice) {
					const index = Number(response.optionId);
					const option = options[index];
					if (!record(option))
						throw new OrchestrationError("INVALID_ANSWER", "La opción ya no está disponible.");
					return { value: option.value, label: option.label, index: index + 1 };
				}
				const answers = Array.isArray(response.answers) ? response.answers.filter(record) : [];
				if (choice) {
					const answer = answers[0];
					if (typeof answer?.text === "string") return { customResponse: answer.text };
					const index = Array.isArray(answer?.optionIndices) ? Number(answer.optionIndices[0]) : -1;
					const option = options[index];
					if (!record(option))
						throw new OrchestrationError("INVALID_ANSWER", "La opción ya no está disponible.");
					return { value: option.value, label: option.label, index: index + 1 };
				}
				return {
					cancelled: false,
					answers: questions.map((question, questionIndex) => {
						const answer = answers.find((entry) => entry.questionId === question.id);
						const base = { questionIndex, question: question.question };
						const indices = Array.isArray(answer?.optionIndices) ? answer.optionIndices : [];
						if (typeof answer?.text === "string") return {
							...base,
							kind: "custom",
							answer: answer.text,
							...(question.multiSelect && indices.length > 0 ? {
								selected: question.options.filter((_option, index) => indices.includes(index)).map((option) => option.label),
							} : {}),
						};
						if (question.multiSelect)
							return {
								...base,
								kind: "multi",
								answer: null,
								selected: question.options
									.filter((_option, index) => indices.includes(index))
									.map((option) => option.label),
							};
						const option = question.options[Number(indices[0])];
						if (!option) throw new OrchestrationError("INVALID_ANSWER", "La opción ya no está disponible.");
						return {
							...base,
							kind: "option",
							answer: option.label,
							...(option.preview !== undefined ? { preview: option.preview } : {}),
						};
					}),
				};
			},
		};
	} catch {
		return;
	}
}
