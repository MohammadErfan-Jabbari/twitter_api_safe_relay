// The command's side: send one request to the local relay, starting the relay first if it is not running.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { isErrorType, XCliError } from "./errors.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const relayUrl = (config: Config) => `http://${config.relay.host}:${config.relay.port}`;

const relayUp = (config: Config) =>
	fetch(`${relayUrl(config)}/health`, { signal: AbortSignal.timeout(1_000) }).then(
		(r) => r.ok,
		() => false,
	);

const startRelay = async (config: Config) => {
	fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
	const log = path.join(config.stateDir, "relay.log");
	const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
	const child = spawn(process.execPath, [...process.execArgv, cli, "serve"], {
		detached: true,
		stdio: ["ignore", fs.openSync(log, "a"), fs.openSync(log, "a")],
		env: process.env,
	});
	child.unref();
	const deadline = Date.now() + config.timeouts.relayStartMs;
	while (Date.now() < deadline) {
		if (await relayUp(config)) {
			return;
		}
		await sleep(100);
	}
	throw new XCliError("relay_unreachable", `The relay did not start within ${config.timeouts.relayStartMs} ms`, {
		log,
	});
};

// Long enough for a cold start plus one paced request; the relay's own deadlines fire first.
const requestTimeoutOf = (config: Config) => {
	const t = config.timeouts;
	return t.browserStartMs + t.navigationMs + t.startupMs + 2 * t.dispatchMs + config.pacing.maxWaitMs + 10_000;
};

export const relayRequest = async (
	config: Config,
	route: string,
	options: { account?: string; body?: unknown; spawnRelay?: boolean } = {},
) => {
	const send = () =>
		fetch(`${relayUrl(config)}${route}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(options.account ? { "x-profile-name": options.account } : {}),
			},
			body: JSON.stringify(options.body ?? {}),
			signal: AbortSignal.timeout(requestTimeoutOf(config)),
		});
	let response: Response;
	try {
		response = await send();
	} catch (error) {
		if ((error as Error).name === "TimeoutError") {
			throw new XCliError("timeout", "The relay did not answer in time", { step: "relay" });
		}
		if (options.spawnRelay === false) {
			throw new XCliError("relay_unreachable", `No relay at ${relayUrl(config)}`);
		}
		await startRelay(config);
		response = await send();
	}
	const body = (await response.json().catch(() => undefined)) as
		| { ok: true; result: any }
		| { ok: false; error: { type: string; message: string } }
		| undefined;
	if (!body) {
		throw new XCliError("relay_unreachable", `The relay answered ${response.status} without JSON`);
	}
	if (!body.ok) {
		const { type, message, ...details } = body.error;
		throw new XCliError(isErrorType(type) ? type : "internal", message, details);
	}
	return body.result;
};

export const stopRelay = async (config: Config) => {
	if (!(await relayUp(config))) {
		return { stopped: false, running: false };
	}
	await relayRequest(config, "/v1/stop", { spawnRelay: false });
	for (let i = 0; i < 50 && (await relayUp(config)); i++) {
		await sleep(100);
	}
	return { stopped: true, running: await relayUp(config) };
};
