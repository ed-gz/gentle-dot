import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	loggingBehavior: "none",
	appId: "dev.gentledot.mobile",
	appName: "Gentle Dot",
	webDir: "dist",
	plugins: { SystemBars: { style: "DARK" } },
	android: { backgroundColor: "#101114" },
	server: { androidScheme: "https" },
};
export default config;
