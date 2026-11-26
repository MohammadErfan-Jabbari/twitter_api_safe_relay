// Runs the real x-cli command against the mock page, with its own relay and browser on fixed local ports.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockX } from "./mock-x.ts";

// X_CLI_TEST_PORT_BASE moves the three ports, so two checkouts can run the suite side by side.
const base = Number(process.env.X_CLI_TEST_PORT_BASE ?? 9355);
export const ports = { mock: base, relay: base + 1, browser: base + 2 };

const bin = fileURLToPath(new URL("../../bin/x-cli", import.meta.url));

// The ct0 of the leaky account: a value that must never reach output or logs
export const leakyCt0 = "ct0-canary-5f1e2d";

export type Run = { code: number; json: any; ms: number; stdout: string };

export const startHarness = async (overrides: { timeouts?: Record<string, number> } = {}) => {
	const mock = await startMockX(ports.mock);
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-cli-test-"));
	const timeouts = {
		browserStartMs: 15_000,
		navigationMs: 10_000,
		startupMs: 3_000,
		dispatchMs: 3_000,
		relayStartMs: 15_000,
		...overrides.timeouts,
	};
	const config = {
		stateDir,
		relay: { host: "127.0.0.1", port: ports.relay },
		browser: { port: ports.browser, homeUrl: `${mock.url}/home` },
		timeouts,
		idleMs: 5 * 60_000,
		pacing: { writeIntervalMs: 400 },
		accounts: {
			personal: { cookieEnv: "XT_PERSONAL", screenName: "mock_personal" },
			pro: { cookieEnv: "XT_PRO", screenName: "mock_pro" },
			// Personal's cookies, but configured to be pro
			imposter: { cookieEnv: "XT_PERSONAL", screenName: "mock_pro" },
			ghost: { cookieEnv: "XT_GHOST" },
			dead: { cookieEnv: "XT_PERSONAL", homeUrl: `${mock.url}/dead` },
			slow: { cookieEnv: "XT_SLOW" },
			locked: { cookieEnv: "XT_LOCKED" },
			flaggy: { cookieEnv: "XT_PRO" },
			basic: { cookieEnv: "XT_BASIC" },
			leaky: { cookieEnv: "XT_LEAKY" },
		},
	};
	const configFile = path.join(stateDir, "config.json");
	fs.writeFileSync(configFile, JSON.stringify(config));
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		X_CLI_CONFIG: configFile,
		XT_PERSONAL_AUTH_TOKEN: "tok-personal",
		XT_PERSONAL_CT0: "ct0-personal",
		XT_PRO_AUTH_TOKEN: "tok-pro",
		XT_PRO_CT0: "ct0-pro",
		XT_SLOW_AUTH_TOKEN: "hang",
		XT_SLOW_CT0: "ct0",
		XT_LOCKED_AUTH_TOKEN: "challenge",
		XT_LOCKED_CT0: "ct0",
		XT_BASIC_AUTH_TOKEN: "basic",
		XT_BASIC_CT0: "ct0",
		XT_LEAKY_AUTH_TOKEN: "overloaded",
		XT_LEAKY_CT0: leakyCt0,
	};

	const run = (...args: string[]) =>
		new Promise<Run>((resolve) => {
			const started = Date.now();
			execFile(bin, args, { env, timeout: 120_000 }, (error, stdout) => {
				let json: any;
				try {
					json = JSON.parse(stdout);
				} catch {
					json = undefined;
				}
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code, json, ms: Date.now() - started, stdout });
			});
		});

	const relay = (route: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${ports.relay}${route}`, init);

	// The browser on the test port, and the relay if it still answers on its test port
	const ours = async () => {
		const browsers = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
			.split("\n")
			.filter((line) => line.includes("moli") && line.includes(`--port ${ports.browser}`));
		const relayUp = await relay("/health").then(
			() => true,
			() => false,
		);
		return relayUp ? [...browsers, `relay on ${ports.relay}`] : browsers;
	};

	const stop = async () => {
		await run("stop");
		await mock.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	};

	return { mock, run, relay, ours, stop, stateDir, timeouts };
};
