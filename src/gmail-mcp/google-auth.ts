import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** What `bun run gmail:auth` saves. `email` is the signed-in Gmail address, used as the paywall user id. */
export interface StoredToken {
  email: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: number; // epoch ms
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export function defaultTokenPath(): string {
  return process.env.GMAIL_TOKEN_PATH || join(homedir(), ".config", "pay2prompt", "gmail-token.json");
}

export function readToken(path: string): StoredToken {
  if (!existsSync(path)) throw new Error(`No Gmail token at ${path}. Run \`bun run gmail:auth\` first.`);
  const token = JSON.parse(readFileSync(path, "utf8")) as StoredToken;
  if (!token.email || !token.refresh_token) throw new Error(`${path} is missing email or refresh_token`);
  return token;
}

export function writeToken(path: string, token: StoredToken): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function postToken(params: Record<string, string>, doFetch: typeof fetch = fetch) {
  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
}

/** Returns a valid access token, refreshing (and saving) it when it's about to expire. */
export function createAccessTokenSource(path: string, client: GoogleClient, doFetch: typeof fetch = fetch) {
  let token = readToken(path);
  return {
    email: token.email,
    async get(): Promise<string> {
      if (token.access_token && token.expires_at && token.expires_at - 60_000 > Date.now()) {
        return token.access_token;
      }
      const fresh = await postToken(
        {
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        },
        doFetch,
      );
      token = { ...token, access_token: fresh.access_token, expires_at: Date.now() + fresh.expires_in * 1000 };
      writeToken(path, token);
      return fresh.access_token;
    },
  };
}
