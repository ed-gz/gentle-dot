const [scenario] = process.argv.slice(2);
if (scenario === "error") process.exit(1);
const delay = scenario === "slow" ? 900 : scenario === "delayed" ? 350 : 0;
setTimeout(() => {
	process.stdout.write(scenario === "false" ? "(false,)\n" : scenario === "invalid" ? "true\n" : "(true,)\n");
}, delay);
