import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { XCliError } from "./errors.ts";

const account = z
	.object({
		// Prefix of the two environment variables holding the session cookies: <prefix>_AUTH_TOKEN and <prefix>_CT0
		cookieEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
		// The screen name this account must be signed in as. Kept out of the repository, in the local config file.
		screenName: z.string().optional(),
		homeUrl: z.url().optional(),
	})
	.strict();

const schema = z
	.object({
		stateDir: z.string(),
		relay: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).strict(),
		browser: z
			.object({
				moliPath: z.string(),
				port: z.number().int().min(1).max(65535),
				homeUrl: z.url(),
				extraArgs: z.array(z.string()),
			})
			.strict(),
		timeouts: z
			.object({
				browserStartMs: z.number().int().positive(),
				navigationMs: z.number().int().positive(),
				startupMs: z.number().int().positive(),
				dispatchMs: z.number().int().positive(),
				relayStartMs: z.number().int().positive(),
			})
			.strict(),
		// The relay stops its browser and exits after this long without a request
		idleMs: z.number().int().positive(),
		pacing: z
			.object({
				requestIntervalMs: z.number().int().nonnegative(),
				searchIntervalMs: z.number().int().nonnegative(),
				writeIntervalMs: z.number().int().nonnegative(),
				cooldownMs: z.number().int().nonnegative(),
				flaggedCooldownMs: z.number().int().nonnegative(),
				maxWaitMs: z.number().int().nonnegative(),
			})
			.strict(),
		accounts: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), account),
	})
	.strict();

export type Config = z.infer<typeof schema>;
export type AccountConfig = z.infer<typeof account>;

const home = os.homedir();

export const defaultConfig: Config = {
	stateDir: path.join(home, ".local", "state", "x-relay"),
	relay: { host: "127.0.0.1", port: 9360 },
	browser: {
		moliPath: path.join(home, ".local", "bin", "moli"),
		port: 9361,
		homeUrl: "https://x.com/home",
		extraArgs: [],
	},
	timeouts: {
		browserStartMs: 15_000,
		navigationMs: 30_000,
		startupMs: 20_000,
		dispatchMs: 30_000,
		relayStartMs: 10_000,
	},
	idleMs: 10 * 60_000,
	pacing: {
		// The request limiter of transitive-bullshit/bird 0.7.1: 100 ms between requests, 5 s between searches,
		// 15 minutes after a 429.
		requestIntervalMs: 100,
		searchIntervalMs: 5_000,
		cooldownMs: 15 * 60_000,
		// Writes are where X looks for automation (error 226), and a person managing lists takes seconds per step.
		writeIntervalMs: 10_000,
		// After 226, 326 or 344 the account stays quiet for an hour.
		flaggedCooldownMs: 60 * 60_000,
		// A wait longer than this fails fast with rate_limited instead of holding the command.
		maxWaitMs: 30_000,
	},
	accounts: {
		personal: { cookieEnv: "X_PERSONAL" },
		pro: { cookieEnv: "X_PRO" },
	},
};

export const configPath = (env: NodeJS.ProcessEnv = process.env) =>
	env.X_CLI_CONFIG ?? path.join(home, ".config", "x-relay", "config.json");

// The file may set any subset; nested objects merge over the defaults, and accounts merge by name.
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
	const file = configPath(env);
	let partial: Record<string, any> = {};
	if (fs.existsSync(file)) {
		try {
			partial = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (error) {
			throw new XCliError("usage", `Cannot read config ${file}: ${(error as Error).message}`);
		}
	}
	const merged = {
		...defaultConfig,
		...partial,
		relay: { ...defaultConfig.relay, ...partial.relay },
		browser: { ...defaultConfig.browser, ...partial.browser },
		timeouts: { ...defaultConfig.timeouts, ...partial.timeouts },
		pacing: { ...defaultConfig.pacing, ...partial.pacing },
		accounts: Object.fromEntries(
			Object.entries({ ...defaultConfig.accounts, ...partial.accounts }).map(([name, value]) => [
				name,
				{ ...(defaultConfig.accounts[name] ?? {}), ...(value as object) },
			]),
		),
	};
	const parsed = schema.safeParse(merged);
	if (!parsed.success) {
		throw new XCliError("usage", `Invalid config ${file}: ${parsed.error.message}`);
	}
	return parsed.data;
};

export const accountDir = (config: Config, name: string) => path.join(config.stateDir, name);
