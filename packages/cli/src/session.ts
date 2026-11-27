// One account's browser at a time. A call names its account; if another account's browser is up, it is stopped
// first. Every step has a deadline, and a failure comes back as a typed error instead of a hang.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Browser, chromium, type Page, type Response } from "playwright";
import { createTwitterBrowser, type TwitterApiProfileClient } from "twitter-api-safe-request";
import { installAnimationSampling } from "./animations.ts";
import { accountDir, type Config } from "./config.ts";
import { XCliError } from "./errors.ts";
import { AccountLimiter, type Clock, cooldownFromResponse, realClock } from "./pacing.ts";
import { type OperationDefinition, pageStateOf, readOperationsInPage } from "./page.ts";
import { findOperation, type Operation, parseArguments } from "./registry.ts";

type Slot = {
	account: string;
	moli: ChildProcess;
	exited: boolean;
	browser: Browser;
	page: Page;
	client: TwitterApiProfileClient;
	operations: Map<string, OperationDefinition>;
	screenName: string | undefined;
	verifiedAt: number;
	// Set after a timeout: the page may be wedged, so the next call starts a fresh browser.
	stale: boolean;
};

type Outcome =
	| { ok: true; value: any }
	| { ok: false; error: { message: string; status?: number; codes: number[]; data?: unknown } };

const FLAGGED_CODES = new Set([226, 326, 344]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withDeadline = async <T>(promise: Promise<T>, ms: number, onTimeout: () => Promise<XCliError>): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	const expired = Symbol("expired");
	const result = await Promise.race([
		promise,
		new Promise<typeof expired>((resolve) => {
			timer = setTimeout(() => resolve(expired), ms);
		}),
	]).finally(() => clearTimeout(timer));
	if (result === expired) {
		promise.catch(() => {});
		throw await onTimeout();
	}
	return result as T;
};

// The X web app sends to https://x.com/i/api/... and, for some REST calls, to https://api.x.com/...
const apiPathOf = (url: string) => {
	const { pathname } = new URL(url);
	return pathname.startsWith("/i/api/") ? pathname.slice("/i/api".length) : pathname;
};

// X's ApiError message ends with the codes: "… HTTP-200 codes:[214,214]"
const messageCodesOf = (message: string): number[] => {
	const list = message.match(/codes:\[([\d,\s]*)\]/)?.[1] ?? "";
	return list
		.split(",")
		.map((code) => Number(code.trim()))
		.filter((code) => Number.isInteger(code) && code > 0);
};

const errorCodesOf = (value: unknown): number[] => {
	const text = JSON.stringify(value ?? null);
	return Array.from(text.matchAll(/"code":\s*(\d+)/g), (match) => Number(match[1]));
};

// The first object, near the top, that carries a GraphQL data object
const dataIn = (value: any, depth = 0): { data: unknown; errors?: unknown } | undefined => {
	if (value === null || typeof value !== "object" || depth > 3) {
		return undefined;
	}
	if (value.data !== null && typeof value.data === "object" && !Array.isArray(value.data)) {
		return { data: value.data, errors: value.errors };
	}
	for (const child of Object.values(value)) {
		const found = dataIn(child, depth + 1);
		if (found) {
			return found;
		}
	}
	return undefined;
};

const tail = (file: string) => {
	try {
		return fs.readFileSync(file, "utf8").split("\n").slice(-5).join("\n");
	} catch {
		return "";
	}
};

export type Sessions = ReturnType<typeof createSessions>;

// What X's refusal of an operation means, from the HTTP status, X's error codes and its first message
export const refusalOf = (
	name: string,
	operation: Operation,
	status: number | undefined,
	codes: number[],
	message: string,
): XCliError => {
	if (operation.premium && (status === 403 || /premium|subscri|blue|verified/i.test(message))) {
		return new XCliError("premium_required", "Bookmark folders need X Premium on this account", { status, message });
	}
	// On an endpoint that always exists, X's "page does not exist" means it refused the request's
	// x-client-transaction-id, which the page computes from a paused animation (src/animations.ts)
	if (operation.signatureChecked && status === 404 && codes.includes(34)) {
		return new XCliError("signature_rejected", `X refused the page's request signature on ${name}`, { status, codes });
	}
	return new XCliError("x_error", `X refused ${name}: ${message}`, { status, codes });
};

export const createSessions = (config: Config, options: { clock?: Clock; env?: NodeJS.ProcessEnv } = {}) => {
	const clock = options.clock ?? realClock;
	const env = options.env ?? process.env;
	const limiters = new Map<string, AccountLimiter>();
	let slot: Slot | undefined;
	// The relay serves one call at a time, across accounts: one browser, one request in flight.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const pending = queue.then(task);
		queue = pending.catch(() => {});
		return pending;
	};

	const limiterOf = (account: string) => {
		let limiter = limiters.get(account);
		if (!limiter) {
			limiter = new AccountLimiter(accountDir(config, account), config.pacing, clock);
			limiters.set(account, limiter);
		}
		return limiter;
	};

	const pidFile = path.join(config.stateDir, "moli.pid");

	// A relay that died without stopping its browser leaves the pid file behind.
	const killLeftoverBrowser = () => {
		try {
			const pid = Number(fs.readFileSync(pidFile, "utf8"));
			const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
			if (cmdline.includes("serve") && cmdline.includes(String(config.browser.port))) {
				process.kill(-pid, "SIGKILL");
			}
		} catch {}
		fs.rmSync(pidFile, { force: true });
	};

	const stopSlot = async () => {
		const current = slot;
		slot = undefined;
		if (!current) {
			return;
		}
		await withDeadline(current.browser.close(), 3_000, async () => new XCliError("timeout", "close")).catch(() => {});
		await stopProcess(current.moli);
	};

	const stopProcess = async (moli: ChildProcess) => {
		if (moli.exitCode === null && moli.signalCode === null && moli.pid) {
			const exited = new Promise((resolve) => moli.once("exit", resolve));
			try {
				process.kill(-moli.pid, "SIGTERM");
			} catch {}
			const done = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
			if (!done) {
				try {
					process.kill(-moli.pid, "SIGKILL");
				} catch {}
				await Promise.race([exited, sleep(2_000)]);
			}
		}
		fs.rmSync(pidFile, { force: true });
	};

	const homeUrlOf = (account: string) => config.accounts[account]?.homeUrl ?? config.browser.homeUrl;

	const cookiesOf = (account: string) => {
		const prefix = config.accounts[account]!.cookieEnv;
		const authToken = env[`${prefix}_AUTH_TOKEN`];
		const ct0 = env[`${prefix}_CT0`];
		if (!authToken || !ct0) {
			return undefined;
		}
		const home = new URL(homeUrlOf(account));
		const onX = home.hostname === "x.com" || home.hostname.endsWith(".x.com");
		// On x.com the cookies cover api.x.com too; a local test page gets them for its own origin.
		const target = onX
			? { domain: ".x.com", path: "/", secure: true }
			: { domain: home.hostname, path: "/", secure: home.protocol === "https:" };
		const expires = Math.floor(Date.now() / 1000) + 365 * 86400;
		return [
			// SameSite=None needs Secure, which a plain-http test page cannot give
			{
				name: "auth_token",
				value: authToken,
				httpOnly: true,
				sameSite: onX ? ("None" as const) : ("Lax" as const),
				expires,
				...target,
			},
			{ name: "ct0", value: ct0, httpOnly: false, sameSite: "Lax" as const, expires, ...target },
		];
	};

	const pageFailure = async (page: Page, fallback: XCliError, cookies: "set" | "missing") => {
		const state = pageStateOf(page.url());
		if (state === "logged_out") {
			return new XCliError("logged_out", "X shows the login page: the session cookies are missing or expired", {
				url: page.url(),
				cookies,
			});
		}
		if (state === "challenge") {
			return new XCliError("challenge", "X shows a challenge or lock page instead of the app", { url: page.url() });
		}
		return fallback;
	};

	const startSlot = async (account: string): Promise<Slot> => {
		killLeftoverBrowser();
		const dir = accountDir(config, account);
		const profileDir = path.join(dir, "profile");
		fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(dir, 0o700);
		const log = path.join(dir, "browser.log");
		const port = config.browser.port;
		const moli = spawn(
			config.browser.moliPath,
			["serve", "--host", "127.0.0.1", "--port", String(port), "-P", profileDir, ...config.browser.extraArgs],
			{ detached: true, stdio: ["ignore", fs.openSync(log, "a"), fs.openSync(log, "a")] },
		);
		const spawnError = new Promise<Error>((resolve) => moli.once("error", resolve));
		let exited = false;
		moli.once("exit", () => {
			exited = true;
			if (slot?.moli === moli) {
				slot.exited = true;
			}
		});
		if (moli.pid) {
			fs.writeFileSync(pidFile, String(moli.pid), { mode: 0o600 });
		}
		let browser: Browser | undefined;
		try {
			const endpoint = `http://127.0.0.1:${port}`;
			const deadline = Date.now() + config.timeouts.browserStartMs;
			while (true) {
				const failed = await Promise.race([spawnError, sleep(0).then(() => undefined)]);
				if (failed || exited) {
					throw new XCliError("browser_down", `The browser did not start: ${failed?.message ?? "it exited"}`, {
						log: tail(log),
					});
				}
				const up = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) }).then(
					(r) => r.ok,
					() => false,
				);
				if (up) {
					break;
				}
				if (Date.now() > deadline) {
					throw new XCliError("timeout", `The browser did not answer within ${config.timeouts.browserStartMs} ms`, {
						step: "browser_start",
					});
				}
				await sleep(150);
			}
			browser = await chromium.connectOverCDP(endpoint, { timeout: config.timeouts.browserStartMs });
			const context = browser.contexts()[0] ?? (await browser.newContext());
			const cookies = cookiesOf(account);
			if (cookies) {
				await context.addCookies(cookies);
			}
			const page = context.pages()[0] ?? (await context.newPage());
			await page.addInitScript(installAnimationSampling);
			const client = createTwitterBrowser(page);
			await client.inject();
			const homeUrl = homeUrlOf(account);
			const cookieState = cookies ? "set" : "missing";
			try {
				await page.goto(homeUrl, { waitUntil: "load", timeout: config.timeouts.navigationMs });
			} catch (error) {
				throw await pageFailure(
					page,
					new XCliError("timeout", `X's page did not load within ${config.timeouts.navigationMs} ms`, {
						step: "navigation",
						cause: (error as Error).message.split("\n")[0],
					}),
					cookieState,
				);
			}
			const early = await pageFailure(page, new XCliError("internal", "app"), cookieState);
			if (early.type !== "internal") {
				throw early;
			}
			await withDeadline(client.waitStartup(), config.timeouts.startupMs, () =>
				pageFailure(
					page,
					new XCliError("client_not_found", `X's API client did not appear within ${config.timeouts.startupMs} ms`, {
						url: page.url(),
					}),
					cookieState,
				),
			);
			const operations = new Map((await page.evaluate(readOperationsInPage)).map((d) => [d.operationName, d]));
			return {
				account,
				moli,
				exited,
				browser,
				page,
				client,
				operations,
				screenName: undefined,
				verifiedAt: 0,
				stale: false,
			};
		} catch (error) {
			await browser?.close().catch(() => {});
			await stopProcess(moli);
			throw error;
		}
	};

	const ensureSlot = async (account: string) => {
		if (slot && (slot.account !== account || slot.exited || slot.stale || !slot.browser.isConnected())) {
			await stopSlot();
		}
		if (!slot) {
			slot = await startSlot(account);
			const expected = config.accounts[account]?.screenName;
			if (expected) {
				const screenName = await readScreenName(slot);
				if (screenName.toLowerCase() !== expected.toLowerCase()) {
					await stopSlot();
					throw new XCliError("wrong_account", `The ${account} session is signed in as another account`, {
						expected,
						actual: screenName,
					});
				}
			}
		}
		return slot;
	};

	const readScreenName = async (current: Slot) => {
		const viewer = (await send(current, "account.viewer", findOperation("account.viewer")!, {})) as {
			screenName: string;
		};
		current.screenName = viewer.screenName;
		current.verifiedAt = Date.now();
		return current.screenName;
	};

	const definitionOf = async (current: Slot, operationName: string) => {
		let definition = current.operations.get(operationName);
		if (!definition) {
			// A feature chunk may have loaded since the page opened.
			for (const d of await current.page.evaluate(readOperationsInPage)) {
				current.operations.set(d.operationName, d);
			}
			definition = current.operations.get(operationName);
		}
		if (!definition) {
			throw new XCliError("operation_not_on_page", `X's page holds no definition for ${operationName}`, {
				operationName,
			});
		}
		return definition;
	};

	// Sends one registry operation through X's own client in the page and classifies what comes back.
	const send = async (current: Slot, name: string, operation: Operation, args: any): Promise<unknown> => {
		const spec = operation.request;
		let property: "graphQLFullResponse" | "dispatch";
		let query: unknown[];
		let path: string;
		if (spec.kind === "graphql") {
			const definition = await definitionOf(current, spec.operationName);
			property = "graphQLFullResponse";
			query = [definition, spec.variables(args)];
			path = `/graphql/${definition.queryId}/${definition.operationName}`;
		} else {
			property = "dispatch";
			path = spec.path;
			const form = spec.form?.(args);
			// X's client form-encodes a POST's data object itself, as the page's own calls rely on
			query = [
				{
					method: spec.method,
					path,
					headers: {},
					...(spec.params ? { params: spec.params } : {}),
					...(form ? { data: form } : {}),
				},
			];
		}
		const limiter = limiterOf(current.account);
		return limiter.run({ write: operation.access === "write", search: Boolean(operation.search) }, async () => {
			let status: number | undefined;
			let headers: Promise<Record<string, string>> = Promise.resolve({});
			let matched: Response | undefined;
			const listener = (response: Response) => {
				if (apiPathOf(response.url()) === path) {
					matched = response;
					status = response.status();
					headers = response.allHeaders().catch(() => ({}));
				}
			};
			current.page.on("response", listener);
			let outcome: Outcome;
			try {
				outcome = await withDeadline(
					current.page.evaluate(
						async ({ property, query }) => {
							try {
								return { ok: true, value: await globalThis.elonmusk_114514_request({ property, query } as any) };
							} catch (error: any) {
								// X's ApiError keeps what it knows in its own properties, enumerable or not, and may hold
								// the request with its x-csrf-token header. Only the error codes and the first GraphQL
								// data object leave the page.
								const codes: number[] = [];
								let data: unknown;
								const visit = (value: any, depth: number) => {
									if (value === null || typeof value !== "object" || depth > 4) {
										return;
									}
									for (const key of Object.getOwnPropertyNames(value)) {
										let child: any;
										try {
											child = value[key];
										} catch {
											continue;
										}
										if (key === "code" && Number.isInteger(child) && child > 0) {
											codes.push(child);
										}
										if (
											key === "data" &&
											data === undefined &&
											child &&
											typeof child === "object" &&
											!Array.isArray(child)
										) {
											data = child;
										}
										visit(child, depth + 1);
									}
								};
								visit(error, 0);
								try {
									data = JSON.parse(JSON.stringify(data ?? null)) ?? undefined;
								} catch {
									data = undefined;
								}
								return {
									ok: false,
									error: {
										message: String(error?.message ?? error),
										status: error?.status ?? error?.response?.status,
										codes,
										data,
									},
								};
							}
						},
						{ property, query },
					) as Promise<Outcome>,
					config.timeouts.dispatchMs,
					async () => {
						current.stale = true;
						if (current.exited || !current.browser.isConnected()) {
							return new XCliError("browser_down", "The browser went away during the request");
						}
						return pageFailure(
							current.page,
							new XCliError("timeout", `X did not answer ${name} within ${config.timeouts.dispatchMs} ms`, {
								step: "dispatch",
								operation: name,
							}),
							"set",
						);
					},
				);
			} catch (error) {
				if (error instanceof XCliError) {
					throw error;
				}
				current.stale = true;
				throw new XCliError(
					"browser_down",
					`The page failed during ${name}: ${(error as Error).message.split("\n")[0]}`,
				);
			} finally {
				current.page.off("response", listener);
			}
			const responseHeaders = await headers;
			const httpStatus = status ?? (outcome.ok ? undefined : outcome.error.status);
			// When X's client throws, the response body on the wire says what X sent.
			const raw = outcome.ok
				? undefined
				: await withDeadline(
						matched ? matched.json().catch(() => undefined) : Promise.resolve(undefined),
						5_000,
						async () => new XCliError("timeout", "response body"),
					).catch(() => undefined);
			// Codes come from everything X sent, before any recovery below
			const codes = outcome.ok
				? errorCodesOf(outcome.value?.errors)
				: [...errorCodesOf(raw?.errors), ...outcome.error.codes, ...messageCodesOf(outcome.error.message)];
			// X's client throws when a successful response also carries errors, such as the lists response's
			// per-list banner errors (code 214). The data is still there, so use it.
			if (!outcome.ok && (httpStatus === undefined || httpStatus < 400)) {
				const recovered = dataIn(raw) ?? dataIn({ data: outcome.error.data });
				if (recovered && Object.keys(recovered.data as object).length > 0) {
					outcome = { ok: true, value: recovered };
				}
			}
			// A failure reports X's error codes, never the objects they came in
			const reported = [...new Set(codes)];
			const flagged = codes.find((code) => FLAGGED_CODES.has(code));
			if (flagged !== undefined) {
				await limiter.coolDown(clock.now() + config.pacing.flaggedCooldownMs, `X error ${flagged}`);
				throw new XCliError("flagged", `X answered error ${flagged}; this account pauses for an hour`, {
					code: flagged,
					status: httpStatus,
					codes: reported,
				});
			}
			const cooldownUntil = cooldownFromResponse(httpStatus, responseHeaders, clock.now(), config.pacing.cooldownMs);
			if (cooldownUntil > 0) {
				await limiter.coolDown(cooldownUntil, httpStatus === 429 ? "429" : "rate limit exhausted");
			}
			if (httpStatus === 429 || codes.includes(88)) {
				throw new XCliError("rate_limited", "X rate-limited this account", {
					retryAt: new Date(Math.max(cooldownUntil, clock.now())).toISOString(),
				});
			}
			const failed = !outcome.ok || (httpStatus !== undefined && httpStatus >= 400);
			const emptyWithErrors = outcome.ok && outcome.value?.errors?.length && !outcome.value?.data;
			if (failed || emptyWithErrors) {
				const message = outcome.ok
					? String(outcome.value.errors[0]?.message ?? "error")
					: outcome.error.message.split("\n")[0]!;
				const state = await pageFailure(current.page, new XCliError("internal", "app"), "set");
				if (state.type !== "internal") {
					current.stale = true;
					throw state;
				}
				if (spec.kind === "graphql" && httpStatus === 404) {
					// X no longer accepts this query ID; reload the page so the next call reads the current one.
					current.stale = true;
				}
				throw refusalOf(name, operation, httpStatus, reported, message);
			}
			return operation.extract((outcome as { value: unknown }).value, args);
		});
	};

	const call = (account: string, name: string, rawArgs: unknown) =>
		serial(async () => {
			const operation = findOperation(name);
			if (!operation) {
				throw new XCliError("unknown_operation", `Not in the registry: ${name}`);
			}
			const args = parseArguments(name, operation, rawArgs);
			const current = await ensureSlot(account);
			return send(current, name, operation, args);
		});

	// Proves sign-in and signing: the page is X's app, Viewer names the signed-in screen name, and X accepts the
	// page's request signature on the settings read, which it refuses with 404 code 34 when the signature is wrong.
	const health = (account: string) =>
		serial(async () => {
			const started = Date.now();
			const current = await ensureSlot(account);
			const fresh = Date.now() - current.verifiedAt < 5_000;
			const screenName = fresh ? current.screenName : await readScreenName(current);
			await send(current, "account.settings", findOperation("account.settings")!, {});
			return {
				account,
				screenName,
				signature: "accepted",
				page: current.page.url(),
				operationsOnPage: current.operations.size,
				ms: Date.now() - started,
			};
		});

	const stop = () => serial(stopSlot);

	const status = () => (slot ? { account: slot.account, up: !slot.exited && !slot.stale } : undefined);

	return { call, health, stop, status };
};
