// x-cli: JSON on stdout. A failure prints {"error":{"type":…,"message":…}} and exits non-zero.
import { parseArgs } from "node:util";
import { relayRequest, stopRelay } from "./client.ts";
import { type Config, loadConfig } from "./config.ts";
import { exitCodeOf, toXCliError, XCliError } from "./errors.ts";
import type { OperationName } from "./registry.ts";

const usage = `x-cli <command> --account <name> [options]

Reads:   whoami | health | home [-n N] | lists [-n N] | list read <id> [-n N] | list members <id> [-n N]
         bookmarks [--folder <id>] [-n N] | bookmark-folders | following [--user <name>] [-n N] | settings
Lists:   list create <name> [--description <text>] [--public] | list update <id> [--name <name>]
         [--description <text>] [--public|--private] | list delete <id> | list add|remove <id> <user>
Folders: folder create <name> | folder rename <id> <name> | folder delete <id> | folder add|remove <id> <tweet-id>
Settings: settings set <field>=<value> ...
Relay:   serve | stop

There is no default account: every command but serve and stop needs --account.`;

type Context = { config: Config; account: string; values: Record<string, any>; positionals: string[] };

const call = (ctx: Context, op: OperationName, args: Record<string, unknown> = {}) =>
	relayRequest(ctx.config, "/v1/call", { account: ctx.account, body: { op, args } });

const limitOf = (ctx: Context) => {
	const n = ctx.values.n === undefined ? 20 : Number(ctx.values.n);
	if (!Number.isInteger(n) || n < 1 || n > 200) {
		throw new XCliError("usage", "-n takes a whole number from 1 to 200");
	}
	return n;
};

// Follows the bottom cursor until n items or the end of the timeline
const collect = async (ctx: Context, op: OperationName, args: Record<string, unknown>) => {
	const n = limitOf(ctx);
	const items: unknown[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 12 && items.length < n; page++) {
		const count = Math.min(100, Math.max(n - items.length, 1));
		const result = await call(ctx, op, { ...args, count, ...(cursor ? { cursor } : {}) });
		items.push(...result.items);
		if (!result.cursor || result.cursor === cursor || result.items.length === 0) {
			cursor = undefined;
			break;
		}
		cursor = result.cursor;
	}
	return { account: ctx.account, count: Math.min(items.length, n), items: items.slice(0, n), cursor };
};

const arg = (ctx: Context, index: number, what: string) => {
	const value = ctx.positionals[index];
	if (value === undefined) {
		throw new XCliError("usage", `Missing ${what}`);
	}
	return value;
};

const userIdOf = async (ctx: Context, screenName: string) =>
	(await call(ctx, "user.lookup", { screenName: screenName.replace(/^@/, "") })).id as string;

const parseSetting = (pair: string) => {
	const at = pair.indexOf("=");
	if (at < 1) {
		throw new XCliError("usage", `Settings take field=value, got ${pair}`);
	}
	const value = pair.slice(at + 1);
	return [pair.slice(0, at), value === "true" ? true : value === "false" ? false : value] as const;
};

const privacyOf = (ctx: Context) => {
	if (ctx.values.public && ctx.values.private) {
		throw new XCliError("usage", "Choose --public or --private, not both");
	}
	return ctx.values.public ? false : ctx.values.private ? true : undefined;
};

const commands: Record<string, (ctx: Context) => Promise<unknown>> = {
	whoami: async (ctx) => ({ account: ctx.account, ...(await call(ctx, "account.viewer")) }),
	health: (ctx) => relayRequest(ctx.config, "/v1/health", { account: ctx.account }),
	home: (ctx) => collect(ctx, "home.following", {}),
	lists: (ctx) => collect(ctx, "lists.mine", {}),
	bookmarks: (ctx) =>
		ctx.values.folder
			? collect(ctx, "bookmarks.folder", { folderId: ctx.values.folder })
			: collect(ctx, "bookmarks.all", {}),
	"bookmark-folders": async (ctx) => {
		const items: unknown[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const result = await call(ctx, "folders.list", cursor ? { cursor } : {});
			items.push(...result.items);
			if (!result.cursor || result.cursor === cursor || result.items.length === 0) {
				break;
			}
			cursor = result.cursor;
		}
		return { account: ctx.account, count: items.length, items };
	},
	following: async (ctx) => {
		const userId = ctx.values.user
			? await userIdOf(ctx, ctx.values.user)
			: ((await call(ctx, "account.viewer")).id as string);
		return collect(ctx, "user.following", { userId });
	},
	settings: async (ctx) => {
		if (ctx.positionals[1] === "set") {
			const pairs = ctx.positionals.slice(2);
			if (pairs.length === 0) {
				throw new XCliError("usage", "settings set needs at least one field=value");
			}
			return call(ctx, "account.updateSettings", Object.fromEntries(pairs.map(parseSetting)));
		}
		if (ctx.positionals.length > 1) {
			throw new XCliError("usage", `Unknown settings command: ${ctx.positionals[1]}`);
		}
		return call(ctx, "account.settings");
	},
	list: async (ctx) => {
		const sub = arg(ctx, 1, "list command (read, members, create, update, delete, add, remove)");
		switch (sub) {
			case "read":
				return collect(ctx, "list.tweets", { listId: arg(ctx, 2, "list id") });
			case "members":
				return collect(ctx, "list.members", { listId: arg(ctx, 2, "list id") });
			case "create":
				return call(ctx, "list.create", {
					name: arg(ctx, 2, "list name"),
					...(ctx.values.description === undefined ? {} : { description: ctx.values.description }),
					private: !ctx.values.public,
				});
			case "update": {
				const privacy = privacyOf(ctx);
				return call(ctx, "list.update", {
					listId: arg(ctx, 2, "list id"),
					...(ctx.values.name === undefined ? {} : { name: ctx.values.name }),
					...(ctx.values.description === undefined ? {} : { description: ctx.values.description }),
					...(privacy === undefined ? {} : { private: privacy }),
				});
			}
			case "delete":
				return call(ctx, "list.delete", { listId: arg(ctx, 2, "list id") });
			case "add":
			case "remove": {
				const listId = arg(ctx, 2, "list id");
				const userId = await userIdOf(ctx, arg(ctx, 3, "user"));
				return call(ctx, sub === "add" ? "list.addMember" : "list.removeMember", { listId, userId });
			}
			default:
				throw new XCliError("usage", `Unknown list command: ${sub}`);
		}
	},
	folder: async (ctx) => {
		const sub = arg(ctx, 1, "folder command (create, rename, delete, add, remove)");
		switch (sub) {
			case "create":
				return call(ctx, "folder.create", { name: arg(ctx, 2, "folder name") });
			case "rename":
				return call(ctx, "folder.rename", { folderId: arg(ctx, 2, "folder id"), name: arg(ctx, 3, "new name") });
			case "delete":
				return call(ctx, "folder.delete", { folderId: arg(ctx, 2, "folder id") });
			case "add":
			case "remove":
				return call(ctx, sub === "add" ? "folder.addTweet" : "folder.removeTweet", {
					folderId: arg(ctx, 2, "folder id"),
					tweetId: arg(ctx, 3, "tweet id"),
				});
			default:
				throw new XCliError("usage", `Unknown folder command: ${sub}`);
		}
	},
};

const main = async (argv: string[]) => {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			account: { type: "string" },
			n: { type: "string", short: "n" },
			folder: { type: "string" },
			user: { type: "string" },
			name: { type: "string" },
			description: { type: "string" },
			public: { type: "boolean" },
			private: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const command = positionals[0];
	if (values.help || command === undefined) {
		throw new XCliError("usage", usage);
	}
	const config = loadConfig();
	if (command === "serve") {
		const { runRelay } = await import("./relay.ts");
		await runRelay(config);
		return undefined;
	}
	if (command === "stop") {
		return stopRelay(config);
	}
	const run = Object.hasOwn(commands, command) ? commands[command] : undefined;
	if (!run) {
		throw new XCliError("usage", `Unknown command: ${command}\n\n${usage}`);
	}
	const account = values.account;
	if (!account) {
		throw new XCliError("usage", `Missing --account (one of: ${Object.keys(config.accounts).join(", ")})`);
	}
	if (!Object.hasOwn(config.accounts, account)) {
		throw new XCliError("unknown_account", `Unknown account: ${account}`, { available: Object.keys(config.accounts) });
	}
	return run({ config, account, values, positionals });
};

try {
	const result = await main(process.argv.slice(2));
	if (result !== undefined) {
		process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
	}
} catch (error) {
	const typed =
		error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")
			? new XCliError("usage", error.message)
			: toXCliError(error);
	process.stdout.write(`${JSON.stringify({ error: typed.toJSON() }, null, 1)}\n`);
	process.exitCode = exitCodeOf(typed.type);
}
