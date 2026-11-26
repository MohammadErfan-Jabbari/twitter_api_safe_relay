import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.ts";
import { AccountLimiter, type Clock, cooldownFromResponse } from "../src/pacing.ts";

// Time moves only when the limiter sleeps
const fakeClock = (start = 1_000_000) => {
	let now = start;
	const slept: number[] = [];
	const clock: Clock = {
		now: () => now,
		sleep: async (ms) => {
			slept.push(ms);
			now += ms;
		},
	};
	return { clock, slept, now: () => now, advance: (ms: number) => (now += ms) };
};

const read = { write: false, search: false };
const write = { write: true, search: false };
const search = { write: false, search: true };

const dirs: string[] = [];
const stateDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-cli-pacing-"));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("pacing", () => {
	it("holds 100 ms between any two requests", async () => {
		const t = fakeClock();
		const limiter = new AccountLimiter(stateDir(), defaultConfig.pacing, t.clock);
		const at: number[] = [];

		for (let i = 0; i < 3; i++) {
			await limiter.run(read, async () => at.push(t.now()));
		}

		expect(at[1]! - at[0]!).toBe(100);
		expect(at[2]! - at[1]!).toBe(100);
	});

	it("holds 10 s between writes, while a read in between waits only the request floor", async () => {
		const t = fakeClock();
		const limiter = new AccountLimiter(stateDir(), defaultConfig.pacing, t.clock);
		const at: Record<string, number> = {};

		await limiter.run(write, async () => (at.first = t.now()));
		await limiter.run(read, async () => (at.read = t.now()));
		await limiter.run(write, async () => (at.second = t.now()));

		expect(at.read! - at.first!).toBe(100);
		expect(at.second! - at.first!).toBe(10_000);
	});

	it("holds 5 s between searches", async () => {
		const t = fakeClock();
		const limiter = new AccountLimiter(stateDir(), defaultConfig.pacing, t.clock);
		const at: number[] = [];

		await limiter.run(search, async () => at.push(t.now()));
		await limiter.run(search, async () => at.push(t.now()));

		expect(at[1]! - at[0]!).toBe(5_000);
	});

	it("shares one budget between two limiters on the same account, as two processes would", async () => {
		const t = fakeClock();
		const dir = stateDir();
		const first = new AccountLimiter(dir, defaultConfig.pacing, t.clock);
		const second = new AccountLimiter(dir, defaultConfig.pacing, t.clock);
		const at: number[] = [];

		await first.run(write, async () => at.push(t.now()));
		await second.run(write, async () => at.push(t.now()));

		expect(at[1]! - at[0]!).toBe(10_000);
	});

	it("cools down 15 minutes after a 429 without hints, and fails fast instead of waiting that long", async () => {
		const t = fakeClock();
		const limiter = new AccountLimiter(stateDir(), defaultConfig.pacing, t.clock);
		const until = cooldownFromResponse(429, {}, t.now(), defaultConfig.pacing.cooldownMs);

		await limiter.coolDown(until, "429");
		const blocked = limiter.run(read, async () => "sent");

		expect(until - t.now()).toBe(15 * 60_000);
		await expect(blocked).rejects.toMatchObject({ type: "rate_limited", details: { reason: "429" } });
		t.advance(15 * 60_000);
		await expect(limiter.run(read, async () => "sent")).resolves.toBe("sent");
	});

	it("follows retry-after and x-rate-limit-reset, plus 5 s grace", () => {
		const now = 1_700_000_000_000;

		expect(cooldownFromResponse(429, { "retry-after": "60" }, now, 900_000)).toBe(now + 65_000);
		expect(
			cooldownFromResponse(200, { "x-rate-limit-remaining": "0", "x-rate-limit-reset": "1700000120" }, now, 1),
		).toBe(now + 125_000);
		expect(cooldownFromResponse(200, { "x-rate-limit-remaining": "3" }, now, 1)).toBe(0);
	});

	it("waits out a short cooldown instead of failing", async () => {
		const t = fakeClock();
		const limiter = new AccountLimiter(stateDir(), defaultConfig.pacing, t.clock);

		await limiter.coolDown(t.now() + 20_000, "429");
		const at = await limiter.run(read, async () => t.now());

		expect(at).toBe(1_000_000 + 20_000);
	});
});
