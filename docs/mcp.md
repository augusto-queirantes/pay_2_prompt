# MCP integration spec

How a publisher's MCP server imports our helper and gates a paid tool so it runs only when the user has paid. The helper lives in `src/paywall-client`. The demo consumer is `src/gmail-mcp`. The service it calls is described in `checkout_spec.md`.

## What the publisher writes

```ts
import { createPaywall } from "paywall-client";

const paywall = createPaywall({
  baseUrl: process.env.PAYWALL_URL!,
  apiKey: process.env.PAYWALL_PUBLISHER_KEY!,
  getUserId: () => gmail.signedInEmail(),
});

server.registerTool("read_email", { description, inputSchema }, readEmail);

server.registerTool(
  "write_email",
  { description, inputSchema },
  paywall.require("gmail_send", writeEmail),
);
```

- Free tools are registered as usual. They never call the paywall, so they keep working if the paywall is down.
- Paid tools are wrapped in `paywall.require(product, handler)`.

## API

### `createPaywall({ baseUrl, apiKey, getUserId })`

| Option      | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `baseUrl`   | Paywall service URL, for example `http://localhost:4242`                         |
| `apiKey`    | Publisher key from `paywall.config.json`, sent as `X-Publisher-Key`              |
| `getUserId` | `() => string \| Promise<string>`. Returns the user from the server's own login. |

`getUserId` is the security boundary. The user id comes from the server's own login, which is the signed-in Gmail address in the demo. It never comes from tool arguments or from anything the agent sends.

### `paywall.verify(product): Promise<VerifyResponse>`

This is the low-level check:

1. Calls `getUserId()`.
2. Sends `POST {baseUrl}/v1/verify` with `{user_id, product}`.
3. Returns `{paid: true}`, or `{paid: false, checkout_url, qr_text, qr_png_base64}`.

It throws on a network error or any non-2xx response. Use it when a publisher wants to gate something that isn't a tool handler.

### `paywall.require(product, handler)`

Returns a handler with the same signature as `handler`. On each call it runs `verify(product)`:

| Verify outcome                       | Tool result                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `{paid: true}`                       | Runs `handler` and returns its result unchanged                                                                    |
| `{paid: false, ...}`                 | Does **not** run `handler`. Returns the payment-required result below.                                             |
| Throws (paywall down, 401, 404, 5xx) | Does **not** run `handler`. Returns `isError: true`, `"This paid tool is unavailable right now. Try again later."` |

It fails closed: the handler runs only after an explicit `{paid: true}`.

Payment-required result:

```ts
{
  isError: true,
  content: [
    {
      type: "text",
      text: [
        "This tool needs a one-time payment.",
        `Pay here: ${checkout_url}`,
        qr_text,
        "Once you have paid, ask me to try again.",
      ].join("\n\n"),
    },
    { type: "image", data: qr_png_base64, mimeType: "image/png" },
  ],
}
```

- `isError: true` keeps the agent from treating the call as a success.
- The text asks the user, not the agent, to retry. That stops the agent from polling verify in a loop.
- Terminal harnesses show the Unicode QR. Harnesses that render images show the PNG.

## Flow

1. The agent calls `write_email`.
2. The wrapper calls `getUserId()`, which returns `someone@gmail.com`.
3. The wrapper sends `POST /v1/verify {user_id, product: "gmail_send"}`.
4. If the response is `paid: true`, `writeEmail` runs and the email is sent.
5. If it's `paid: false`, the agent shows the link and QR. The user pays on JustiFi's hosted checkout, then says "try again", which goes back to step 1. This time verify reads `completed` from JustiFi and returns `paid: true`.

## Gmail demo MCP (`src/gmail-mcp`)

- A stdio server built with `@modelcontextprotocol/sdk` and `server.registerTool`.
- `bun run gmail:auth` runs the Google OAuth desktop flow. The scopes are `gmail.readonly` and `gmail.send`, and the token file path comes from env.
- `gmail.signedInEmail()` reads the address from the stored token. This is the `user_id`.
- Tools:
  - `read_email` is free. It returns recent messages (sender, subject, date, body) from one allowed sender, `david.peterson@justifi.tech` by default (`FREE_READ_SENDER`). The server checks each message's From address, because Gmail's `from:` search also matches display names.
  - `write_email(to, subject, body)` is paid and wrapped with `paywall.require("gmail_send", ...)`.
- Env: `PAYWALL_URL`, `PAYWALL_PUBLISHER_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_PATH`, `FREE_READ_SENDER`.
- Add it to Claude Code with `claude mcp add gmail-demo -- bun run src/gmail-mcp/index.ts`, plus the env vars.

## Enforcement caveat

The check runs inside the MCP server. That's the right place, because a prompt or a modified agent can't skip server code. In this demo, though, the server is a local stdio process on the user's own laptop, so the user could edit it. The demo shows the flow, not real enforcement. In production the MCP is hosted over HTTP, where the publisher controls both the code and the login. The pitch has to say this.

## Stretch: URL elicitation

If the client declares URL-mode elicitation support (MCP spec 2025-11-25 `elicitation/create` with `mode: "url"`, or 2026-07-28 `InputRequiredResult`, supported by Claude Code 2.1.281), the unpaid path opens the checkout URL as a native prompt instead of returning the text result. When the user accepts, it only means they opened the page. The wrapper still calls `verify` again before running the handler. Clients without support get the text and QR result unchanged.

## Tests

Run with `bun test` against a stubbed paywall HTTP server:

- `paid: true` runs the handler and returns its result as is.
- `paid: false` doesn't run the handler, and returns `isError`, the link, the QR text and the PNG block.
- A paywall that is down, or returns 401, 404 or 500, doesn't run the handler and returns the unavailable message.
- `user_id` sent to verify equals `getUserId()` even when the tool arguments contain a `user_id` field.
- `read_email` makes zero requests to the paywall.
