# JustiFi setup spec

How we set up the JustiFi tenant and get it ready to receive payments in test mode. At the end of this spec we have test API credentials, one enabled test sub account, and one checkout paid end to end with a test card.

Sources, read on 2026-09-24:
[Getting Started](https://docs.justifi.tech/gettingStarted)
[API spec](https://docs.justifi.tech/api-spec)
[Hosted Checkout](https://docs.justifi.tech/checkouts/hosted-checkout)
[Checkout lifecycle](https://docs.justifi.tech/checkouts/lifecycle)
[Card testing](https://docs.justifi.tech/testing/card_payments), and `justifi-tech/public-docs` (`openapi/docs/description.md`, `openapi/docs/hosted_onboarding.md`, `openapi/multi-yaml/paths/entities_*.yaml`).

## How JustiFi maps to our product

| JustiFi concept         | What it is in Pay2Prompt                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Platform (tenant)       | Pay2Prompt. Owns the API keys and creates checkouts.                                                           |
| Test account            | The tenant's sandbox. `test_` keys hit it and no real money moves.                                             |
| Sub account (`acc_...`) | The publisher who gets paid, for example the Gmail MCP. It goes in the `Sub-Account` header of every checkout. |
| Business (`biz_...`)    | The legal entity behind a sub account. Provisioning a business creates the sub account.                        |
| Checkout (`cho_...`)    | One purchase of one product by one user.                                                                       |
| Hosted Checkout         | JustiFi's payment page for a checkout. Card data never touches us.                                             |

Currency is per sub account (USD or CAD). The checkout API has no currency field. We use a USD sub account.

## Steps

1. **Create the tenant.** Create the platform in test mode (in progress). Make sure the whole team can log in to the JustiFi dashboard (https://app.justifi.ai) and switch to Test Mode. Source: [Getting Started > Testing Your Integration](https://docs.justifi.tech/gettingStarted#testing-your-integration), which says the sandbox "can be accessed via API and on the JustiFi dashboard via Test Mode", and [Getting Started > Resources](https://docs.justifi.tech/gettingStarted#resources), which lists "Developer Dashboard: https://app.justifi.ai -> Developers".
2. **Create a test API key.** In the dashboard, go to Developers > API Keys in Test Mode. You get a `client_id` and `client_secret` with the `test_` prefix. The secret is shown only once, so save it in the team password manager right away. Source: [API spec > Getting Started](https://docs.justifi.tech/api-spec#section/Getting-Started), sections "Get Your API Keys" and "Authenticate With JustiFi".
3. **Save the credentials locally.** Put them in `pay_2_prompt/.env`, which is already in `.gitignore`:
   ```
   JUSTIFI_CLIENT_ID=test_...
   JUSTIFI_CLIENT_SECRET=...
   ```
4. **Check the credentials.** Request a token:
   ```sh
   curl -s -X POST $JUSTIFI_API_URL/oauth/token \
     -H 'Content-Type: application/json' \
     --data "{\"client_id\":\"$JUSTIFI_CLIENT_ID\",\"client_secret\":\"$JUSTIFI_CLIENT_SECRET\"}"
   ```
   The response is `{"access_token": "..."}`, valid for 24 hours, with no refresh token. Export it as `TOKEN` for the next steps.
5. **Create the publisher's business.** Only `legal_name` is required:
   ```sh
   curl -s -X POST $JUSTIFI_API_URL/v1/entities/business \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data '{"legal_name":"Pay2Prompt Demo Publisher"}'
   ```
   Keep the returned `biz_...` id.
6. **Provision the business for payments.** This creates the sub account:
   ```sh
   curl -s -X POST $JUSTIFI_API_URL/v1/entities/provisioning \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data '{"business_id":"biz_...","product_category":"payment"}'
   ```
   The response has `sub_account_id` (`acc_...`) and `account_type: "test"`. Do not use `POST /v1/sub_accounts`, which is deprecated.
7. **Check that the sub account is enabled.**
   ```sh
   curl -s $JUSTIFI_API_URL/v1/sub_accounts/acc_... -H "Authorization: Bearer $TOKEN"
   ```
   Possible `status` values are `created | submitted | information_needed | rejected | enabled | disabled | archived`. Only `enabled` can process payments. In live mode, underwriting takes 1-2 business days. If the test sub account doesn't reach `enabled` on its own, ask the platform team to enable it or to hand over an existing enabled test sub account (open question 1).
8. **Save the sub account id** in `.env` as `JUSTIFI_SUB_ACCOUNT_ID=acc_...`. The paywall config file reads it.
9. **Smoke test a checkout.** This settles open question 2:
   1. Create one:
      ```sh
      curl -s -X POST $JUSTIFI_API_URL/v1/checkouts \
        -H "Authorization: Bearer $TOKEN" -H "Sub-Account: $JUSTIFI_SUB_ACCOUNT_ID" \
        -H 'Content-Type: application/json' \
        --data '{"amount":500,"description":"pay2prompt smoke test","metadata":{"source":"smoke"}}'
      ```
   2. Open `$JUSTIFI_HOSTED_CHECKOUT_URL/<cho_id>` in a browser. Staging is `https://components.justifi-staging.com/hosted-checkout` and production is `https://components.justifi.ai/hosted-checkout` (source: `infra/fastify/{staging,production}/customer-portal/api/ecs/bff/task/container_definitions.json.tpl:113`).
   3. Pay with card `4242424242424242`, a future expiry (the docs example `12/2025` is already past), and CVC `123`.
   4. Run `GET $JUSTIFI_API_URL/v1/checkouts/<cho_id>` and confirm `status: "completed"` and a non-null `successful_payment_id`.
   5. Check that the payment shows up in the dashboard under Test Mode.

## Done when

- `.env` has `JUSTIFI_CLIENT_ID`, `JUSTIFI_CLIENT_SECRET` and `JUSTIFI_SUB_ACCOUNT_ID`, and none of them is committed.
- `GET /v1/sub_accounts/<id>` returns `status: "enabled"`.
- One smoke test checkout reached `completed` after paying on the hosted page.
- The hosted checkout URL that worked is written into `checkout_spec.md`.

## Rules

- Test keys only. Never put a `live_` key in `.env` or in the config file.
- The client secret stays on the paywall service. It never goes into an MCP server or an agent prompt.
- Every API call goes to `$JUSTIFI_API_URL` (set in `.env`). Production is `https://api.justifi.ai`.

## Open questions

1. Does a test-mode sub account created by provisioning become `enabled` automatically, or does the platform team have to enable it? Blocks step 7.
2. Does `components.justifi.ai/hosted-checkout/<id>` work for test-mode checkouts, does it need `https://`, and does the checkout need `origin_url`? The API spec says `origin_url` is only required for web components. Blocks step 9.
