import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/components/Composer.tsx";
import { useAttachments } from "../../src/useAttachments.ts";
import type { Uploader } from "../../src/uploads.ts";
import "../../src/orchestration.css";
import "../../src/mobile-navigation.css";
import "../../src/styles.css";

const mobile = new URLSearchParams(location.search).has("mobile");
if (mobile) await import("../../../../apps/mobile/src/mobile.css");

// Real compositor/hook/CSS; only the upload destination and agent are deterministic stand-ins.
const upload: Uploader = async (file) => ({
	uploadId: "u_composerfixture01",
	name: file.name,
	size: file.size,
	mime: file.type,
	path: `uploads/u_composerfixture01/${file.name}`,
});

function Fixture() {
	const [busy, setBusy] = useState(false);
	const [events, setEvents] = useState<unknown[]>([]);
	const attachments = useAttachments(upload);
	return (
		<div className={mobile ? "mobile-shell" : undefined} style={mobile ? undefined : { height: "100%" }}>
			<div className={`chat chat-web${mobile ? " chat-mobile" : ""}`}>
				<main className="chat-body chat-transcript">
					<output aria-label="Sent events">{JSON.stringify(events)}</output>
				</main>
				<div className="chat-composer">
			<Composer busy={busy} disabled={false} mobile={mobile} attachments={attachments}
				send={(message) => {
					setEvents((current) => [...current, message]);
					setBusy(message.type === "send");
					return true;
				}} />
				</div>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
