import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { VerifyRequest, VerifyResponse } from "contract";
import { createPaywall, UNAVAILABLE_MESSAGE } from "./index.ts";

// Stub paywall service: each test sets `reply`, and requests are recorded.
let reply: () => Response;
let requests: { headers: Headers; body: VerifyRequest }[];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    requests.push({ headers: req.headers, body: (await req.json()) as VerifyRequest });
    return reply();
  },
});

afterAll(() => server.stop(true));

beforeEach(() => {
  requests = [];
});

const UNPAID = {
  paid: false,
  checkout_url: "https://components.justifi-staging.com/hosted-checkout/cho_1",
  qr_text: "▄▄▄ QR ▄▄▄",
  qr_png_base64: "iVBORw0KGgo=",
} satisfies VerifyResponse;

function paywall(baseUrl = server.url.href) {
  return createPaywall({ baseUrl, apiKey: "pub_test", getUserId: () => "someone@gmail.com" });
}

test("paid: true runs the handler and returns its result as is", async () => {
  reply = () => Response.json({ paid: true });
  const handlerResult = { content: [{ type: "text", text: "sent" }] };
  const handler = mock((_args: { to: string }) => handlerResult);

  const result = await paywall().require("gmail_send", handler)({ to: "a@b.c" });

  expect(result).toBe(handlerResult);
  expect(handler).toHaveBeenCalledWith({ to: "a@b.c" });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get("X-Publisher-Key")).toBe("pub_test");
  expect(requests[0]!.body).toEqual({ user_id: "someone@gmail.com", product: "gmail_send" });
});

test("paid: false skips the handler and returns the payment-required result", async () => {
  reply = () => Response.json(UNPAID);
  const handler = mock(() => "ran");

  const result = await paywall().require("gmail_send", handler)();

  expect(handler).not.toHaveBeenCalled();
  expect(result).toEqual({
    isError: true,
    content: [
      {
        type: "text",
        text: [
          "This tool needs a one-time payment.",
          `Pay here: ${UNPAID.checkout_url}`,
          UNPAID.qr_text,
          "Once you have paid, ask me to try again.",
        ].join("\n\n"),
      },
      { type: "image", data: UNPAID.qr_png_base64, mimeType: "image/png" },
    ],
  });
});

for (const status of [401, 404, 500]) {
  test(`paywall returning ${status} skips the handler and returns unavailable`, async () => {
    reply = () => Response.json({ error: "x" }, { status });
    const handler = mock(() => "ran");

    const result = await paywall().require("gmail_send", handler)();

    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] });
  });
}

test("paywall down skips the handler and returns unavailable", async () => {
  const down = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = down.url.href;
  await down.stop(true);
  const handler = mock(() => "ran");

  const result = await paywall(url).require("gmail_send", handler)();

  expect(handler).not.toHaveBeenCalled();
  expect(result).toEqual({ isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] });
});

test("a malformed 200 body fails closed", async () => {
  reply = () => Response.json({ paid: "yes" });
  const handler = mock(() => "ran");

  const result = await paywall().require("gmail_send", handler)();

  expect(handler).not.toHaveBeenCalled();
  expect(result).toEqual({ isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] });
});

test("user_id comes from getUserId, never from tool arguments", async () => {
  reply = () => Response.json({ paid: true });
  const handler = mock((_args: { user_id: string }) => "ran");

  await paywall().require("gmail_send", handler)({ user_id: "attacker@evil.com" });

  expect(requests[0]!.body.user_id).toBe("someone@gmail.com");
});

test("verify returns the service response", async () => {
  reply = () => Response.json(UNPAID);
  expect(await paywall().verify("gmail_send")).toEqual(UNPAID);
});

test("verify throws on non-2xx", async () => {
  reply = () => Response.json({ error: "unknown_product" }, { status: 404 });
  await expect(paywall().verify("nope")).rejects.toThrow("404");
});
