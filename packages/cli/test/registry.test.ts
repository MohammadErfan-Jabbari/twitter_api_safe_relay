import { describe, expect, it } from "vitest";
import { findOperation, registry } from "../src/registry.ts";

describe("registry", () => {
	it("holds exactly the allowed writes: lists, bookmark folders and account settings", () => {
		const writes = Object.entries(registry)
			.filter(([, operation]) => operation.access === "write")
			.map(([name, operation]) => [
				name,
				operation.request.kind === "graphql" ? operation.request.operationName : operation.request.path,
			]);

		expect(Object.fromEntries(writes)).toEqual({
			"account.updateSettings": "/1.1/account/settings.json",
			"list.create": "CreateList",
			"list.update": "UpdateList",
			"list.delete": "DeleteList",
			"list.addMember": "ListAddMember",
			"list.removeMember": "ListRemoveMember",
			"folder.create": "createBookmarkFolder",
			"folder.rename": "EditBookmarkFolder",
			"folder.delete": "DeleteBookmarkFolder",
			"folder.addTweet": "bookmarkTweetToFolder",
			"folder.removeTweet": "RemoveTweetFromBookmarkFolder",
		});
	});

	it("finds no operation for names outside the table", () => {
		for (const name of ["CreateTweet", "tweet.create", "toString", "__proto__", "constructor", ""]) {
			expect(findOperation(name)).toBeUndefined();
		}
	});

	it("rejects arguments the operation does not take", () => {
		const create = findOperation("list.create")!;

		expect(create.args.safeParse({ name: "a", tweet_text: "hello" }).success).toBe(false);
		expect(findOperation("account.updateSettings")!.args.safeParse({ screen_name: "other" }).success).toBe(false);
	});
});
