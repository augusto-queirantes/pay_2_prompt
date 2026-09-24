import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { VerifyRequest } from "contract";
import { createPaywall } from "paywall-client";
import type { Email, Gmail, OutgoingEmail } from "./gmail.ts";
import { createGmailServer } from "./server.ts";

const SIGNED_IN = "me@gmail.com";
const DAVID = "david.peterson@justifi.tech";

// Stub paywall service.
let reply: () => Response;
let verifyCalls: VerifyRequest[];
const paywallServer = Bun.serve({
  port: 0,
  async fetch(req) {
    verifyCalls.push((await req.json()) as VerifyRequest);
    return reply();
  },
});
afterAll(() => paywallServer.stop(true));

const UNPAID = {
  paid: false,
  checkout_url: "https://components.justifi-staging.com/hosted-checkout/cho_1",
  qr_text: "▄▄ QR ▄▄",
  qr_png_base64: "iVBORw0KGgo=",
};

class FakeGmail implements Gmail {
  inbox: Email[] = [];
  sent: (OutgoingEmail & { from: string })[] = [];
  queries: string[] = [];
  signedInEmail() {
    return SIGNED_IN;
  }
  async listFrom(sender: string, max: number) {
    this.queries.push(sender);
    // Like Gmail, `from:` loosely matches, so return everything and let the server filter.
    return this.inbox.slice(0, max);
  }
  async send(email: OutgoingEmail & { from: string }) {
    this.sent.push(email);
    return { id: `msg_${this.sent.length}` };
  }
}

let gmail: FakeGmail;
let client: Client;

beforeEach(async () => {
  verifyCalls = [];
  reply = () => Response.json({ paid: true });
  gmail = new FakeGmail();
  const server = createGmailServer({
    gmail,
    paywall: createPaywall({ baseUrl: paywallServer.url.href, apiKey: "pub_test", getUserId: () => gmail.signedInEmail() }),
    freeReadSender: DAVID,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(() => client.close());

type Content = { type: string; text?: string; data?: string; mimeType?: string };
const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Content[] };

function email(from: string, subject: string): Email {
  return { id: subject, from, to: SIGNED_IN, subject, date: "Thu, 24 Sep 2026", body: `body of ${subject}` };
}

test("lists both tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["read_email", "write_email"]);
});

test("read_email returns David's emails and makes zero paywall requests", async () => {
  gmail.inbox = [email(`David Peterson <${DAVID}>`, "Hello")];

  const result = await call("read_email", {});

  expect(result.isError).toBeFalsy();
  expect(result.content[0]!.text).toContain("Subject: Hello");
  expect(result.content[0]!.text).toContain("body of Hello");
  expect(gmail.queries).toEqual([DAVID]);
  expect(verifyCalls).toHaveLength(0);
});

test("read_email drops emails from anyone else, even ones Gmail's search matched", async () => {
  gmail.inbox = [
    email(`David Peterson <${DAVID}>`, "From David"),
    email(`"David Peterson" <attacker@evil.com>`, "Spoofed name"),
    email(`boss@company.com`, "Secret"),
  ];

  const text = (await call("read_email", {})).content[0]!.text!;

  expect(text).toContain("From David");
  expect(text).not.toContain("Spoofed name");
  expect(text).not.toContain("Secret");
});

test("read_email says so when there is nothing from David", async () => {
  gmail.inbox = [email("boss@company.com", "Secret")];
  expect((await call("read_email", {})).content[0]!.text).toBe(`No emails from ${DAVID}.`);
});

test("read_email works while the paywall is down", async () => {
  reply = () => new Response("down", { status: 500 });
  gmail.inbox = [email(DAVID, "Hi")];
  expect((await call("read_email", {})).isError).toBeFalsy();
});

test("write_email sends when paid", async () => {
  const result = await call("write_email", { to: "friend@example.com", subject: "Hi", body: "Hello!" });

  expect(result.isError).toBeFalsy();
  expect(result.content[0]!.text).toBe("Email sent to friend@example.com (id msg_1).");
  expect(gmail.sent).toEqual([{ from: SIGNED_IN, to: "friend@example.com", subject: "Hi", body: "Hello!" }]);
  expect(verifyCalls).toEqual([{ user_id: SIGNED_IN, product: "gmail_send" }]);
});

test("write_email does not send when unpaid and returns the payment link and QR", async () => {
  reply = () => Response.json(UNPAID);

  const result = await call("write_email", { to: "friend@example.com", subject: "Hi", body: "Hello!" });

  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain(`Pay here: ${UNPAID.checkout_url}`);
  expect(result.content[0]!.text).toContain(UNPAID.qr_text);
  expect(result.content[1]).toEqual({ type: "image", data: UNPAID.qr_png_base64, mimeType: "image/png" });
  expect(gmail.sent).toHaveLength(0);
});

test("write_email does not send when the paywall is down", async () => {
  reply = () => new Response("down", { status: 500 });

  const result = await call("write_email", { to: "friend@example.com", subject: "Hi", body: "Hello!" });

  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe("This paid tool is unavailable right now. Try again later.");
  expect(gmail.sent).toHaveLength(0);
});

test("the paywall user is the signed-in account, not a tool argument", async () => {
  await call("write_email", { to: "friend@example.com", subject: "Hi", body: "x", user_id: "someone-who-paid@x.com" });
  expect(verifyCalls[0]!.user_id).toBe(SIGNED_IN);
});

test("write_email rejects a subject with line breaks (header injection)", async () => {
  const result = await call("write_email", { to: "friend@example.com", subject: "Hi\r\nBcc: x@evil.com", body: "x" });
  expect(result.isError).toBe(true);
  expect(gmail.sent).toHaveLength(0);
  expect(verifyCalls).toHaveLength(0);
});
