import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Publisher } from "./config.ts";
import { openStore, type CheckoutStatus, type Store } from "./store.ts";
import type { Checkout, CreateCheckoutInput } from "./types/clients/justifi.types.ts";
import { createVerifyHandler } from "./verify.ts";

const PUBLISHER: Publisher = {
  id: "gmail-demo",
  api_key: "pub_test",
  sub_account_id: "acc_1",
  products: { gmail_send: { amount: 500, description: "Gmail MCP: send email (lifetime)" } },
};
const USER = "someone@gmail.com";
const HOSTED = "https://hosted.test/hosted-checkout";

/** Fake JustiFi: `checkouts` is the remote state; calls are recorded. */
class FakeJustifi {
  checkouts = new Map<string, CheckoutStatus>();
  created: CreateCheckoutInput[] = [];
  fetched: string[] = [];
  failWith: unknown = null;
  private seq = 0;

  async createCheckout(input: CreateCheckoutInput) {
    if (this.failWith) throw this.failWith;
    this.created.push(input);
    const id = `cho_new${++this.seq}`;
    this.checkouts.set(id, "created");
    return { id, status: "created" as const };
  }
  async getCheckout(id: string): Promise<Checkout> {
    if (this.failWith) throw this.failWith;
    this.fetched.push(id);
    const status = this.checkouts.get(id)!;
    return { id, status, successfulPaymentId: status === "completed" ? "py_1" : null };
  }
  hostedCheckoutUrl(id: string) {
    return `${HOSTED}/${id}`;
  }
}

let store: Store;
let justifi: FakeJustifi;
let verify: (req: Request) => Promise<Response>;

beforeEach(() => {
  store = openStore(":memory:");
  justifi = new FakeJustifi();
  verify = createVerifyHandler({
    publishers: [PUBLISHER],
    store,
    justifi,
    now: () => new Date("2026-09-24T12:00:00.000Z"),
  });
});

afterEach(() => store.close());

function call(body: unknown, key: string | null = "pub_test") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers["X-Publisher-Key"] = key;
  return verify(
    new Request("http://localhost/v1/verify", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const ok = { user_id: USER, product: "gmail_send" };

function seed(checkoutId: string, local: CheckoutStatus, remote: CheckoutStatus = local) {
  store.insert({
    checkout_id: checkoutId,
    publisher: "gmail-demo",
    user_id: USER,
    product: "gmail_send",
    status: local,
    created_at: "2026-09-20T00:00:00.000Z",
  });
  justifi.checkouts.set(checkoutId, remote);
}

async function expectUnpaid(res: Response, checkoutId: string) {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.paid).toBe(false);
  expect(body.checkout_url).toBe(`${HOSTED}/${checkoutId}`);
  expect(body.qr_text.length).toBeGreaterThan(0);
  // PNG magic bytes
  expect(Buffer.from(body.qr_png_base64, "base64").subarray(1, 4).toString()).toBe("PNG");
}

test("missing publisher key is 401", async () => {
  const res = await call(ok, null);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unknown_publisher" });
});

test("unknown publisher key is 401", async () => {
  const res = await call(ok, "nope");
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unknown_publisher" });
});

test("unknown product is 404", async () => {
  const res = await call({ user_id: USER, product: "gmail_delete" });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "unknown_product" });
});

test("inherited object keys are not products", async () => {
  const res = await call({ user_id: USER, product: "toString" });
  expect(res.status).toBe(404);
});

for (const [name, body] of [
  ["not JSON", "{"],
  ["missing user_id", { product: "gmail_send" }],
  ["empty user_id", { user_id: "", product: "gmail_send" }],
  ["non-string product", { user_id: USER, product: 1 }],
  ["array body", [ok]],
] as const) {
  test(`bad body (${name}) is 400`, async () => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
}

test("completed row is paid without calling JustiFi", async () => {
  seed("cho_1", "completed");
  const res = await call(ok);
  expect(await res.json()).toEqual({ paid: true });
  expect(justifi.fetched).toEqual([]);
  expect(justifi.created).toEqual([]);
});

test("open row that is now completed is paid and the row is updated", async () => {
  seed("cho_1", "created", "completed");
  const res = await call(ok);
  expect(await res.json()).toEqual({ paid: true });
  expect(store.findLatest("gmail-demo", USER, "gmail_send")?.status).toBe("completed");

  // The next call is answered from SQLite alone.
  await call(ok);
  expect(justifi.fetched).toEqual(["cho_1"]);
});

test("open row still open returns the same checkout URL", async () => {
  seed("cho_1", "created", "attempted");
  await expectUnpaid(await call(ok), "cho_1");
  expect(justifi.created).toEqual([]);
  expect(store.findLatest("gmail-demo", USER, "gmail_send")?.status).toBe("attempted");
});

test("expired row creates a new checkout", async () => {
  seed("cho_1", "attempted", "expired");
  await expectUnpaid(await call(ok), "cho_new1");
  expect(justifi.created).toHaveLength(1);
  const latest = store.findLatest("gmail-demo", USER, "gmail_send");
  expect(latest?.checkout_id).toBe("cho_new1");
});

test("stored expired row creates a new checkout without refetching", async () => {
  seed("cho_1", "expired");
  await expectUnpaid(await call(ok), "cho_new1");
  expect(justifi.fetched).toEqual([]);
});

test("no row creates a checkout with the product price and metadata", async () => {
  await expectUnpaid(await call(ok), "cho_new1");
  expect(justifi.created).toEqual([
    {
      subAccountId: "acc_1",
      amount: 500,
      description: "Gmail MCP: send email (lifetime)",
      metadata: { user_id: USER, product: "gmail_send", publisher: "gmail-demo" },
    },
  ]);
  expect(store.findLatest("gmail-demo", USER, "gmail_send")).toEqual({
    checkout_id: "cho_new1",
    publisher: "gmail-demo",
    user_id: USER,
    product: "gmail_send",
    status: "created",
    created_at: "2026-09-24T12:00:00.000Z",
  });
});

test("JustiFi error is 502", async () => {
  // SDK errors are plain objects, not Error instances.
  justifi.failWith = { code: 500, message: "boom" };
  const res = await call(ok);
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "payment_provider_unavailable" });
});

test("JustiFi error on refresh is 502", async () => {
  seed("cho_1", "created");
  // After retries the SDK rejects with the list of errors.
  justifi.failWith = [{ code: 500, message: "connect ECONNREFUSED" }];
  const res = await call(ok);
  expect(res.status).toBe(502);
});
