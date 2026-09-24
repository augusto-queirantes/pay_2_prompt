import { expect, test } from "bun:test";
import { addressOf, buildMime, createGmail } from "./gmail.ts";

test("addressOf pulls the address out of a From header", () => {
  expect(addressOf("David Peterson <David.Peterson@JustiFi.tech>")).toBe("david.peterson@justifi.tech");
  expect(addressOf("david.peterson@justifi.tech")).toBe("david.peterson@justifi.tech");
});

test("buildMime writes headers and a base64 UTF-8 body", () => {
  const mime = buildMime({ from: "me@gmail.com", to: "you@example.com", subject: "Olá", body: "Ação ✓" });
  const [head, body] = mime.split("\r\n\r\n");

  expect(head).toContain("From: me@gmail.com");
  expect(head).toContain("To: you@example.com");
  expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from("Olá").toString("base64")}?=`);
  expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Ação ✓");
});

test("buildMime refuses header injection", () => {
  expect(() => buildMime({ from: "me@gmail.com", to: "a@b.c\r\nBcc: x@evil.com", subject: "s", body: "b" })).toThrow(
    "line breaks",
  );
});

test("listFrom searches by sender and decodes the text/plain part", async () => {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    if (String(input).includes("/messages?")) return Response.json({ messages: [{ id: "m1" }] });
    return Response.json({
      id: "m1",
      snippet: "snip",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "David <david.peterson@justifi.tech>" },
          { name: "Subject", value: "Hi" },
          { name: "Date", value: "today" },
        ],
        parts: [
          { mimeType: "text/html", body: { data: Buffer.from("<b>x</b>").toString("base64url") } },
          { mimeType: "text/plain", body: { data: Buffer.from("Hello there").toString("base64url") } },
        ],
      },
    });
  }) as typeof globalThis.fetch;

  const gmail = createGmail({ email: "me@gmail.com", accessToken: async () => "tok", fetch });
  const [email] = await gmail.listFrom("david.peterson@justifi.tech", 3);

  expect(urls[0]).toBe(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Adavid.peterson%40justifi.tech&maxResults=3",
  );
  expect(email).toMatchObject({ from: "David <david.peterson@justifi.tech>", subject: "Hi", body: "Hello there" });
});
