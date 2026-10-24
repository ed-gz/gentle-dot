// Minimal real child for supervisor failure tests; never contacts a model or reads credentials.
import { createInterface } from "node:readline";

if (process.env.FAKE_LIFECYCLE_MODE === "exit") process.exit(1);
const stubborn = process.env.FAKE_LIFECYCLE_MODE === "stubborn";
if (stubborn) {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 10_000);
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const record = JSON.parse(line) as { id: string; type: string };
	process.stdout.write(
		`${JSON.stringify({
			type: "response",
			id: record.id,
			command: record.type,
			success: true,
			data: { sessionId: "lifecycle-test", isStreaming: false },
		})}\n`,
	);
});
input.on("close", () => {
	if (!stubborn) process.exit(0);
});
