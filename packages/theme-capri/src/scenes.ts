import type { AgentState, CompanionActivityKind } from "@gentle-dot/protocol";
import type { CapriPose } from "./art.ts";

export type CompanionCompany = "visits" | "capri" | "rebecca" | "duo";
export type CompanionAmbience = "default" | "hacker" | "afterlife" | "sunset";
export type CompanionInteraction = CompanionActivityKind;

export function sceneForActivity(input: {
	state: AgentState;
	connected: boolean;
	attention: boolean;
	sessions: boolean;
	interaction: CompanionInteraction;
	company: CompanionCompany;
	phase: number;
	scene: "auto" | CapriPose;
	celebrate: boolean;
	musicPlaying?: boolean;
	activitySequence?: number;
}): CapriPose {
	const { state, connected, attention, sessions, interaction, company, phase, scene, celebrate } = input;
	if (!connected) return "sleep";
	if (attention) return "alert";
	const visiting = company === "duo" || (company === "visits" && phase % 10 >= 3 && phase % 10 <= 7);
	const rebecca = company === "rebecca";
	if (state === "error") return visiting ? "duo-debug" : rebecca ? "rebecca-work" : "crying";
	if (interaction === "failed") return "confused";
	if (interaction === "sending" || interaction === "queued") return "peek";
	if (interaction === "submitted") return "follow-message";
	if (interaction === "response") return phase % 2 ? "coffee" : "reading";
	if (interaction === "typing") {
		const variation = ((input.activitySequence ?? 0) + phase) % 4;
		return (["typing", "eyes", "peek", visiting ? "duo-watch" : "typing"] as const)[variation]!;
	}
	if (celebrate) return visiting ? "duo-high-five" : rebecca ? "rebecca-cheer" : "victory";
	if (interaction === "greeting")
		return company === "duo" ? "invite-rebecca" : rebecca ? "rebecca-wave" : "greeting";
	if (
		!input.musicPlaying &&
		visiting &&
		((company === "visits" && phase % 10 === 3) || (company === "duo" && phase === 0))
	)
		return "invite-rebecca";
	const visitPhase = Math.max(0, company === "duo" ? phase - 1 : (phase % 10) - 4);
	if (state === "working" || state === "thinking") {
		if (visiting) return (["duo-watch", "duo-coffee", "duo-debug"] as const)[visitPhase % 3]!;
		if (rebecca) return phase % 3 === 1 ? "rebecca-coffee" : "rebecca-work";
		return sessions
			? (["coffee", "reading", "sleepy-coffee"] as const)[phase % 3]!
			: (["working", "hacker", "thinking", "stressed"] as const)[phase % 4]!;
	}
	if (input.musicPlaying) return phase % 3 === 1 ? "dancing" : "headphones";
	if (scene !== "auto") return scene;
	if (visiting)
		return (["duo-watch", "duo-coffee", "duo-couch", "duo-laugh", "duo-sleep"] as const)[visitPhase % 5]!;
	if (rebecca) return (["rebecca-coffee", "rebecca-wave", "rebecca-work"] as const)[phase % 3]!;
	if (interaction === "reading") return (["reading", "lounging", "coffee", "peek"] as const)[phase % 4]!;
	// Faces and eyes alternate with full-body scenes. Detached pointing hands need an actual target,
	// so they never appear as an ambient pose. The person never has to direct
	// a pose, and Rebecca's visit remains an ordered invitation/watch/coffee/rest sequence.
	const slot = phase % 10;
	const solo = Math.floor(phase / 10) * 5 + (slot <= 2 ? slot : slot - 5);
	return sessions
		? (
				[
					"coffee",
					"chill",
					"lounging",
					"eyes",
					"confused",
					"reading",
					"snack",
					"stretch",
					"face",
					"peek",
				] as const
			)[solo % 10]!
		: (
				[
					"idle",
					"coffee",
					"stretch",
					"eyes",
					"peek",
					"chill",
					"snack",
					"sleepy-coffee",
					"face",
					"reading",
				] as const
			)[solo % 10]!;
}

export function sceneCaption(pose: CapriPose): string {
	const captions: Partial<Record<CapriPose, string>> = {
		crying: "Algo falló. Lo revisamos paso a paso.",
		working: "Manos a la obra.",
		stressed: "Una cosa a la vez. Respiramos.",
		angry: "Ese bug y yo tenemos asuntos pendientes.",
		coffee: "Tazota lista. A ver esas sesiones.",
		headphones: "Hay música. Me quedo al ritmo.",
		dancing: "Esta pide un pasito.",
		capture: "Captura guardada.",
		"follow-message": "Va en camino. Sigo contigo.",
		chill: "Yo pongo el chill.",
		stretch: "Pausa para estirarnos.",
		"sleepy-coffee": "A este café le falta otro café.",
		victory: "Terminó el turno. Chócalas.",
		confused: "A ver… desenredemos esto.",
		hacker: "¿Nos ponemos en mood hacker?",
		snack: "La botana también es parte del proceso.",
		"rebecca-wave": "Rebecca se apunta.",
		"rebecca-coffee": "Rebecca trajo su propio café.",
		"rebecca-work": "Rebecca está al pendiente.",
		"rebecca-cheer": "Rebecca aprueba ese avance.",
		"invite-rebecca": "Rebecca, ven a ver esto conmigo.",
		"duo-watch": "Primera fila para ver las sesiones.",
		"duo-coffee": "Dos tazas. Cero prisas.",
		"duo-couch": "Hicimos espacio en el sillón.",
		"duo-high-five": "¡Eso! Chócalas.",
		"duo-debug": "Dos cabezas para ese detalle.",
		"duo-laugh": "Un ratito de buen humor.",
		"duo-sleep": "Descansamos por aquí.",
	};
	return captions[pose] ?? "Aquí, cuando me necesites.";
}
