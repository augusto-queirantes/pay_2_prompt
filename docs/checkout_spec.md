# Checkout spec

How the paywall service creates and manages JustiFi checkouts and answers `POST /v1/verify`. This spec assumes `justifi_spec.md` is done: test credentials and an enabled sub account exist.

## Shape

```
MCP server --POST /v1/verify--> paywall service --> JustiFi API
                                      |
                                   SQLite
```

- The paywall service is a Bun HTTP server on localhost: `packages/paywall-service`.
- It holds the JustiFi secret. MCP servers only hold a publisher API key.
- It uses nothing but the Bun runtime plus `qrcode`: `Bun.serve` for HTTP, `bun:sqlite` for storage and `fetch` for JustiFi.

## Configuration

Environment variables (`.env`, gitignored):

| Var | Purpose |
|---|---|
| `JUSTIFI_CLIENT_ID`, `JUSTIFI_CLIENT_SECRET` | Test API key |
| `JUSTIFI_API_URL` | JustiFi API base URL |
| `JUSTIFI_HOSTED_CHECKOUT_URL` | Hosted checkout base, for example `https://components.justifi-staging.com/hosted-checkout` |
| `PAYWALL_CONFIG_PATH` | Publishers file, default `paywall.config.json` |
| `PAYWALL_DB_PATH` | SQLite file, default `paywall.sqlite` |
| `PORT` | Default `4242` |

Publishers file. It is gitignored, and `paywall.config.example.json` is committed:

```json
{
  "publishers": [
    {
      "id": "gmail-demo",
      "api_key": "pub_test_change_me",
      "sub_account_id": "acc_...",
      "products": {
        "gmail_send": { "amount": 500, "description": "Gmail MCP: send email (lifetime)" }
      }
    }
  ]
}
```

`amount` is in cents and must be an integer greater than 50.

## JustiFi client

The client lives in `packages/paywall-service/src/justifi.ts`. All calls go to `$JUSTIFI_API_URL`.

| Function | Call | Notes |
|---|---|---|
| `getToken()` | `POST /oauth/token` `{client_id, client_secret}` | The token lasts 24h. Cache it in memory. On any `401`, clear the cache and retry once. |
| `createCheckout({subAccountId, amount, description, metadata})` | `POST /v1/checkouts` with the `Sub-Account` header | Returns `{id, status}` from `data`. `metadata = {user_id, product, publisher}`, used for tracing in the dashboard only. |
| `getCheckout(id)` | `GET /v1/checkouts/{id}` | Returns `{id, status, successful_payment_id}` from `data`. |
| `hostedCheckoutUrl(id)` | none | `${JUSTIFI_HOSTED_CHECKOUT_URL}/{id}`. Confirm it with smoke test step 9 in `justifi_spec.md`. |

Any non-2xx response, other than the one `401` retry, throws an error that carries the HTTP status and the response body.

Checkout statuses from the [lifecycle docs](https://docs.justifi.tech/checkouts/lifecycle):

| Status | Meaning | Paid? |
|---|---|---|
| `created` | Nobody has tried to pay yet | no |
| `attempted` | At least one payment failed, and the user can try again on the same page | no |
| `completed` | A payment succeeded, so `successful_payment_id` is set | **yes** |
| `expired` | One week passed without payment | no, and it can never be paid |

## Storage

The store lives in `packages/paywall-service/src/store.ts` and uses `bun:sqlite`. It has one table, created on startup if missing:

```sql
CREATE TABLE IF NOT EXISTS checkouts (
  checkout_id TEXT PRIMARY KEY,
  publisher   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  product     TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkouts_lookup ON checkouts (publisher, user_id, product, created_at);
```

It exposes three functions:
- `findLatest(publisher, user_id, product)`: the newest row, or `null`.
- `insert(row)`.
- `markStatus(checkout_id, status)`.

We need the table because JustiFi can't list checkouts by metadata. `GET /v1/checkouts` filters only by `created_before`, `created_after`, `payment_mode`, `payment_status`, `status`, `checkout_id` and `successful_payment_id`, per `hosted-checkout-be` `app/controllers/v1/checkouts_controller.rb:13`.

## `POST /v1/verify`

The request carries the header `X-Publisher-Key: <publisher api_key>` and this body:

```json
{ "user_id": "someone@gmail.com", "product": "gmail_send" }
```

Responses:

| Case | Status | Body |
|---|---|---|
| Paid | 200 | `{"paid": true}` |
| Not paid | 200 | `{"paid": false, "checkout_url": "https://...", "qr_text": "<unicode QR>", "qr_png_base64": "<base64 png>"}` |
| Missing or unknown key | 401 | `{"error": "unknown_publisher"}` |
| Product not in publisher config | 404 | `{"error": "unknown_product"}` |
| Bad body | 400 | `{"error": "invalid_request"}` |
| JustiFi failed | 502 | `{"error": "payment_provider_unavailable"}` |

The TypeScript types live in `packages/contract` and are shared with the MCP side.

### Algorithm

1. Look up the publisher by `X-Publisher-Key`. If there's no match, return 401.
2. Look up `product` in that publisher's products. If there's no match, return 404.
3. Load `row = findLatest(publisher.id, user_id, product)`.
4. If `row.status === "completed"`, return `{paid: true}`. JustiFi isn't called.
5. If `row.status` is `created` or `attempted`:
   1. Call `getCheckout(row.checkout_id)` and then `markStatus` with the result.
   2. If the result is `completed`, return `{paid: true}`.
   3. If it's still `created` or `attempted`, return `{paid: false}` with the same checkout's URL and QR, so the user keeps one link.
   4. If it's `expired`, go to step 6.
6. If there's no row, or the row is `expired`:
   1. Call `createCheckout` with the publisher's `sub_account_id` and the product's `amount` and `description`.
   2. `insert` the row.
   3. Return `{paid: false}` with its URL and QR.

The QR comes from the `qrcode` package:
- `qr_text = await QRCode.toString(url, {type: "terminal", small: true})`
- `qr_png_base64 = (await QRCode.toDataURL(url)).split(",")[1]`

## Purchase model

- One-time purchase. One `completed` checkout per (publisher, user_id, product) unlocks that product forever.
- No webhooks. Payment status is read on the next verify call, so the paywall doesn't need a public URL.
- No refund or dispute handling. A refunded payment stays unlocked, because the `completions` history on JustiFi doesn't change on refund either.

## Known limits (accepted for the demo)

- If two verify calls for the same user and product arrive at the same moment with no row yet, each one creates a checkout. Either one can be paid, and `findLatest` picks the newest. If the user pays the older one, it isn't seen as paid. This is unlikely with one user typing in one agent.
- Each paid verify costs one SQLite read. Unpaid verifies also make one JustiFi call, with no caching.

## Tests

Run with `bun test`. The JustiFi client is mocked through `fetch`.

- `getToken` is fetched once for two calls, and refetched after a `401`.
- `createCheckout` sends the `Sub-Account` header and the right body.
- Verify has a test for every branch: 401, 404, 400, completed row, open row that is now completed, open row still open (same URL), expired row (new checkout), no row (new checkout plus metadata), and JustiFi error (502).
- The store: `findLatest` with zero, one and many rows, and data survives reopening the file.
