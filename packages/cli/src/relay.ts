// The relay x-cli talks to: a local HTTP server that owns the browser. It mounts only these routes, so the
// only requests that reach X are the registry's operations. It holds no timer against X; its one timer stops
// the browser and exits after a quiet spell.
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import type { Config } from "./config.ts";
import { httpStatusOf, toXCliError, XCliError } from "./errors.ts";
import type { Clock } from "./pacing.ts";
import { findOperation } from "./registry.ts";
import { createSessions } from "./session.ts";

const fail = (c: Context, error: unknown) => {
	const typed = toXCliError(error);
	return c.json({ ok: false, error: typed.toJSON() }, httpStatusOf(typed.type) as 400);
};

// With one account a missing x-profile-name is unambiguous. With several, the relay never guesses.
const accountOf = (c: Context, config: Config) => {
	const names = Object.keys(config.accounts);
	const header = c.req.header("x-profile-name");
	if (header === undefined) {
		if (names.length === 1) {
			return names[0]!;
		}
		throw new XCliError("missing_account", "Name the account in the x-profile-name header", { available: names });
	}
	if (!names.includes(header)) {
		throw new XCliError("unknown_account", `Unknown account: ${header}`, { available: names });
	}
	return header;
};

export const createRelay = (config: Config, options: { clock?: Clock; env?: NodeJS.ProcessEnv } = {}) => {
	const sessions = createSessions(config, options);
	const app = new Hono();

	// A web page can rebind its own domain to 127.0.0.1 and then call the relay; its requests still carry that
	// domain as Host, so the relay answers only requests addressed to itself.
	const ownHosts = new Set([`127.0.0.1:${config.relay.port}`, `localhost:${config.relay.port}`]);
	app.use(async (c, next) => {
		const host = c.req.header("host")?.toLowerCase() ?? "";
		if (!ownHosts.has(host)) {
			return fail(
				c,
				new XCliError("forbidden_host", "The relay answers only requests to 127.0.0.1 or localhost", { host }),
			);
		}
		await next();
	});

	app.get("/health", (c) =>
		c.json({ ok: true, service: "x-cli-relay", pid: process.pid, browser: sessions.status() ?? null }),
	);

	app.post("/v1/health", async (c) => {
		try {
			return c.json({ ok: true, result: await sessions.health(accountOf(c, config)) });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.post("/v1/call", async (c) => {
		try {
			const account = accountOf(c, config);
			const body = (await c.req.json().catch(() => undefined)) as { op?: unknown; args?: unknown } | undefined;
			const name = typeof body?.op === "string" ? body.op : "";
			// Refused before any browser starts or any request leaves
			if (!findOperation(name)) {
				throw new XCliError("unknown_operation", `Not in the registry: ${name || "(none)"}`);
			}
			return c.json({ ok: true, result: await sessions.call(account, name, body?.args ?? {}) });
		} catch (error) {
			return fail(c, error);
		}
	});

	return { app, sessions };
};

export const runRelay = async (config: Config) => {
	const { app, sessions } = createRelay(config);
	let idle: NodeJS.Timeout | undefined;
	let closing = false;

	const shutdown = async (code: number) => {
		if (closing) {
			return;
		}
		closing = true;
		clearTimeout(idle);
		await sessions.stop().catch(() => {});
		server.close();
		process.exit(code);
	};

	const touch = () => {
		clearTimeout(idle);
		idle = setTimeout(() => void shutdown(0), config.idleMs);
	};

	app.post("/v1/stop", (c) => {
		setTimeout(() => void shutdown(0), 50);
		return c.json({ ok: true, result: { stopping: true } });
	});

	const server = serve({
		fetch: async (request, env) => {
			touch();
			try {
				return await app.fetch(request, env);
			} finally {
				touch();
			}
		},
		hostname: config.relay.host,
		port: config.relay.port,
	});
	await new Promise<void>((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	touch();
	process.once("SIGTERM", () => void shutdown(0));
	process.once("SIGINT", () => void shutdown(0));
	return server;
};
