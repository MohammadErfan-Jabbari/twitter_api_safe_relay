// A local stand-in for x.com: a page with a minimal webpack runtime, a chunk whose modules define GraphQL
// operations (with query IDs random per run) and a fake API client for the bridge to capture, and an API that
// records every request and answers with X-shaped fixtures. The session cookie picks the behaviour:
//   no auth_token -> redirect to the login page    "challenge" -> redirect to /account/access
//   "hang"        -> API requests never answer      "basic"     -> bookmark folders answer 403 (no Premium)
//   "overloaded"  -> API requests answer 503 with a page that is not JSON
//   "stale"       -> the page signs with a stale key, so every signature is wrong
// The page also reports to /probe how the functions x-cli replaces look to its own scripts.
// Like x.com, the page signs each request with an x-client-transaction-id read from a paused animation, and the
// account settings endpoint answers 404 code 34 when the signature is wrong.
import crypto from "node:crypto";
import http from "node:http";
import recorded from "../fixtures/chromium-animations.json" with { type: "json" };

export type RecordedRequest = {
	method: string;
	path: string;
	operationName?: string;
	queryId?: string;
	variables?: Record<string, unknown>;
	features?: string[];
	form?: Record<string, string>;
	authToken?: string;
	csrfToken?: string;
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

// The animation X's ondemand.s module samples to sign requests (values seen on x.com on 2026-11-27): a div's color
// and rotation, eased by a cubic-bezier, paused 1500 ms into 4096 ms. The recording holds it first, with what real
// Chromium read from it.
const signing = recorded.cases[0]!;

// X's signature uses the color's whole channels and the rotation matrix's first four values to two places
const signatureOf = (style: { color: string; transform: string }) => {
	const numbers = (text: string) => (text.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
	const color = numbers(style.color).slice(0, 3).map(Math.round);
	const matrix = style.transform === "none" ? [1, 0, 0, 1] : numbers(style.transform).slice(0, 4);
	return `${color.join(",")}|${matrix.map((value) => Math.abs(value).toFixed(2)).join(",")}`;
};

// Like ondemand.s: animate a div, pause it, and read the computed style. A browser that ignores the animation reads
// the div's own color and no transform, and so signs every request wrongly. The server checks the id against the
// same function applied to Chromium's reading.
const signer = `function (module) {
	var div = document.createElement("div");
	document.body.appendChild(div);
	var animation = div.animate(${JSON.stringify(signing.keyframes)}, ${signing.duration});
	animation.pause();
	animation.currentTime = ${signing.time};
	var style = getComputedStyle(div);
	var id = (${signatureOf})({ color: style.color, transform: style.transform });
	div.remove();
	module.exports = { id: self.mockStaleKey ? id + "-stale" : id };
}`;

const client = `function (module, exports, require) {
	var transactionId = require(160).id;
	class Client {
		dispatch(request) {
			var url = "/i/api" + request.path;
			if (request.params) url += "?" + new URLSearchParams(request.params);
			// Like X's client: the ct0 cookie goes out as the x-csrf-token header
			var ct0 = (document.cookie.match(/(?:^|; )ct0=([^;]*)/) || [])[1];
			var headers = Object.assign({ "x-client-transaction-id": transactionId }, request.headers || {}, ct0 ? { "x-csrf-token": ct0 } : {});
			// Like X's client: a POST is form-encoded unless it says otherwise, and the form is built from the data
			// object's entries, so data that is already a string arrives as one field per character
			if ((request.method === "POST" || request.method === "PUT") && headers["content-type"] === undefined) headers["content-type"] = "application/x-www-form-urlencoded";
			var init = { method: request.method, headers: headers };
			if (request.data !== undefined) {
				init.body = headers["content-type"] === "application/json"
					? JSON.stringify(request.data)
					: Object.entries(request.data).filter(function (entry) { return entry[1] != null; }).map(function (entry) { return encodeURIComponent(entry[0]) + "=" + encodeURIComponent(String(entry[1])); }).join("&");
			}
			return fetch(url, init).then(function (response) {
				return response.text().then(function (text) {
					var body;
					try { body = JSON.parse(text); } catch (e) { body = {}; }
					// Like X's client: any errors in the body throw, even on a 200 that also carries data, and the
					// error keeps the request it was for, headers included
					if (!response.ok || (body.errors && body.errors.length)) {
						var codes = (body.errors || []).map(function (e) { return e.code; }).join(",");
						throw Object.assign(new Error("ApiError: " + url + " HTTP-" + response.status + " codes:[" + codes + "]"), { status: response.status, request: { url: url, headers: headers } });
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

// What a page script can learn about each function x-cli replaces: its name, length, source text by every route,
// own properties, whether it constructs, and the descriptor of the property that holds it, plus the computed style of
// an element nothing animates. The same facts from a fresh frame's window, which x-cli leaves alone, show what the
// browser's own functions look like.
const probe = `(function () {
	var describe = function (window) {
		var facts = {};
		[[window.Element.prototype, "animate"], [window, "getComputedStyle"], [window.Function.prototype, "toString"]].forEach(function (pair) {
			var fn = pair[0][pair[1]];
			var d = Object.getOwnPropertyDescriptor(pair[0], pair[1]);
			var constructs;
			try { Reflect.construct(String, [], fn); constructs = true; } catch (e) { constructs = false; }
			facts[pair[1]] = {
				name: fn.name,
				length: fn.length,
				toString: fn.toString(),
				called: window.Function.prototype.toString.call(fn),
				string: String(fn),
				ownKeys: Reflect.ownKeys(fn).map(String),
				descriptor: { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable },
				constructs: constructs
			};
		});
		// The replaced getComputedStyle still answers for an element nothing animates
		var style = window.getComputedStyle(window.document.body);
		facts.computedStyle = { display: style && style.display, declaration: style instanceof window.CSSStyleDeclaration };
		return facts;
	};
	var frame = document.createElement("iframe");
	document.documentElement.appendChild(frame);
	var report = { page: describe(window), fresh: describe(frame.contentWindow), freshTouched: Boolean(frame.contentWindow.__xCliAnimationSampling) };
	frame.remove();
	fetch("/probe", { method: "POST", keepalive: true, body: JSON.stringify(report) });
})();`;

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

const userEntry = (id: string, screenName: string) => ({
	entryId: `user-${id}`,
	content: {
		entryType: "TimelineTimelineItem",
		itemContent: {
			itemType: "TimelineUser",
			user_results: {
				result: { __typename: "User", rest_id: id, core: { screen_name: screenName, name: screenName } },
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
	const probes: Record<string, any>[] = [];
	const held: http.ServerResponse[] = [];

	const modules = operations.map(
		([name, type, switches], i) =>
			`${100 + i}:function(e){e.exports={queryId:${JSON.stringify(queryIds[name])},operationName:"${name}",operationType:"${type}",metadata:{featureSwitches:${JSON.stringify(switches)},fieldToggles:["withMockToggle"]}}}`,
	);
	// A module that leaves module.exports unset, loaded before the client is built
	modules.push("150:function(e){e.exports=void 0}");
	modules.push(`160:${signer}`);
	modules.push(`200:${client}`);
	const signature = signatureOf(signing.chromium);
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

	// Each session's account settings, as X keeps them. A change names fields by the names settings.json shows,
	// except the language, which X takes as lang; X ignores what it does not know, such as the include_* flags.
	const settingsBySession = new Map<string, Record<string, unknown>>();
	const settingsOf = (authToken: string | undefined) => {
		const key = authToken ?? "";
		let settings = settingsBySession.get(key);
		if (!settings) {
			settings = {
				screen_name: screenNameOf(authToken),
				protected: false,
				discoverable_by_email: true,
				discoverable_by_mobile_phone: false,
				display_sensitive_media: false,
				nsfw_user: false,
				allow_media_tagging: "all",
				allow_dms_from: "following",
				allow_dm_groups_from: "following",
				allow_contributor_request: "none",
				language: "en",
			};
			settingsBySession.set(key, settings);
		}
		return settings;
	};
	const applySettings = (settings: Record<string, unknown>, form: Record<string, string>) => {
		for (const [field, value] of Object.entries(form)) {
			const name = field === "lang" ? "language" : field;
			if (name === "screen_name" || !Object.hasOwn(settings, name)) {
				continue;
			}
			settings[name] = typeof settings[name] === "boolean" ? value === "true" : value;
		}
	};

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
			case "BookmarkFolderTimeline":
				return json(response, 200, { data: { bookmark_collection_timeline: tweetTimeline(v.cursor, "8") } });
			case "Following": {
				const entries = ["ann", "bob", "cat"].map((name, i) => userEntry(`${v.userId}0${i}`, name));
				return json(response, 200, {
					data: {
						user: { result: { timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } },
					},
				});
			}
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
			case "UpdateList":
				return json(response, 200, {
					data: { list: listObject(String(v.listId), String(v.name ?? "reading"), v.isPrivate ?? true) },
				});
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
			case "createBookmarkFolder":
				return json(response, 200, { data: { bookmark_collection_create: { id: "556", name: v.name } } });
			case "EditBookmarkFolder":
				return json(response, 200, {
					data: { bookmark_collection_update: { id: v.bookmark_collection_id, name: v.name } },
				});
			case "DeleteBookmarkFolder":
				return json(response, 200, { data: { bookmark_collection_delete: "Done" } });
			case "bookmarkTweetToFolder":
				return json(response, 200, { data: { bookmark_collection_tweet_put: "Done" } });
			case "RemoveTweetFromBookmarkFolder":
				return json(response, 200, { data: { bookmark_collection_tweet_delete: "Done" } });
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
			const stale = authToken === "stale" ? "<script>self.mockStaleKey = true</script>" : "";
			response.writeHead(200, { "content-type": "text/html" });
			return response.end(
				page(`${stale}<script>${probe}</script><script>${runtime}</script><script src="/main.js"></script>`),
			);
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
		if (url.pathname === "/probe") {
			let text = "";
			request.on("data", (chunk) => {
				text += chunk;
			});
			request.on("end", () => {
				probes.push(JSON.parse(text));
				response.writeHead(204);
				response.end();
			});
			return;
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
				csrfToken: request.headers["x-csrf-token"] as string | undefined,
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
			if (authToken === "overloaded") {
				response.writeHead(503, { "content-type": "text/html" });
				return response.end(page("<p>Over capacity</p>"));
			}
			if (graphql && queryIds[graphql[2]!] !== graphql[1]) {
				return json(response, 404, { errors: [{ message: "Query not found" }] });
			}
			if (url.pathname === "/i/api/1.1/account/settings.json") {
				if (request.headers["x-client-transaction-id"] !== signature) {
					return json(response, 404, { errors: [{ message: "Sorry, that page does not exist", code: 34 }] });
				}
				const settings = settingsOf(authToken);
				if (record.method === "POST") {
					applySettings(settings, record.form ?? {});
				}
				return json(response, 200, settings);
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
		probes,
		close: async () => {
			for (const response of held) {
				response.destroy();
			}
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
};
