# pay_2_prompt

## Setup

1. Install [mise](https://mise.jdx.dev/getting-started.html).
2. Clone the repo and enter it:

   ```sh
   git clone <repo-url>
   cd pay_2_prompt
   ```

3. Install Bun and Node at the versions pinned in `mise.toml`:

   ```sh
   mise install
   ```

4. Install dependencies:

   ```sh
   bun install
   ```

## Run

Type-check the code:

```sh
bun run typecheck
```


## Paywall service

1. Copy the examples and fill them in (see `docs/justifi_spec.md` for the JustiFi values):

   ```sh
   cp .env.example .env
   cp paywall.config.example.json paywall.config.json
   ```

   In `paywall.config.json`, a string like `"$JUSTIFI_SUB_ACCOUNT_ID"` is read from the environment.

2. Start it on `http://localhost:4242`:

   ```sh
   bun run paywall
   ```

## Testing

SQLite is a file, not a server: the service opens `paywall.sqlite` (or `$PAYWALL_DB_PATH`) directly.

1. **Unit tests.** They use real SQLite (temp files and `:memory:`) and fake JustiFi, so they need no keys:

   ```sh
   bun test
   ```

2. **Local end to end.** This starts a fake JustiFi (`scripts/fake-justifi.ts`) and the real service with a temp SQLite file. It runs the whole pay flow through `paywall-client`, then restarts the service to check that paid state survives:

   ```sh
   bun run e2e
   ```

3. **Docker.** This runs the service in a container with SQLite on the `paywall-data` volume, next to the fake JustiFi:

   ```sh
   docker compose up --build -d
   E2E_PAYWALL_URL=http://localhost:4242 E2E_JUSTIFI_URL=http://localhost:4999 bun run e2e
   docker compose down        # add -v to also delete the SQLite volume
   ```

   To try it by hand, call verify and open the `checkout_url` it returns. It's a fake page with a Pay button:

   ```sh
   curl -s -X POST localhost:4242/v1/verify -H 'X-Publisher-Key: pub_e2e' \
     -H 'Content-Type: application/json' -d '{"user_id":"me@test.com","product":"gmail_send"}'
   ```

   Look inside the database:

   ```sh
   docker compose exec paywall bun -e 'import {Database} from "bun:sqlite"; console.table(new Database("/data/paywall.sqlite").query("select * from checkouts").all())'
   ```

4. **Real JustiFi test mode.** Once `.env` is filled in (see `docs/justifi_spec.md`), start the `paywall-justifi` service. It runs on port 4243, next to the fake stack, with its own SQLite volume:

   ```sh
   cp paywall.config.example.json paywall.config.json   # once; sub_account_id comes from $JUSTIFI_SUB_ACCOUNT_ID
   docker compose up --build -d paywall-justifi
   curl -s -X POST localhost:4243/v1/verify -H 'X-Publisher-Key: pub_test_change_me' \
     -H 'Content-Type: application/json' -d '{"user_id":"me@test.com","product":"gmail_send"}' | jq -r .checkout_url
   ```

   Pay the link with card `4242 4242 4242 4242` (any future expiry, CVC `123`), then run the curl again. It returns `{"paid":true}`.

## Gmail demo MCP

`src/gmail-mcp` is a stdio MCP server with two tools:

- `read_email` is free. It only returns emails from `david.peterson@justifi.tech` (override with `FREE_READ_SENDER`). It checks each sender's address, not just Gmail's search, and never calls the paywall.
- `write_email(to, subject, body)` is paid. It's wrapped in `paywall.require("gmail_send", ...)`, so it only sends after the paywall answers `paid: true` for the signed-in Gmail address.

Setup:

1. **Create a Google OAuth client.** In Google Cloud Console, go to APIs & Services:
   1. Enable the **Gmail API**.
   2. On the OAuth consent screen, add your Gmail address as a test user.
   3. Under Credentials, create an **OAuth client ID** of type **Desktop app**.
   4. Put its id and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
2. **Sign in.** This opens Google's consent page and saves a refresh token plus your address to `~/.config/pay2prompt/gmail-token.json` (or `$GMAIL_TOKEN_PATH`):

   ```sh
   bun run gmail:auth
   ```

3. **Start the paywall.** Use `docker compose up -d paywall-justifi` for real JustiFi on port 4243, or the fake stack on 4242.
4. **Add it to Claude Code:**

   ```sh
   claude mcp add gmail-demo \
     -e PAYWALL_URL=http://localhost:4243 \
     -e PAYWALL_PUBLISHER_KEY=pub_test_change_me \
     -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
     -- bun run "$PWD/src/gmail-mcp/index.ts"
   ```

Then ask Claude to read David's latest email (free), or to send an email. The first send returns a payment link and QR. Pay it, say "try again", and the email is sent.
