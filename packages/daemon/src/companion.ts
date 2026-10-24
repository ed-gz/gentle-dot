import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "./private-file.ts";

export type CompanionMode = "gentle" | "capri";

/** A product preference, never an authority or a change to the external shells. */
export class CompanionPreference {
	private readonly file: string;
	private mode: CompanionMode = "gentle";
	constructor(dataDir: string) {
		this.file = join(dataDir, "companion.json");
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8"));
			if (saved?.mode === "capri") this.mode = "capri";
		} catch {
			/* Missing or invalid preferences keep the original assistant. */
		}
	}
	read() {
		return { mode: this.mode };
	}
	set(mode: CompanionMode) {
		writePrivateFile(this.file, JSON.stringify({ mode }));
		this.mode = mode;
		return this.read();
	}
}
