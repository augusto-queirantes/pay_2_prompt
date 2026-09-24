// Google OAuth desktop flow: `bun run gmail:auth`.
// Opens the consent page, receives the code on a loopback port, and saves the
// refresh token plus the signed-in address to $GMAIL_TOKEN_PATH.

import { createHash, randomBytes } from "node:crypto";
import { defaultTokenPath, postToken, SCOPES, writeToken } from "./google-auth.ts";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth client of type Desktop app).");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const { promise: code, resolve, reject } = Promise.withResolvers<string>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state) {
      reject(new Error("OAuth state mismatch"));
      return new Response("State mismatch. Close this tab and try again.", { status: 400 });
    }
    const error = url.searchParams.get("error");
    if (error) {
      reject(new Error(`Google returned: ${error}`));
      return new Response(`Sign-in failed: ${error}`, { status: 400 });
    }
    resolve(url.searchParams.get("code") ?? "");
    return new Response("Signed in. You can close this tab.");
  },
});

const redirectUri = `http://127.0.0.1:${server.port}/callback`;
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPES.join(" "),
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

console.log(`Opening Google sign-in. If no browser opens, visit:\n\n${authUrl}\n`);
Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", authUrl.toString()], {
  stdout: "ignore",
  stderr: "ignore",
});

try {
  const tokens = await postToken({
    grant_type: "authorization_code",
    code: await code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!tokens.refresh_token) throw new Error("Google returned no refresh_token");

  const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profile.ok) throw new Error(`Gmail profile failed: ${profile.status} ${await profile.text()}`);
  const { emailAddress } = (await profile.json()) as { emailAddress: string };

  const path = defaultTokenPath();
  writeToken(path, {
    email: emailAddress,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  });
  console.log(`Signed in as ${emailAddress}. Token saved to ${path}`);
} finally {
  server.stop(true);
}
