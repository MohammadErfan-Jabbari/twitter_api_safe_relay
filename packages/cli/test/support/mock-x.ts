// A local stand-in for x.com: a page with a minimal webpack runtime, a chunk whose modules define GraphQL
// operations (with query IDs random per run) and a fake API client for the bridge to capture, and an API that
// records every request and answers with X-shaped fixtures. The session cookie picks the behaviour:
//   no auth_token -> redirect to the login page    "challenge" -> redirect to /account/access
//   "hang"        -> API requests never answer      "basic"     -> bookmark folders answer 403 (no Premium)
import crypto from "node:crypto";
import http from "node:http";

export type RecordedRequest = {
	method: string;
	path: string;
	operationName?: string;
	queryId?: string;
	variables?: Record<string, unknown>;
	features?: string[];
	form?: Record<string, string>;
	authToken?: string;
	at: number;
};

const operations: [string, "query" | "mutation", string[]][] = [
	["Viewer", "query", []],
	["UserByScreenName", "query", ["mock_feature_user"]],
	["Following", "query", ["mock_feature_timeline"]],
	["HomeLatestTimeline", "query", ["mock_feature_timeline", "mock_feature_home"]],
	["ListsManagementPageTimeline", "query", ["mock_feature_timeline", "mock_feature_lists"]],
	["ListLatestTweetsTimeline", "query", ["mock_feature_timeline"]],
	["ListMembers", "query", ["mock_feature_timeline"]],
	["CreateList", "mutation", ["mock_feature_list"]],
	["UpdateList", "mutation", ["mock_feature_list"]],
	["DeleteList", "mutation", []],
	["ListAddMember", "mutation", ["mock_feature_list"]],
	["ListRemoveMember", "mutation", ["mock_feature_list"]],
	["Bookmarks", "query", ["mock_feature_timeline"]],
	["BookmarkFolderTimeline", "query", ["mock_feature_timeline"]],
	["BookmarkFoldersSlice", "query", []],
	["createBookmarkFolder", "mutation", []],
	["EditBookmarkFolder", "mutation", []],
	["DeleteBookmarkFolder", "mutation", []],
	["bookmarkTweetToFolder", "mutation", []],
	["RemoveTweetFromBookmarkFolder", "mutation", []],
	// On the page but not in x-cli's registry
	["CreateTweet", "mutation", ["mock_feature_tweet"]],
];

const runtime = `
(function () {
	var modules = {}, cache = {};
	function require(id) {
		if (cache[id]) return cache[id].exports;
		var module = (cache[id] = { exports: {} });
		modules[id].call(module.exports, module, module.exports, require);
		return module.exports;
	}
	require.d = function (exports, definition) {
		for (var key in definition)
			if (!Object.prototype.hasOwnProperty.call(exports, key))
				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
	};
	require.m = modules;
	require.c = cache;
	function jsonp(parentPush, data) {
		var more = data[1], run = data[2];
		for (var id in more) modules[id] = more[id];
		if (run) run(require);
		if (parentPush) parentPush(data);
	}
	var chunks = (self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []);
	chunks.forEach(jsonp.bind(null, 0));
	chunks.push = jsonp.bind(null, chunks.push.bind(chunks));
})();`;

const client = `function (module, exports, require) {
	class Client {
		dispatch(request) {
			var url = "/i/api" + request.path;
			if (request.params) url += "?" + new URLSearchParams(request.params);
			var init = { method: request.method, headers: request.headers || {} };
			if (request.data !== undefined) init.body = typeof request.data === "string" ? request.data : JSON.stringify(request.data);
			return fetch(url, init).then(function (response) {
				return response.json().then(function (body) {
					// Like X's client: any errors in the body throw, even on a 200 that also carries data
					if (!response.ok || (body.errors && body.errors.length)) {
						var codes = (body.errors || []).map(function (e) { return e.code; }).join(",");
						throw Object.assign(new Error("ApiError: " + url + " HTTP-" + response.status + " codes:[" + codes + "]"), { status: response.status });
					}
					return body;
				});
			});
		}
		graphQLFullResponse(operation, variables) {
			var features = {};
			operation.metadata.featureSwitches.forEach(function (name) { features[name] = true; });
			var path = "/graphql/" + operation.queryId + "/" + operation.operationName;
			if (operation.operationType === "mutation")
				return this.dispatch({ method: "POST", path: path, headers: { "content-type": "application/json" }, data: { variables: variables, features: features, queryId: operation.queryId } });
			return this.dispatch({ method: "GET", path: path, params: { variables: JSON.stringify(variables), features: JSON.stringify(features) } });
		}
		get() {}
		post() {}
		delete() {}
	}
	require.d(exports, { Z: function () { return Client; } });
}`;

const tweetEntry = (id: string, screenName: string, text: string) => ({
	entryId: `tweet-${id}`,
	content: {
		entryType: "TimelineTimelineItem",
		itemContent: {
			itemType: "TimelineTweet",
			tweet_results: {
				result: {
					__typename: "Tweet",
					rest_id: id,
					core: { user_results: { result: { rest_id: "9", core: { screen_name: screenName, name: screenName } } } },
					legacy: { full_text: text, created_at: "Thu Nov 26 10:00:00 +0000 2026" },
				},
			},
		},
	},
});

const cursorEntry = (value: string) => ({
	entryId: `cursor-bottom-${value}`,
	content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value },
});

const listObject = (id: string, name: string, isPrivate: boolean, members = 3) => ({
	id_str: id,
	name,
	description: "",
	mode: isPrivate ? "Private" : "Public",
	member_count: members,
	subscriber_count: 0,
	user_results: { result: { rest_id: "1", core: { screen_name: "mock_owner", name: "Owner" } } },
});

// 20 tweets per page, 3 pages
const tweetTimeline = (cursor: string | undefined, prefix: string) => {
	const page = cursor ? Number(cursor.replace("page-", "")) : 0;
	const entries: unknown[] = Array.from({ length: 20 }, (_, i) =>
		tweetEntry(`${prefix}${page * 20 + i + 1}`, "mock_author", `tweet ${page * 20 + i + 1}`),
	);
	if (page < 2) {
		entries.push(cursorEntry(`page-${page + 1}`));
	}
	return { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } };
};

export const startMockX = async (port: number) => {
	const queryIds = Object.fromEntries(
		operations.map(([name]) => [name, `${crypto.randomBytes(8).toString("base64url")}${name.length}`]),
	);
	const features = Object.fromEntries(operations.map(([name, , switches]) => [name, switches]));
	const requests: RecordedRequest[] = [];
	const held: http.ServerResponse[] = [];

	const modules = operations.map(
		([name, type, switches], i) =>
			`${100 + i}:function(e){e.exports={queryId:${JSON.stringify(queryIds[name])},operationName:"${name}",operationType:"${type}",metadata:{featureSwitches:${JSON.stringify(switches)},fieldToggles:["withMockToggle"]}}}`,
	);
	// A module that leaves module.exports unset, loaded before the client is built
	modules.push("150:function(e){e.exports=void 0}");
	modules.push(`200:${client}`);
	const bundle = `(self.webpackChunk_twitter_responsive_web = self.webpackChunk_twitter_responsive_web || []).push([["main"], {${modules.join(",\n")}}, function (require) { require(150); var Client = require(200).Z; self.mockClient = new Client(); }]);`;

	const page = (body: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>X</title></head><body>${body}</body></html>`;

	const cookieOf = (request: http.IncomingMessage, name: string) =>
		(request.headers.cookie ?? "")
			.split(/;\s*/)
			.map((pair) => pair.split("="))
			.find(([key]) => key === name)?.[1];

	const json = (response: http.ServerResponse, status: number, body: unknown) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};

	// tok-personal signs in as mock_personal; any other session as someone
	const screenNameOf = (authToken: string | undefined) =>
		authToken?.startsWith("tok-") ? `mock_${authToken.slice(4)}` : "someone";

	const answer = (record: RecordedRequest, response: http.ServerResponse) => {
		const v = (record.variables ?? {}) as Record<string, any>;
		const auth = record.authToken;
		switch (record.operationName) {
			case "Viewer":
				return json(response, 200, {
					data: {
						viewer: {
							user_results: {
								result: {
									__typename: "User",
									rest_id: "1001",
									core: { screen_name: screenNameOf(auth), name: "Mock" },
								},
							},
						},
					},
				});
			case "UserByScreenName":
				if (v.screen_name === "nobody_here") {
					return json(response, 200, { data: {} });
				}
				return json(response, 200, {
					data: {
						user: {
							result: { __typename: "User", rest_id: "4242", core: { screen_name: v.screen_name, name: "Member" } },
						},
					},
				});
			case "HomeLatestTimeline":
				return json(response, 200, { data: { home: { home_timeline_urt: tweetTimeline(v.cursor, "") } } });
			case "Bookmarks":
				return json(response, 200, { data: { bookmark_timeline_v2: tweetTimeline(v.cursor, "5") } });
			case "ListLatestTweetsTimeline":
				return json(response, 200, { data: { list: { tweets_timeline: tweetTimeline(v.cursor, "7") } } });
			case "ListsManagementPageTimeline":
				return json(response, 200, {
					data: {
						viewer: {
							list_management_timeline: {
								timeline: {
									instructions: [
										{
											type: "TimelineAddEntries",
											entries: [
												{
													entryId: "owned-subscribed-list-module-0",
													content: {
														entryType: "TimelineTimelineModule",
														items: [
															{
																item: {
																	itemContent: {
																		itemType: "TimelineTwitterList",
																		list: listObject("111", "reading", true),
																	},
																},
															},
															{
																item: {
																	itemContent: {
																		itemType: "TimelineTwitterList",
																		list: listObject("222", "friends", false),
																	},
																},
															},
														],
													},
												},
												{
													entryId: "list-to-follow-module-1",
													content: {
														entryType: "TimelineTimelineModule",
														items: [
															{
																item: {
																	itemContent: {
																		itemType: "TimelineTwitterList",
																		list: listObject("999", "suggested", false),
																	},
																},
															},
														],
													},
												},
											],
										},
									],
								},
							},
						},
					},
					errors: [{ message: "banner", code: 214 }],
				});
			case "CreateList":
				if (v.name === "flagme") {
					return json(response, 200, {
						errors: [{ message: "This request looks like it might be automated.", code: 226 }],
					});
				}
				return json(response, 200, { data: { list: listObject("333", String(v.name), Boolean(v.isPrivate), 0) } });
			case "ListAddMember":
				return json(response, 200, { data: { list: listObject(String(v.listId), "added", true, 1) } });
			case "ListRemoveMember":
				return json(response, 200, { data: { list: listObject(String(v.listId), "removed", true, 0) } });
			case "DeleteList":
				return json(response, 200, { data: { list_delete: "Done" } });
			case "BookmarkFoldersSlice":
				if (auth === "basic") {
					return json(response, 403, { errors: [{ message: "Authorization: Denied by access control", code: 37 }] });
				}
				return json(response, 200, {
					data: {
						viewer: {
							user_results: {
								result: { bookmark_collections_slice: { items: [{ id: "555", name: "papers" }], slice_info: {} } },
							},
						},
					},
				});
			default:
				return json(response, 200, { data: {} });
		}
	};

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		const authToken = cookieOf(request, "auth_token");
		if (url.pathname === "/home") {
			if (!authToken) {
				response.writeHead(302, { location: "/i/flow/login" });
				return response.end();
			}
			if (authToken === "challenge") {
				response.writeHead(302, { location: "/account/access" });
				return response.end();
			}
			response.writeHead(200, { "content-type": "text/html" });
			return response.end(page(`<script>${runtime}</script><script src="/main.js"></script>`));
		}
		if (url.pathname === "/dead") {
			// Signed in, but the app never boots: no webpack runtime, no client
			response.writeHead(200, { "content-type": "text/html" });
			return response.end(page("<p>Something went wrong.</p>"));
		}
		if (url.pathname === "/main.js") {
			response.writeHead(200, { "content-type": "text/javascript" });
			return response.end(bundle);
		}
		if (url.pathname === "/i/flow/login" || url.pathname === "/account/access") {
			response.writeHead(200, { "content-type": "text/html" });
			return response.end(page("<p>Sign in to X</p>"));
		}
		if (!url.pathname.startsWith("/i/api/")) {
			response.writeHead(404);
			return response.end();
		}
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			const record: RecordedRequest = {
				method: request.method ?? "GET",
				path: url.pathname,
				authToken,
				at: Date.now(),
			};
			const graphql = url.pathname.match(/^\/i\/api\/graphql\/([^/]+)\/([^/]+)$/);
			if (graphql) {
				record.queryId = graphql[1];
				record.operationName = graphql[2];
				const body = raw ? JSON.parse(raw) : {};
				record.variables = body.variables ?? JSON.parse(url.searchParams.get("variables") ?? "{}");
				record.features = Object.keys(body.features ?? JSON.parse(url.searchParams.get("features") ?? "{}"));
			} else if (raw) {
				record.form = Object.fromEntries(new URLSearchParams(raw));
			}
			requests.push(record);
			if (authToken === "hang") {
				held.push(response);
				return;
			}
			if (graphql && queryIds[graphql[2]!] !== graphql[1]) {
				return json(response, 404, { errors: [{ message: "Query not found" }] });
			}
			if (url.pathname === "/i/api/1.1/account/settings.json") {
				return json(response, 200, { screen_name: screenNameOf(authToken), protected: false, ...record.form });
			}
			return answer(record, response);
		});
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${port}`,
		queryIds,
		features,
		requests,
		close: async () => {
			for (const response of held) {
				response.destroy();
			}
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
};
