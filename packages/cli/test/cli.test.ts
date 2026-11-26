// The whole path offline: the x-cli command, the relay it starts, Moli, the bridge and a mock X page.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leakyCt0, startHarness } from "./support/harness.ts";

type Harness = Awaited<ReturnType<typeof startHarness>>;

// fetch will not let a caller set Host, so this speaks HTTP directly, as a page on a rebinding domain would
const withHost = (
	port: number,
	host: string,
	method: string,
	route: string,
	headers: Record<string, string> = {},
	body = "",
) =>
	new Promise<{ status: number; json: any }>((resolve, reject) => {
		const request = http.request(
			{ host: "127.0.0.1", port, method, path: route, headers: { ...headers, host } },
			(response) => {
				let text = "";
				response.on("data", (chunk) => {
					text += chunk;
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) }));
			},
		);
		request.on("error", reject);
		request.end(body);
	});

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

	it("treats a name an object inherits, such as constructor, as an unknown command", async () => {
		const run = await h.run("constructor", "--account", "personal");

		expect(run.code).toBe(2);
		expect(run.json.error.type).toBe("usage");
		expect(run.stdout).not.toContain(h.stateDir);
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

	it("refuses a session signed in as another account after the Viewer call alone", async () => {
		const before = h.mock.requests.length;

		const run = await h.run("lists", "--account", "imposter");

		expect(run.code).toBe(5);
		expect(run.json.error).toMatchObject({ type: "wrong_account", expected: "mock_pro", actual: "mock_personal" });
		expect(h.mock.requests.slice(before).map((r) => r.operationName)).toEqual(["Viewer"]);
		expect((await h.ours()).filter((line) => line.includes("moli"))).toEqual([]);
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

	it("refuses a request whose Host is not the relay's own loopback address", async () => {
		await h.run("health", "--account", "personal");
		const before = h.mock.requests.length;
		const { relay: port } = h.ports;
		const call = (host: string) =>
			withHost(
				port,
				host,
				"POST",
				"/v1/call",
				{ "content-type": "application/json", "x-profile-name": "personal" },
				JSON.stringify({ op: "lists.mine", args: {} }),
			);

		const rebound = await call(`attacker.example:${port}`);
		const otherPort = await call(`localhost:${port + 100}`);
		const stopping = await withHost(port, `attacker.example:${port}`, "POST", "/v1/stop");
		const byAddress = await withHost(port, `127.0.0.1:${port}`, "GET", "/health");
		const byName = await withHost(port, `localhost:${port}`, "GET", "/health");

		expect([rebound.status, otherPort.status, stopping.status]).toEqual([403, 403, 403]);
		expect(rebound.json.error.type).toBe("forbidden_host");
		expect(h.mock.requests.length).toBe(before);
		expect([byAddress.status, byName.status]).toEqual([200, 200]);
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

	it("keeps the request's x-csrf-token out of a failure's output and the state logs", async () => {
		const run = await h.run("lists", "--account", "leaky");

		// The token did go out with the request, so the error object X's client threw carried it
		expect(h.mock.requests.at(-1)).toMatchObject({ operationName: "ListsManagementPageTimeline", csrfToken: leakyCt0 });
		expect(run.stdout).not.toContain(leakyCt0);
		expect(run.code).toBe(10);
		expect(run.json.error).toMatchObject({ type: "x_error", status: 503, codes: [] });
		// The browser profile holds the cookie by design; everything else in the state directory is checked
		const files = (fs.readdirSync(h.stateDir, { recursive: true }) as string[])
			.filter((file) => !file.split(path.sep).includes("profile"))
			.map((file) => path.join(h.stateDir, file))
			.filter((file) => fs.statSync(file).isFile());
		expect(files.some((file) => file.endsWith("relay.log"))).toBe(true);
		expect(files.filter((file) => fs.readFileSync(file, "utf8").includes(leakyCt0))).toEqual([]);
	});

	it("reads whom an account follows, its own or another's", async () => {
		const mine = await h.run("following", "--account", "personal", "-n", "2");
		const theirs = await h.run("following", "--user", "@someone", "--account", "personal");

		expect(mine.json).toMatchObject({ account: "personal", count: 2 });
		expect(mine.json.items.map((u: { screenName: string }) => u.screenName)).toEqual(["ann", "bob"]);
		expect(theirs.json.items.map((u: { id: string }) => u.id)).toEqual(["424200", "424201", "424202"]);
		const sent = h.mock.requests.filter((r) => r.operationName === "Following");
		expect(sent.map((r) => r.variables?.userId)).toEqual(["1001", "4242"]);
	});

	it("pages one bookmark folder with --folder", async () => {
		const run = await h.run("bookmarks", "--folder", "555", "--account", "personal", "-n", "25");

		expect(run.json.count).toBe(25);
		expect(run.json.items[24]).toMatchObject({ id: "825", text: "tweet 25" });
		const sent = h.mock.requests.filter((r) => r.operationName === "BookmarkFolderTimeline");
		expect(sent.map((r) => r.variables?.bookmark_collection_id)).toEqual(["555", "555"]);
	});

	it("updates only the list fields it is given", async () => {
		const updated = await h.run("list", "update", "333", "--name", "renamed", "--public", "--account", "personal");
		const both = await h.run("list", "update", "333", "--public", "--private", "--account", "personal");
		const nothing = await h.run("list", "update", "333", "--account", "personal");

		expect(updated.json).toMatchObject({ id: "333", name: "renamed", private: false });
		expect(both.json.error.type).toBe("usage");
		expect(nothing.json.error.type).toBe("invalid_arguments");
		const sent = h.mock.requests.filter((r) => r.operationName === "UpdateList");
		expect(sent.map((r) => r.variables)).toEqual([{ listId: "333", isPrivate: false, name: "renamed" }]);
	});

	it("runs a bookmark folder round with writes paced apart", async () => {
		const created = await h.run("folder", "create", "papers2", "--account", "personal");
		const renamed = await h.run("folder", "rename", "556", "reading", "--account", "personal");
		const added = await h.run("folder", "add", "556", "1234", "--account", "personal");
		const removed = await h.run("folder", "remove", "556", "1234", "--account", "personal");
		const deleted = await h.run("folder", "delete", "556", "--account", "personal");

		expect(created.json).toEqual({ bookmark_collection_create: { id: "556", name: "papers2" } });
		expect([renamed.code, added.code, removed.code, deleted.code]).toEqual([0, 0, 0, 0]);
		const names = [
			"createBookmarkFolder",
			"EditBookmarkFolder",
			"bookmarkTweetToFolder",
			"RemoveTweetFromBookmarkFolder",
			"DeleteBookmarkFolder",
		];
		const writes = h.mock.requests.filter((r) => names.includes(r.operationName ?? ""));
		expect(writes.map((w) => [w.operationName, w.variables])).toEqual([
			["createBookmarkFolder", { name: "papers2" }],
			["EditBookmarkFolder", { bookmark_collection_id: "556", name: "reading" }],
			["bookmarkTweetToFolder", { tweet_id: "1234", bookmark_collection_id: "556" }],
			["RemoveTweetFromBookmarkFolder", { tweet_id: "1234", bookmark_collection_id: "556" }],
			["DeleteBookmarkFolder", { bookmark_collection_id: "556" }],
		]);
		for (let i = 1; i < writes.length; i++) {
			expect(writes[i]!.at - writes[i - 1]!.at).toBeGreaterThanOrEqual(400);
		}
	});

	it("changes settings with settings set and refuses a value X does not take", async () => {
		const set = await h.run("settings", "set", "protected=true", "allow_dms_from=following", "--account", "personal");
		const bad = await h.run("settings", "set", "allow_dms_from=everyone", "--account", "personal");

		expect(set.code).toBe(0);
		expect(set.json).toMatchObject({ screen_name: "mock_personal", protected: "true", allow_dms_from: "following" });
		expect(bad.json.error.type).toBe("invalid_arguments");
		const posts = h.mock.requests.filter((r) => r.method === "POST" && r.path === "/i/api/1.1/account/settings.json");
		expect(posts.map((r) => r.form)).toEqual([{ protected: "true", allow_dms_from: "following" }]);
	});

	it("says plainly when bookmark folders need Premium", async () => {
		const basic = await h.run("bookmark-folders", "--account", "basic");
		const premium = await h.run("bookmark-folders", "--account", "personal");

		expect(basic.json.error.type).toBe("premium_required");
		expect(premium.json.items).toEqual([{ id: "555", name: "papers" }]);
	});
});

describe("x-cli when the browser cannot start", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startHarness({ offset: 3, moliPath: "/nonexistent/moli" });
	});

	afterAll(async () => {
		await h.stop();
		expect(await h.ours()).toEqual([]);
	});

	it("reports browser_down from health and sends nothing", async () => {
		const run = await h.run("health", "--account", "personal");

		expect(run.code).toBe(3);
		expect(run.json.error.type).toBe("browser_down");
		expect(h.mock.requests).toEqual([]);
	});
});
