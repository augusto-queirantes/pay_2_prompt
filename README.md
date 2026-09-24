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
