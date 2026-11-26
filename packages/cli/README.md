# x-cli

A command for two X accounts that reads, manages lists and bookmark folders, and changes account settings. It cannot post. It works through the relay's browser bridge: X's own web client, in a signed-in page, sends every request.

```sh
x-cli lists --account personal
x-cli home --account pro -n 20
x-cli list create reading --account pro        # private unless --public
```

Every command except `serve` and `stop` needs `--account`. There is no default account. Output is JSON on stdout. A failure prints `{"error":{"type":…,"message":…}}` and exits non-zero. `src/errors.ts` lists the types.

## Commands

| Reads | Writes |
|---|---|
| `whoami`, `health` | `list create <name> [--description <text>] [--public]` |
| `home [-n N]` (the Following timeline) | `list update <id> [--name] [--description] [--public\|--private]` |
| `lists [-n N]`, `list read <id>`, `list members <id>` | `list delete <id>`, `list add\|remove <id> <user>` |
| `bookmarks [--folder <id>] [-n N]`, `bookmark-folders` | `folder create <name>`, `folder rename <id> <name>`, `folder delete <id>` |
| `following [--user <name>] [-n N]` | `folder add\|remove <folder-id> <tweet-id>` |
| `settings` | `settings set <field>=<value> ...` |

`health` loads the account's page and returns the signed-in screen name. Otherwise it returns a typed failure: `logged_out`, `challenge`, `client_not_found`, `browser_down` or `timeout`. Bookmark folders are an X Premium feature. An account without Premium gets `premium_required`.

## How it is built

- **Registry.** `src/registry.ts` is the only list of operations. Each entry gives a name, read or write, the GraphQL operation or REST path, an argument schema, a variables builder and a response reader. The relay refuses any other name before it starts a browser. The writes are list create, update, delete, add member and remove member; bookmark folder create, rename, delete, add tweet and remove tweet; and account settings.
- **Query IDs from the page.** The GraphQL query IDs and feature switches come from the webpack modules of the loaded x.com page (`src/page.ts`), not from a recorded catalog. The bridge keeps each module's original factory reachable for this (`packages/inject/setup.js`).
- **Relay.** `x-cli serve` is a local HTTP server on 127.0.0.1 that owns the browser. The command starts it when it is not running. It runs one account's Moli browser at a time and serves one request at a time. After 10 minutes without a request, it stops the browser and exits. Nothing runs on a timer against X.
- **Pacing.** `src/pacing.ts` ports the request limiter of `transitive-bullshit/bird`: 100 ms between requests, 5 s between searches, and a 15-minute cooldown after a 429. Writes wait 10 s between each other. An account that X flags with error 226, 326 or 344 rests for an hour. The state lives in one file per account, under a lock, so separate processes share it.
- **Deadlines.** Browser start, page load, client startup and every request have a deadline, so a dead or signed-out page gives a typed error instead of a hang.

## Configuration

Defaults suit one machine. `~/.config/x-relay/config.json` (or the file `X_CLI_CONFIG` names) overrides any part. A typical file names the screen name each account must be signed in as. A session signed in as anyone else is stopped with `wrong_account`:

```json
{ "accounts": { "personal": { "screenName": "…" }, "pro": { "screenName": "…" } } }
```

Session cookies come from the environment: `X_PERSONAL_AUTH_TOKEN` and `X_PERSONAL_CT0` for `personal`, `X_PRO_*` for `pro`. The relay sets them in the browser over CDP before the page opens. State, Moli profiles and logs live in `~/.local/state/x-relay/<account>/` (mode 700). The relay listens on port 9360, and Moli on 9361.

## Tests

`pnpm --filter twitter-api-safe-x-cli test` runs offline. A mock x.com page (`test/support/mock-x.ts`) serves a webpack chunk with fake operation modules and a fake API client. The real command, relay, Moli and bridge run against it. Moli must be at `~/.local/bin/moli`.
