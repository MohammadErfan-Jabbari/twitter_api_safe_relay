// Per-account request pacing, ported from transitive-bullshit/bird (src/lib/x-request-limiter.ts, MIT).
// Kept from bird: a floor between any two requests, a longer floor between searches, a cooldown after a 429
// or an exhausted x-rate-limit-remaining, and one state file per account guarded by a lock file, so separate
// processes share one budget. Added here: a floor between writes, a long cooldown after X flags the account,
// an injectable clock for tests, and failing fast when the wait would be long.
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { XCliError } from "./errors.ts";

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export const realClock: Clock = {
	now: () => Date.now(),
	// Keep individual timers below Node's signed 32-bit limit.
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2_147_483_647))),
};

export type RequestKind = { write: boolean; search: boolean };

type PacingState = {
	nextRequestAt: number;
	nextSearchAt: number;
	nextWriteAt: number;
	cooldownUntil: number;
	cooldownReason: string;
};

const emptyState = (): PacingState => ({
	nextRequestAt: 0,
	nextSearchAt: 0,
	nextWriteAt: 0,
	cooldownUntil: 0,
	cooldownReason: "",
});

const RESET_GRACE_MS = 5_000;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

const isErrorCode = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;

// bird's getCooldownUntil: 0 unless the response is a 429 or says no requests remain
export const cooldownFromResponse = (
	status: number | undefined,
	headers: Record<string, string>,
	now: number,
	defaultCooldownMs: number,
): number => {
	const remaining = headers["x-rate-limit-remaining"];
	if (status !== 429 && remaining !== "0") {
		return 0;
	}
	const retryAfter = headers["retry-after"];
	const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN;
	const retryAt = Number.isFinite(retrySeconds)
		? now + Math.max(0, retrySeconds) * 1_000
		: retryAfter
			? Date.parse(retryAfter)
			: Number.NaN;
	const resetHeader = headers["x-rate-limit-reset"];
	const resetAt = resetHeader ? Number(resetHeader) * 1_000 : Number.NaN;
	const hints = [retryAt, resetAt].filter((at) => Number.isFinite(at) && at > now);
	return hints.length > 0 ? Math.max(...hints) + RESET_GRACE_MS : now + defaultCooldownMs;
};

export class AccountLimiter {
	private readonly stateDirectory: string;
	private readonly pacing: Config["pacing"];
	private readonly clock: Clock;
	private readonly statePath: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(stateDirectory: string, pacing: Config["pacing"], clock: Clock = realClock) {
		this.stateDirectory = stateDirectory;
		this.pacing = pacing;
		this.clock = clock;
		this.statePath = path.join(stateDirectory, "pacing.json");
	}

	// Requests for one account run one at a time, each after its turn.
	run<T>(kind: RequestKind, request: () => Promise<T>): Promise<T> {
		const pending = this.queue.then(async () => {
			await this.waitForTurn(kind);
			return request();
		});
		// A failed request still consumes its slot, but must not poison later calls.
		this.queue = pending.catch(() => {});
		return pending;
	}

	async coolDown(until: number, reason: string) {
		await this.updateState((state) => {
			if (until > state.cooldownUntil) {
				state.cooldownUntil = until;
				state.cooldownReason = reason;
			}
		});
	}

	async snapshot(): Promise<PacingState> {
		return this.updateState((state) => ({ ...state }));
	}

	private async waitForTurn(kind: RequestKind): Promise<void> {
		while (true) {
			const wait = await this.updateState((state) => {
				const now = this.clock.now();
				const readyAt = Math.max(
					state.nextRequestAt,
					kind.search ? state.nextSearchAt : 0,
					kind.write ? state.nextWriteAt : 0,
					state.cooldownUntil,
				);
				if (readyAt > now) {
					return { ms: readyAt - now, readyAt, cooling: state.cooldownUntil === readyAt, reason: state.cooldownReason };
				}
				state.nextRequestAt = now + this.pacing.requestIntervalMs;
				if (kind.search) {
					state.nextSearchAt = now + this.pacing.searchIntervalMs;
				}
				if (kind.write) {
					state.nextWriteAt = now + this.pacing.writeIntervalMs;
				}
				return undefined;
			});
			if (wait === undefined) {
				return;
			}
			if (wait.ms > this.pacing.maxWaitMs) {
				throw new XCliError("rate_limited", `This account is paused until ${new Date(wait.readyAt).toISOString()}`, {
					retryAt: new Date(wait.readyAt).toISOString(),
					reason: wait.cooling ? wait.reason || "cooldown" : "pacing",
				});
			}
			// Re-read after sleeping: another process may have extended the cooldown.
			await this.clock.sleep(wait.ms);
		}
	}

	private async updateState<T>(update: (state: PacingState) => T): Promise<T> {
		await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
		const lockPath = `${this.statePath}.lock`;
		const lock = await this.acquireLock(lockPath);
		try {
			const state = await this.readState();
			const result = update(state);
			// Rename keeps a crash during writing from truncating the previous state.
			const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
			await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
			await rename(temporaryPath, this.statePath);
			return result;
		} finally {
			await lock.close();
			await unlink(lockPath).catch(() => {});
		}
	}

	private async acquireLock(lockPath: string) {
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		while (true) {
			try {
				return await open(lockPath, "wx", 0o600);
			} catch (error) {
				if (!isErrorCode(error, "EEXIST")) {
					throw error;
				}
				// A process that died while holding the lock leaves it behind; it is stale after 30 s.
				const age = await stat(lockPath).then(
					(s) => Date.now() - s.mtimeMs,
					() => 0,
				);
				if (age > STALE_LOCK_MS) {
					await unlink(lockPath).catch(() => {});
					continue;
				}
				if (Date.now() >= deadline) {
					throw new XCliError("internal", `Pacing state is locked: ${lockPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	}

	private async readState(): Promise<PacingState> {
		try {
			const state = { ...emptyState(), ...JSON.parse(await readFile(this.statePath, "utf8")) } as PacingState;
			const numbers = [state.nextRequestAt, state.nextSearchAt, state.nextWriteAt, state.cooldownUntil];
			if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
				throw new Error("Invalid pacing state");
			}
			return state;
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) {
				return emptyState();
			}
			throw new XCliError("internal", `Cannot read pacing state: ${this.statePath}`, { cause: String(error) });
		}
	}
}
