# x-cli

A command for two X accounts that reads, manages lists and bookmark folders, and changes account settings. It cannot post. It works through the relay's browser bridge: X's own web client, in a signed-in page, sends every request.

```sh
x-cli lists --account personal
x-cli home --account pro -n 20
x-cli list create reading --account pro        # private unless --public
```

Every command except `serve` and `stop` needs `--account`. There is no default account. Output is JSON on stdout. A failure prints `{"error":{"type":…,"message":…}}` and exits non-zero. The types are under [Errors](#errors).

## Commands

| Reads | Writes |
|---|---|
| `whoami`, `health` | `list create <name> [--description <text>] [--public]` |
| `home [-n N]` (the Following timeline) | `list update <id> [--name] [--description] [--public\|--private]` |
| `lists [-n N]`, `list read <id>`, `list members <id>` | `list delete <id>`, `list add\|remove <id> <user>` |
| `bookmarks [--folder <id>] [-n N]`, `bookmark-folders` | `folder create <name>`, `folder rename <id> <name>`, `folder delete <id>` |
| `following [--user <name>] [-n N]` | `folder add\|remove <folder-id> <tweet-id>` |
| `settings` | `settings set <field>=<value> ...` |

`health` loads the account's page, returns the signed-in screen name, and reads the account's settings to prove that X accepts the page's request signature (`"signature": "accepted"`). Otherwise it returns a typed failure: `logged_out`, `challenge`, `client_not_found`, `signature_rejected`, `browser_down` or `timeout`. Bookmark folders are an X Premium feature. When X refuses a folder request for that reason, the command returns `premium_required`.

`lists` returns the lists the account owns or follows, and leaves out the lists X suggests.

**Settings.** `settings` returns the account's settings as X's settings pages read them. `settings set` changes these fields:

| Field | Values | Checked on a real account |
|---|---|---|
| `protected` | `true`, `false` | no |
| `discoverable_by_email` | `true`, `false` | no |
| `discoverable_by_mobile_phone` | `true`, `false` | yes, set to its current value on 2026-11-27 |
| `display_sensitive_media` | `true`, `false` | no |
| `nsfw_user` | `true`, `false` | no |
| `allow_media_tagging` | `all`, `following`, `none` | no |
| `allow_dms_from` | `all`, `following`, `verified` | no |
| `allow_dm_groups_from` | `all`, `following` | no |
| `lang` | a language code such as `en` or `pt-br` (a read shows it as `language`) | no |

X's own settings pages change the first six through the same request. X's direct message settings page reads its settings through GraphQL, so X may stop taking `allow_dms_from` and `allow_dm_groups_from` here. `allow_contributor_request` is left out, because X asks for the account's password to change it (error 114).

## Errors

A caller branches on the error's `type`. The exit code groups the types.

| Type | Exit code | Meaning |
|---|---|---|
| `usage` | 2 | Bad command line, including a missing `--account` |
| `missing_account` | 2 | A relay request without `x-profile-name` |
| `unknown_account` | 2 | The account is not in the configuration |
| `unknown_operation` | 2 | The operation is not in the registry, so it cannot be sent |
| `invalid_arguments` | 2 | The operation does not take these arguments, or X does not take this value |
| `forbidden_host` | 2 | A relay request whose Host is not 127.0.0.1 or localhost on the relay's port |
| `relay_unreachable` | 3 | The relay did not start or answer |
| `browser_down` | 3 | Moli did not start, or went away during a request |
| `timeout` | 4 | A step passed its deadline; `step` names it |
| `logged_out` | 5 | X shows a login page: the session cookies are missing or expired |
| `challenge` | 5 | X shows a challenge, lock or suspension page instead of the app |
| `wrong_account` | 5 | The session belongs to another screen name than configured |
| `client_not_found` | 5 | The page loaded but X's API client never appeared |
| `operation_not_on_page` | 6 | The page holds no definition for this GraphQL operation |
| `signature_rejected` | 6 | X refused the page's `x-client-transaction-id` with 404 code 34, so the request signer is wrong |
| `rate_limited` | 7 | X rate-limited the account; `retryAt` says when to try again |
| `flagged` | 7 | X answered 226, 326 or 344 (automation suspected, account locked, or daily limit); the account rests for an hour |
| `premium_required` | 8 | Bookmark folders need X Premium on this account |
| `not_found` | 9 | No such account |
| `x_error` | 10 | X answered with an error this tool has no name for; `status` and `codes` say what X sent |
| `internal` | 1 | A bug in x-cli |

## How it is built

- **Registry.** `src/registry.ts` is the only list of operations. Each entry gives a name, read or write, the GraphQL operation or REST path, an argument schema, a variables builder and a response reader. The relay refuses any other name before it starts a browser. The writes are list create, update, delete, add member and remove member; bookmark folder create, rename, delete, add tweet and remove tweet; and account settings.
- **Query IDs from the page.** The GraphQL query IDs and feature switches come from the webpack modules of the loaded x.com page (`src/page.ts`), not from a recorded catalog. The bridge keeps each module's original factory reachable for this (`packages/inject/setup.js`).
- **Relay.** `x-cli serve` is a local HTTP server on 127.0.0.1 that owns the browser. It refuses any request whose Host header is not 127.0.0.1 or localhost on its port, so a web page that rebinds its domain to 127.0.0.1 cannot call it. The command starts it when it is not running. It runs one account's Moli browser at a time and serves one request at a time. After 3 minutes without a request, it stops the browser and exits, because X's page runs its own timers while it is open. x-cli itself runs nothing on a timer against X.
- **Pacing.** `src/pacing.ts` ports the request limiter of `transitive-bullshit/bird`: 100 ms between requests, 5 s between searches, and a 15-minute cooldown after a 429. Writes wait 10 s between each other. An account that X flags with error 226, 326 or 344 rests for an hour. The state lives in one file per account, under a lock, so separate processes share it.
- **Deadlines.** Browser start, page load, client startup and every request have a deadline, so a dead or signed-out page gives a typed error instead of a hang.
- **Signed requests.** X's page signs each request with an `x-client-transaction-id` header that it computes from a paused CSS animation. Moli does not apply animations to the computed style the page reads, so the page computed a wrong value, and X answered 404 (code 34) to the account settings request and to its own settings page. `src/animations.ts` computes those animation values in the page before X's scripts load, so the signature matches Chrome's. `test/animations.test.ts` checks this against 64 animations recorded from Chromium 156: the color matches exactly and the rotation to five decimal places, closer than the two places the signature uses. The replaced functions keep the natives' name, length and properties, and the page's own `Function.prototype.toString` prints them as native code. Two differences remain, and the proxies cannot remove them: a fresh frame's own `toString` prints each as `function () { [native code] }` without its name, and a stack trace taken inside one has two more frames than the native's.

## Configuration

Defaults suit one machine. `~/.config/x-relay/config.json` (or the file `X_CLI_CONFIG` names) overrides any part. A typical file names the screen name each account must be signed in as. A session signed in as anyone else is stopped with `wrong_account`:

```json
{ "accounts": { "personal": { "screenName": "…" }, "pro": { "screenName": "…" } } }
```

Session cookies come from the environment: `X_PERSONAL_AUTH_TOKEN` and `X_PERSONAL_CT0` for `personal`, `X_PRO_*` for `pro`. The relay sets them in the browser over CDP before the page opens. State, Moli profiles and logs live in `~/.local/state/x-relay/<account>/` (mode 700). The relay listens on port 9360, and Moli on 9361.

## Tests

`pnpm --filter twitter-api-safe-x-cli test` runs offline. A mock x.com page (`test/support/mock-x.ts`) serves a webpack chunk with fake operation modules and a fake API client. The real command, relay, Moli and bridge run against it. Moli must be at `~/.local/bin/moli`. The mock signs with an animation's reading recorded from real Chromium in `test/fixtures/chromium-animations.json`; `node test/support/record-chromium-animations.ts` records it again.
