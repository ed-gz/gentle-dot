import { expect, it } from "vitest";
import { canAnswerQuestion, nativeQuestion, questionAnswer } from "../src/orchestration/questions.ts";

it("accepts literal editor text only for live managed questions, without widening legacy or custom permissions", () => {
	const question = { kind: "editor", title: "Editar", message: "original", answerable: true };
	expect(canAnswerQuestion(true, question)).toBe(true);
	expect(canAnswerQuestion(false, question, { questions: true })).toBe(false);
	expect(canAnswerQuestion(true, { ...question, answerable: false })).toBe(false);
	for (const expiresAt of ["invalid", new Date(Date.now() - 1000).toISOString()])
		expect(canAnswerQuestion(true, { ...question, expiresAt })).toBe(false);
	expect(canAnswerQuestion(true, { ...question, kind: "custom" })).toBe(false);
	for (const text of ["", "  first\nsecond  ", "x".repeat(65_536)])
		expect(questionAnswer(question, { text })).toEqual({ text });
	for (const input of [
		{ approved: true },
		{ optionId: "0" },
		{ text: "bad\0text" },
		{ text: "é".repeat(32_769) },
		{ text: "ok", answers: [] },
		{ text: "ok", cancelled: true },
	])
		expect(() => questionAnswer(question, input)).toThrow();
	expect(questionAnswer(question, { cancelled: true })).toEqual({ cancelled: true });
});

it("does not map unknown custom tools, malformed questions or oversized native forms", () => {
	for (const args of [{}, { questions: [] }, { questions: "not a form" }, { question: "x".repeat(70_000) }])
		expect(nativeQuestion("ask_user_question", args)).toBeUndefined();
	expect(
		nativeQuestion("unrelated_permission", {
			question: "Approve",
			options: [
				{ label: "Yes", value: "yes" },
				{ label: "No", value: "no" },
			],
		}),
	).toBeUndefined();
	expect(
		nativeQuestion("ask_user_choice", { question: "Approve", options: [{ label: "Yes" }, { label: "No" }] }),
	).toBeUndefined();
});

it("preserves original provider tokens while rejecting invented tokens and arbitrary free text", () => {
	const args = {
		question: "¿Continuar?",
		options: [
			{ label: "Permitir", value: "original-allow" },
			{ label: "Cancelar", value: "original-decline" },
		],
	};
	const form = nativeQuestion("ask_user_choice", args);
	if (!form) throw new Error("Missing native form");
	const firstOption = args.options[0];
	if (!firstOption) throw new Error("Missing first option");
	firstOption.value = "mutated-token";
	firstOption.label = "Texto cambiado";
	expect(form.result(questionAnswer(form.details, { optionId: "0" }))).toEqual({
		value: "original-allow",
		label: "Permitir",
		index: 1,
	});
	expect(() => questionAnswer(form.details, { optionId: "original-allow" })).toThrow();
	expect(() => questionAnswer(form.details, { text: "yes" })).toThrow();
	expect(form.result(questionAnswer(form.details, { cancelled: true }))).toBeUndefined();
});

it("preserves native multi-select choices alongside custom text and rejects empty selections", () => {
	const form = nativeQuestion("ask_user_question", {
		questions: [
			{ question: "Ambientes", multiSelect: true, options: [{ label: "Local" }, { label: "Pruebas" }] },
		],
	});
	if (!form) throw new Error("Missing native form");
	for (const answer of [
		{ questionId: "0", optionIndices: [] },
		{ questionId: "0", optionIndices: [0], text: "bad\0text" },
	])
		expect(() => questionAnswer(form.details, { answers: [answer] })).toThrow();
	const custom = questionAnswer(form.details, { answers: [{ questionId: "0", text: "Sólo documentación" }] });
	expect(form.result(custom)).toEqual({
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Ambientes", kind: "custom", answer: "Sólo documentación" }],
	});
	expect(form.result(questionAnswer(form.details, {
		answers: [{ questionId: "0", optionIndices: [1, 0], text: "Y documentación" }],
	}))).toEqual({
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Ambientes", kind: "custom", answer: "Y documentación", selected: ["Local", "Pruebas"] }],
	});
});

it("keeps single-select text exclusive of an option", () => {
	const form = nativeQuestion("ask_user_question", {
		questions: [{ question: "Destino", options: [{ label: "Local" }, { label: "Pruebas" }] }],
	});
	if (!form) throw new Error("Missing native form");
	expect(() => questionAnswer(form.details, { answers: [{ questionId: "0", optionIndices: [0], text: "Ambos" }] })).toThrow();
});

it("recognizes the reviewed answer-capture build without allowing arbitrary source modifications", async () => {
	const { createRequire } = await import("node:module");
	const { readFileSync, writeFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tempDir } = await import("./helpers.ts");
	const { isNativeQuestionSource } = await import("../src/orchestration/questions.ts");
	const root = tempDir();
	try {
		for (const tool of ["ask_user_choice", "ask_user_question"]) {
			const original = createRequire(import.meta.url).resolve(`gentle-pi/extensions/${tool.replaceAll("_", "-")}.ts`);
			let source = readFileSync(original, "utf8");
			if (tool === "ask_user_choice") source = source
				.replace('import { NativeChoiceList }', 'import { captureChoiceAnswer } from "../lib/auto-permission-answers.ts";\nimport { NativeChoiceList }')
				.replace('async execute(_toolCallId, params: ChoiceParams, _signal, _onUpdate, ctx) {', 'async execute(_toolCallId, params: ChoiceParams, _signal, _onUpdate, ctx) {\n\t\t\tconst captureAnswer = captureChoiceAnswer(ctx, _toolCallId, params, _signal);')
				.replace('\t\t\t\treturn choiceToolResult(params, rpcSelection);', '\t\t\t\tcaptureAnswer(rpcSelection);\n\t\t\t\treturn choiceToolResult(params, rpcSelection);')
				.replace('\t\t\treturn choiceToolResult(params, selection);', '\t\t\tcaptureAnswer(selection);\n\t\t\treturn choiceToolResult(params, selection);');
			else source = source
				.replace('import { createNativeFullscreenInteraction }', 'import { captureQuestionnaireAnswers } from "../lib/auto-permission-answers.ts";\nimport { createNativeFullscreenInteraction }')
				.replace('\t\t\tif (error) return invalidQuestionnaireResult(error);', '\t\t\tif (error) return invalidQuestionnaireResult(error);\n\t\t\tconst captureAnswers = captureQuestionnaireAnswers(ctx, _toolCallId, params, _signal);')
				.replace('\t\t\t\t\treturn await askThroughDialogs(ctx, params);', '\t\t\t\t\tconst result = await askThroughDialogs(ctx, params);\n\t\t\t\t\tif (!result.details.cancelled) captureAnswers(result.details.answers);\n\t\t\t\t\treturn result;')
				.replace('\t\t\treturn {\n\t\t\t\tcontent: [{ type: "text", text: answersText(selection.answers) }]', '\t\t\tcaptureAnswers(selection.answers);\n\t\t\treturn {\n\t\t\t\tcontent: [{ type: "text", text: answersText(selection.answers) }]');
			const copy = join(root, `${tool}.ts`);
			writeFileSync(copy, source);
			expect(isNativeQuestionSource(tool, copy)).toBe(true);
			writeFileSync(copy, `${source}\n// Unknown build`);
			expect(isNativeQuestionSource(tool, copy)).toBe(false);
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("requires installed first-party source metadata, not a tool title or copied name", async () => {
	const { createRequire } = await import("node:module");
	const { writeFileSync, rmSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tempDir } = await import("./helpers.ts");
	const { isNativeQuestionSource } = await import("../src/orchestration/questions.ts");
	const original = createRequire(import.meta.url).resolve("gentle-pi/extensions/ask-user-choice.ts");
	expect(isNativeQuestionSource("ask_user_choice", original)).toBe(true);
	expect(isNativeQuestionSource("ask_user_question", original)).toBe(false);
	expect(isNativeQuestionSource("ask_user_choice", undefined)).toBe(false);
	const root = tempDir();
	try {
		const fake = join(root, "ask-user-choice.ts");
		writeFileSync(fake, "export default function() { /* same displayed title, different callback */ }");
		expect(isNativeQuestionSource("ask_user_choice", fake)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
