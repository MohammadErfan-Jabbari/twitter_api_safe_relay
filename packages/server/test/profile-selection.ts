import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import type { TwitterApiProfileClient } from "twitter-api-safe-request";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

// A client that records which profile served the request
const createRecordingClient = (name: string, served: string[]) => {
	const page = new EventEmitter();
	const dispatch = async () => {
		served.push(name);
		return { ok: true };
	};
	return { page: page as unknown as Page, dispatch } as TwitterApiProfileClient;
};

const path = "/i/api/graphql/AMIBMjtxEEATh4z8V9GtRg/UserByScreenName";

describe("profile selection", () => {
	it("refuses a request without x-profile-name when two profiles are configured", async () => {
		const served: string[] = [];
		const app = await createApp([
			{ name: "personal", getClient: async () => createRecordingClient("personal", served) },
			{ name: "pro", getClient: async () => createRecordingClient("pro", served) },
		]);

		const response = await app.request(path);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Missing x-profile-name header", available: ["personal", "pro"] });
		expect(served).toEqual([]);
	});

	it("serves the named profile when two profiles are configured", async () => {
		const served: string[] = [];
		const app = await createApp([
			{ name: "personal", getClient: async () => createRecordingClient("personal", served) },
			{ name: "pro", getClient: async () => createRecordingClient("pro", served) },
		]);

		const response = await app.request(path, { headers: { "x-profile-name": "pro" } });

		expect(response.status).toBe(200);
		expect(served).toEqual(["pro"]);
	});

	it("serves the only profile without x-profile-name", async () => {
		const served: string[] = [];
		const app = await createApp([
			{ name: "personal", getClient: async () => createRecordingClient("personal", served) },
		]);

		const response = await app.request(path);

		expect(response.status).toBe(200);
		expect(served).toEqual(["personal"]);
	});
});
