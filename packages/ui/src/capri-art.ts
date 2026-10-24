import original from "./assets/capri/atlas.json" with { type: "json" };
import actions from "./assets/capri/capri-motion-actions-v1.json" with { type: "json" };
import context from "./assets/capri/capri-motion-context-v1.json" with { type: "json" };
import friends from "./assets/capri/friends-atlas-v2.json" with { type: "json" };
import reactions from "./assets/capri/reactions-atlas.json" with { type: "json" };

const ORIGINAL_POSES = [
	"idle",
	"greeting",
	"typing",
	"thinking",
	"reading",
	"lounging",
	"success",
	"alert",
	"eyes",
	"eyes-blink",
	"face",
	"face-talk",
	"point-left",
	"point-right",
	"sleep",
	"peek",
] as const;
export const REACTION_POSES = [
	"crying",
	"working",
	"stressed",
	"angry",
	"coffee",
	"chill",
	"stretch",
	"sleepy-coffee",
	"victory",
	"confused",
	"hacker",
	"snack",
] as const;
export const FRIEND_POSES = [
	"rebecca-wave",
	"rebecca-coffee",
	"rebecca-work",
	"rebecca-cheer",
	"invite-rebecca",
	"duo-watch",
	"duo-coffee",
	"duo-couch",
	"duo-high-five",
	"duo-debug",
	"duo-laugh",
	"duo-sleep",
] as const;
export const CONTEXT_POSES = [
	"headphones",
	"dancing",
	"capture",
	"follow-message",
	"file-away",
	"perch",
	"step-aside",
] as const;
export const CAPRI_POSES = [...ORIGINAL_POSES, ...REACTION_POSES, ...FRIEND_POSES, ...CONTEXT_POSES] as const;
export type CapriPose = (typeof CAPRI_POSES)[number];
export const POSE_LABELS: Record<CapriPose, string> = {
	idle: "Aquí contigo",
	greeting: "Hola",
	typing: "Escribiendo",
	thinking: "Pensando",
	reading: "Leyendo",
	lounging: "En el sillón",
	success: "Listo",
	alert: "Necesito tu respuesta",
	eyes: "Ojos",
	"eyes-blink": "Parpadeo",
	face: "Rostro",
	"face-talk": "Hablando",
	"point-left": "Señalando a la izquierda",
	"point-right": "Señalando a la derecha",
	sleep: "Descansando",
	peek: "Asomándose",
	crying: "Llorando",
	working: "A darle",
	stressed: "Demasiadas pestañas",
	angry: "Enojada",
	coffee: "Tazota de café",
	chill: "Chilleando",
	stretch: "Una estirada",
	"sleepy-coffee": "Otro cafecito",
	victory: "Lo logramos",
	confused: "A ver, a ver…",
	hacker: "Mood hacker",
	snack: "Pausa para botanear",
	"rebecca-wave": "Llegó Rebecca",
	"rebecca-coffee": "El café de Rebecca",
	"rebecca-work": "Rebecca trabajando",
	"rebecca-cheer": "Rebecca celebra",
	"invite-rebecca": "Ven, Rebecca",
	"duo-watch": "Viendo las sesiones",
	"duo-coffee": "Café para dos",
	"duo-couch": "Sillón compartido",
	"duo-high-five": "Chócalas",
	"duo-debug": "Dos cabezas, un bug",
	"duo-laugh": "Entre risas",
	"duo-sleep": "Descanso juntas",
	headphones: "Escuchando música",
	dancing: "Siguiendo el ritmo",
	capture: "Preparando una captura",
	"follow-message": "Siguiendo tu mensaje",
	"file-away": "Guardando el archivo",
	perch: "Aquí mientras escribes",
	"step-aside": "Te dejo espacio",
};
type Sheet = {
	width: number;
	height: number;
	frames: Record<string, { x: number; y: number; width: number; height: number; clip?: number[][] }>;
};
const sheets = [
	{ data: original as Sheet, href: new URL("./assets/capri/capri-atlas-v2.png", import.meta.url).href },
	{ data: reactions as Sheet, href: new URL("./assets/capri/reactions-atlas-v1.png", import.meta.url).href },
	{ data: friends as Sheet, href: new URL("./assets/capri/friends-atlas-v2.png", import.meta.url).href },
	{
		data: context as Sheet,
		href: new URL("./assets/capri/capri-motion-context-v1.png", import.meta.url).href,
	},
	{
		data: actions as Sheet,
		href: new URL("./assets/capri/capri-motion-actions-v1.png", import.meta.url).href,
	},
];
export function capriFrame(pose: CapriPose) {
	const sheet = sheets.find(({ data }) => data.frames[pose]) ?? sheets[0]!;
	const frame: Sheet["frames"][string] = sheet.data.frames[pose] ?? original.frames.idle;
	return { frame, ...sheet };
}
