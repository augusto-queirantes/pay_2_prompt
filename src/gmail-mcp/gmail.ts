const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
}

export interface Gmail {
  /** The signed-in address, from the stored token. This is the paywall user id. */
  signedInEmail(): string;
  /** Newest messages from `sender`, at most `max`. */
  listFrom(sender: string, max: number): Promise<Email[]>;
  send(email: OutgoingEmail & { from: string }): Promise<{ id: string }>;
}

interface GmailPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
}

export function createGmail(options: {
  email: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}): Gmail {
  const doFetch = options.fetch ?? fetch;

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await doFetch(`${API}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await options.accessToken()}` },
    });
    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  return {
    signedInEmail: () => options.email,

    async listFrom(sender, max) {
      const q = encodeURIComponent(`from:${sender}`);
      const list = await api<{ messages?: { id: string }[] }>(`/messages?q=${q}&maxResults=${max}`);
      return Promise.all(
        (list.messages ?? []).map(async ({ id }) => {
          const msg = await api<{ id: string; snippet?: string; payload: GmailPart }>(`/messages/${id}?format=full`);
          const header = (name: string) =>
            msg.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
          return {
            id: msg.id,
            from: header("From"),
            to: header("To"),
            subject: header("Subject"),
            date: header("Date"),
            body: plainText(msg.payload) ?? msg.snippet ?? "",
          };
        }),
      );
    },

    async send(email) {
      const raw = Buffer.from(buildMime(email)).toString("base64url");
      return api<{ id: string }>("/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
      });
    },
  };
}

/** First text/plain part of a message, decoded. */
function plainText(part: GmailPart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text !== null) return text;
  }
  return null;
}

/** Extracts the bare address from a From header like `David <david@x.com>`. */
export function addressOf(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return (match ? match[1]! : header).trim().toLowerCase();
}

export function buildMime({ from, to, subject, body }: OutgoingEmail & { from: string }): string {
  for (const [name, value] of Object.entries({ from, to, subject })) {
    if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks`);
  }
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
}
