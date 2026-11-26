// The only operations x-cli can send. The relay refuses any name not in this table before a browser starts, so
// an operation missing here (posting, liking, following, messaging) cannot be sent, whatever the caller asks.
import { z } from "zod";
import { XCliError } from "./errors.ts";
import { folderPage, list, listPage, tweetPage, user, userPage } from "./extract.ts";

export type GraphQLSpec = { kind: "graphql"; operationName: string; variables: (args: any) => Record<string, unknown> };
export type RestSpec = {
	kind: "rest";
	method: "GET" | "POST";
	path: string;
	// Query parameters, as X's web app sends them
	params?: Record<string, string>;
	form?: (args: any) => Record<string, string>;
};

export type Operation<A extends z.ZodType = z.ZodType> = {
	access: "read" | "write";
	// Searches get bird's longer floor. No operation in the first version searches.
	search?: boolean;
	// Bookmark folders are an X Premium feature
	premium?: boolean;
	args: A;
	request: GraphQLSpec | RestSpec;
	extract: (response: any, args: z.infer<A>) => unknown;
};

const op = <A extends z.ZodType>(operation: Operation<A>) => operation;

const id = z.string().regex(/^\d{1,25}$/, "must be a numeric id");
const count = z.number().int().min(1).max(100).default(20);
const cursor = z.string().min(1).max(1000).optional();
const name = z.string().min(1).max(25);
const description = z.string().max(100);
const screenName = z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "must be an X screen name");

const page = { count, cursor };
const withCursor = (args: { cursor?: string }) => (args.cursor ? { cursor: args.cursor } : {});

const dataOf = (response: any) => response?.data ?? response;

// The fields X's account settings endpoint takes, with the values it accepts
export const settingsFields = {
	protected: z.boolean(),
	discoverable_by_email: z.boolean(),
	discoverable_by_mobile_phone: z.boolean(),
	display_sensitive_media: z.boolean(),
	nsfw_user: z.boolean(),
	allow_media_tagging: z.enum(["all", "following", "none"]),
	allow_dms_from: z.enum(["all", "following", "verified"]),
	allow_dm_groups_from: z.enum(["all", "following"]),
	allow_contributor_request: z.enum(["all", "following", "none"]),
	lang: z.string().regex(/^[a-z]{2}(-[a-z]{2})?$/),
} as const;

export const registry = {
	"account.viewer": op({
		access: "read",
		args: z.object({}).strict(),
		request: { kind: "graphql", operationName: "Viewer", variables: () => ({}) },
		extract: (response) => {
			const viewer = user(response?.data?.viewer?.user_results?.result);
			if (!viewer?.screenName) {
				throw new XCliError("x_error", "X's Viewer response names no signed-in account");
			}
			return viewer;
		},
	}),
	"account.settings": op({
		access: "read",
		args: z.object({}).strict(),
		request: {
			kind: "rest",
			method: "GET",
			path: "/1.1/account/settings.json",
			// The parameters X's web app sends (recorded in packages/server/requests.ndjson)
			params: {
				include_ext_sharing_audiospaces_listening_data_with_followers: "true",
				include_mention_filter: "true",
				include_nsfw_user_flag: "true",
				include_nsfw_admin_flag: "true",
				include_ranked_timeline: "true",
				include_alt_text_compose: "true",
				include_ext_dm_av_call_settings: "true",
				ext: "ssoConnections",
				include_country_code: "true",
				include_ext_dm_nsfw_media_filter: "true",
			},
		},
		extract: (response) => response,
	}),
	"account.updateSettings": op({
		access: "write",
		args: z
			.object(settingsFields)
			.partial()
			.strict()
			.refine((value) => Object.keys(value).length > 0, "name at least one setting"),
		request: {
			kind: "rest",
			method: "POST",
			path: "/1.1/account/settings.json",
			form: (args) => Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])),
		},
		extract: (response) => response,
	}),
	"user.lookup": op({
		access: "read",
		args: z.object({ screenName }).strict(),
		request: {
			kind: "graphql",
			operationName: "UserByScreenName",
			variables: (args) => ({ screen_name: args.screenName, withGrokTranslatedBio: false }),
		},
		extract: (response, args) => {
			const found = user(response?.data?.user?.result);
			if (!found) {
				throw new XCliError("not_found", `No account @${args.screenName}`);
			}
			return found;
		},
	}),
	"user.following": op({
		access: "read",
		args: z.object({ userId: id, ...page }).strict(),
		request: {
			kind: "graphql",
			operationName: "Following",
			variables: (args) => ({
				userId: args.userId,
				count: args.count,
				includePromotedContent: false,
				...withCursor(args),
			}),
		},
		extract: userPage,
	}),
	"home.following": op({
		access: "read",
		args: z.object(page).strict(),
		request: {
			kind: "graphql",
			operationName: "HomeLatestTimeline",
			variables: (args) => ({
				count: args.count,
				includePromotedContent: false,
				requestContext: "launch",
				enableRanking: false,
				...withCursor(args),
			}),
		},
		extract: tweetPage,
	}),
	"lists.mine": op({
		access: "read",
		args: z.object(page).strict(),
		request: {
			kind: "graphql",
			operationName: "ListsManagementPageTimeline",
			variables: (args) => ({ count: args.count, ...withCursor(args) }),
		},
		extract: listPage,
	}),
	"list.tweets": op({
		access: "read",
		args: z.object({ listId: id, ...page }).strict(),
		request: {
			kind: "graphql",
			operationName: "ListLatestTweetsTimeline",
			variables: (args) => ({ listId: args.listId, count: args.count, ...withCursor(args) }),
		},
		extract: tweetPage,
	}),
	"list.members": op({
		access: "read",
		args: z.object({ listId: id, ...page }).strict(),
		request: {
			kind: "graphql",
			operationName: "ListMembers",
			variables: (args) => ({ listId: args.listId, count: args.count, ...withCursor(args) }),
		},
		extract: userPage,
	}),
	"list.create": op({
		access: "write",
		args: z.object({ name, description: description.default(""), private: z.boolean().default(true) }).strict(),
		request: {
			kind: "graphql",
			operationName: "CreateList",
			variables: (args) => ({ isPrivate: args.private, name: args.name, description: args.description }),
		},
		extract: (response) => list(response?.data?.list) ?? dataOf(response),
	}),
	"list.update": op({
		access: "write",
		args: z
			.object({
				listId: id,
				name: name.optional(),
				description: description.optional(),
				private: z.boolean().optional(),
			})
			.strict()
			.refine((value) => Object.keys(value).length > 1, "name at least one field to change"),
		request: {
			kind: "graphql",
			operationName: "UpdateList",
			// Only the fields being changed are sent
			variables: (args) => ({
				listId: args.listId,
				...(args.private === undefined ? {} : { isPrivate: args.private }),
				...(args.name === undefined ? {} : { name: args.name }),
				...(args.description === undefined ? {} : { description: args.description }),
			}),
		},
		extract: (response) => list(response?.data?.list) ?? dataOf(response),
	}),
	"list.delete": op({
		access: "write",
		args: z.object({ listId: id }).strict(),
		request: { kind: "graphql", operationName: "DeleteList", variables: (args) => ({ listId: args.listId }) },
		extract: (response, args) => ({ listId: args.listId, deleted: response?.data?.list_delete === "Done" }),
	}),
	"list.addMember": op({
		access: "write",
		args: z.object({ listId: id, userId: id }).strict(),
		request: {
			kind: "graphql",
			operationName: "ListAddMember",
			variables: (args) => ({ listId: args.listId, userId: args.userId }),
		},
		extract: (response) => list(response?.data?.list) ?? dataOf(response),
	}),
	"list.removeMember": op({
		access: "write",
		args: z.object({ listId: id, userId: id }).strict(),
		request: {
			kind: "graphql",
			operationName: "ListRemoveMember",
			variables: (args) => ({ listId: args.listId, userId: args.userId }),
		},
		extract: (response) => list(response?.data?.list) ?? dataOf(response),
	}),
	"bookmarks.all": op({
		access: "read",
		args: z.object(page).strict(),
		request: {
			kind: "graphql",
			operationName: "Bookmarks",
			variables: (args) => ({ count: args.count, includePromotedContent: false, ...withCursor(args) }),
		},
		extract: tweetPage,
	}),
	"bookmarks.folder": op({
		access: "read",
		premium: true,
		args: z.object({ folderId: id, ...page }).strict(),
		request: {
			kind: "graphql",
			operationName: "BookmarkFolderTimeline",
			variables: (args) => ({
				bookmark_collection_id: args.folderId,
				count: args.count,
				includePromotedContent: false,
				...withCursor(args),
			}),
		},
		extract: tweetPage,
	}),
	"folders.list": op({
		access: "read",
		premium: true,
		args: z.object({ cursor }).strict(),
		request: { kind: "graphql", operationName: "BookmarkFoldersSlice", variables: (args) => withCursor(args) },
		extract: folderPage,
	}),
	"folder.create": op({
		access: "write",
		premium: true,
		args: z.object({ name }).strict(),
		request: { kind: "graphql", operationName: "createBookmarkFolder", variables: (args) => ({ name: args.name }) },
		extract: dataOf,
	}),
	"folder.rename": op({
		access: "write",
		premium: true,
		args: z.object({ folderId: id, name }).strict(),
		request: {
			kind: "graphql",
			operationName: "EditBookmarkFolder",
			variables: (args) => ({ bookmark_collection_id: args.folderId, name: args.name }),
		},
		extract: dataOf,
	}),
	"folder.delete": op({
		access: "write",
		premium: true,
		args: z.object({ folderId: id }).strict(),
		request: {
			kind: "graphql",
			operationName: "DeleteBookmarkFolder",
			variables: (args) => ({ bookmark_collection_id: args.folderId }),
		},
		extract: dataOf,
	}),
	"folder.addTweet": op({
		access: "write",
		premium: true,
		args: z.object({ folderId: id, tweetId: id }).strict(),
		request: {
			kind: "graphql",
			operationName: "bookmarkTweetToFolder",
			variables: (args) => ({ tweet_id: args.tweetId, bookmark_collection_id: args.folderId }),
		},
		extract: dataOf,
	}),
	"folder.removeTweet": op({
		access: "write",
		premium: true,
		args: z.object({ folderId: id, tweetId: id }).strict(),
		request: {
			kind: "graphql",
			operationName: "RemoveTweetFromBookmarkFolder",
			variables: (args) => ({ tweet_id: args.tweetId, bookmark_collection_id: args.folderId }),
		},
		extract: dataOf,
	}),
} satisfies Record<string, Operation>;

export type OperationName = keyof typeof registry;

export const findOperation = (name: string): Operation | undefined =>
	Object.hasOwn(registry, name) ? (registry as Record<string, Operation>)[name] : undefined;

export const parseArguments = (name: string, operation: Operation, args: unknown) => {
	const parsed = operation.args.safeParse(args ?? {});
	if (!parsed.success) {
		throw new XCliError("invalid_arguments", `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
};
