// The whole path offline: the x-cli command, the relay it starts, Moli, the bridge and a mock X page.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness } from "./support/harness.ts";

type Harness = Awaited<ReturnType<typeof startHarness>>;

describe("x-cli against a mock X page", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness();
	});

	afterAll(async () => {
		await h.stop();
		expect(await h.ours()).toEqual([]);
	});

	it("fails without --account and sends nothing", async () => {
		const before = h.mock.requests.length;

		const run = await h.run("lists");

		expect(run.code).toBe(2);
		expect(run.json.error.type).toBe("usage");
		expect(run.json.error.message).toContain("--account");
		expect(h.mock.requests.length).toBe(before);
	});

	it("reads query IDs and feature switches from the page's modules", async () => {
		const run = await h.run("lists", "--account", "personal");

		expect(run.code).toBe(0);
		expect(run.json.items.map((list: { name: string }) => list.name)).toEqual(["reading", "friends"]);
		const sent = h.mock.requests.filter((r) => r.operationName === "ListsManagementPageTimeline");
		expect(sent).toHaveLength(1);
		// The mock draws its query IDs at random on each run, so only the page could have supplied this one.
		expect(sent[0]!.queryId).toBe(h.mock.queryIds.ListsManagementPageTimeline);
		expect(sent[0]!.features).toEqual(h.mock.features.ListsManagementPageTimeline);
	});

	it("proves sign-in with health and whoami", async () => {
		const health = await h.run("health", "--account", "personal");
		const whoami = await h.run("whoami", "--account", "personal");

		expect(health.json).toMatchObject({ account: "personal", screenName: "mock_personal" });
		expect(whoami.json).toMatchObject({ account: "personal", screenName: "mock_personal", id: "1001" });
	});

	it("pages a timeline with -n", async () => {
		const run = await h.run("home", "--account", "personal", "-n", "30");

		expect(run.code).toBe(0);
		expect(run.json.count).toBe(30);
		expect(run.json.items[29].text).toBe("tweet 30");
	});

	it("refuses an operation that is not in the registry, even when the page defines it", async () => {
		const before = h.mock.requests.length;

		const response = await h.relay("/v1/call", {
			method: "POST",
			headers: { "content-type": "application/json", "x-profile-name": "personal" },
			body: JSON.stringify({ op: "CreateTweet", args: { tweet_text: "hello" } }),
		});
		const command = await h.run("post", "hello", "--account", "personal");

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).error.type).toBe("unknown_operation");
		expect(command.code).toBe(2);
		expect(command.json.error.type).toBe("usage");
		expect(h.mock.requests.length).toBe(before);
	});

	it("refuses a request without a profile name when two profiles are configured", async () => {
		const before = h.mock.requests.length;
		const request = { op: "lists.mine", args: {} };

		const missing = await h.relay("/v1/call", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		const unknown = await h.relay("/v1/call", {
			method: "POST",
			headers: { "content-type": "application/json", "x-profile-name": "somebody" },
			body: JSON.stringify(request),
		});

		expect(missing.status).toBe(400);
		expect(((await missing.json()) as any).error.type).toBe("missing_account");
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as any).error.type).toBe("unknown_account");
		expect(h.mock.requests.length).toBe(before);
	});

	it("runs a private list round on the second account with writes paced apart", async () => {
		const health = await h.run("health", "--account", "pro");
		const created = await h.run("list", "create", "oikos-test", "--account", "pro");
		const added = await h.run("list", "add", "333", "@someone", "--account", "pro");
		const removed = await h.run("list", "remove", "333", "someone", "--account", "pro");
		const deleted = await h.run("list", "delete", "333", "--account", "pro");

		expect(health.json.screenName).toBe("mock_pro");
		expect(created.json).toMatchObject({ id: "333", name: "oikos-test", private: true });
		expect(added.code).toBe(0);
		expect(removed.code).toBe(0);
		expect(deleted.json).toEqual({ listId: "333", deleted: true });
		const writes = h.mock.requests.filter((r) =>
			["CreateList", "ListAddMember", "ListRemoveMember", "DeleteList"].includes(r.operationName ?? ""),
		);
		expect(writes.map((w) => w.operationName)).toEqual([
			"CreateList",
			"ListAddMember",
			"ListRemoveMember",
			"DeleteList",
		]);
		expect(writes.every((w) => w.authToken === "tok-pro")).toBe(true);
		expect(writes[0]!.variables).toEqual({ isPrivate: true, name: "oikos-test", description: "" });
		for (let i = 1; i < writes.length; i++) {
			expect(writes[i]!.at - writes[i - 1]!.at).toBeGreaterThanOrEqual(400);
		}
		// One browser at a time: the personal one stopped when pro started
		expect((await h.ours()).filter((line) => line.includes("moli"))).toHaveLength(1);
	});

	it("reports a logged-out page as logged_out within the deadline", async () => {
		const run = await h.run("health", "--account", "ghost");

		expect(run.json.error).toMatchObject({ type: "logged_out", cookies: "missing" });
		expect(run.ms).toBeLessThan(h.timeouts.browserStartMs + h.timeouts.navigationMs);
	});

	it("reports a challenge page as challenge", async () => {
		const run = await h.run("health", "--account", "locked");

		expect(run.json.error.type).toBe("challenge");
	});

	it("reports a page whose app never starts as client_not_found within the deadline", async () => {
		const run = await h.run("health", "--account", "dead");

		expect(run.json.error.type).toBe("client_not_found");
		expect(run.ms).toBeGreaterThanOrEqual(h.timeouts.startupMs);
		expect(run.ms).toBeLessThan(h.timeouts.startupMs + 8_000);
	});

	it("reports an API call X never answers as timeout within the deadline", async () => {
		const run = await h.run("whoami", "--account", "slow");

		expect(run.json.error).toMatchObject({ type: "timeout", step: "dispatch" });
		expect(run.ms).toBeLessThan(h.timeouts.dispatchMs + 10_000);
		// The relay is still serving after the timeout
		expect((await h.run("whoami", "--account", "personal")).json.screenName).toBe("mock_personal");
	});

	it("stops the account for an hour after X flags it", async () => {
		const flagged = await h.run("list", "create", "flagme", "--account", "flaggy");
		const before = h.mock.requests.length;
		const next = await h.run("lists", "--account", "flaggy");

		expect(flagged.json.error).toMatchObject({ type: "flagged", code: 226 });
		expect(next.json.error.type).toBe("rate_limited");
		expect(h.mock.requests.length).toBe(before);
	});

	it("says plainly when bookmark folders need Premium", async () => {
		const basic = await h.run("bookmark-folders", "--account", "basic");
		const premium = await h.run("bookmark-folders", "--account", "personal");

		expect(basic.json.error.type).toBe("premium_required");
		expect(premium.json.items).toEqual([{ id: "555", name: "papers" }]);
	});
});
