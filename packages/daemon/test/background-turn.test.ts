import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { BackgroundTurn } from "../src/extensions/background-turn.ts";

function engine() {
	let sessionId = "first";
	const manager = { getSessionId: () => sessionId };
	return {
		context: () => ({ sessionManager: manager }) as unknown as ExtensionContext,
		switch: () => {
			sessionId = "second";
		},
		manager,
	};
}

it("reserves one turn across fresh contexts while leaving other engines independent", () => {
	const one = engine();
	const two = engine();
	const completion = new BackgroundTurn();
	const workflow = new BackgroundTurn();
	const otherEngine = new BackgroundTurn();
	expect(completion.acquire(one.context())).toBe(true);
	expect(workflow.acquire(one.context())).toBe(false);
	expect(otherEngine.acquire(two.context())).toBe(true);
	expect(Object.keys(one.manager)).toEqual(["getSessionId"]);
	completion.queued();
	expect(completion.awaitingStart).toBe(true);
	completion.started();
	expect(completion.awaitingStart).toBe(false);
	completion.release();
	expect(workflow.acquire(one.context())).toBe(true);
	workflow.release();
	otherEngine.release();
});

it("does not release a newer reservation when an old settlement ACK finishes after human input", () => {
	const one = engine();
	const workflow = new BackgroundTurn();
	const watch = new BackgroundTurn();
	expect(workflow.acquire(one.context())).toBe(true);
	const delayedRelease = workflow.releaseWhenDone();
	workflow.release(); // Human input/session reset releases immediately without awaiting an ACK.
	expect(workflow.acquire(one.context())).toBe(true);
	delayedRelease();
	expect(watch.acquire(one.context())).toBe(false);
	workflow.release();
	expect(watch.acquire(one.context())).toBe(true);
	watch.release();
});

it("does not let a reservation or late release from the old session block or cancel its replacement", () => {
	const one = engine();
	const old = new BackgroundTurn();
	const next = new BackgroundTurn();
	const contender = new BackgroundTurn();
	expect(old.acquire(one.context())).toBe(true);
	one.switch();
	expect(next.acquire(one.context())).toBe(true);
	old.release();
	expect(contender.acquire(one.context())).toBe(false);
	next.release();
	expect(contender.acquire(one.context())).toBe(true);
	contender.release();
});
