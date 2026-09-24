// Gmail demo MCP server (stdio). stdout is the MCP channel, so log to stderr only.
//
//   claude mcp add gmail-demo \
//     -e PAYWALL_URL=http://localhost:4243 -e PAYWALL_PUBLISHER_KEY=pub_test_change_me \
//     -e GOOGLE_CLIENT_ID=... -e GOOGLE_CLIENT_SECRET=... \
//     -- bun run /absolute/path/to/src/gmail-mcp/index.ts

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaywall } from "paywall-client";
import { createGmail } from "./gmail.ts";
import { createAccessTokenSource, defaultTokenPath } from "./google-auth.ts";
import { createGmailServer } from "./server.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

const tokens = createAccessTokenSource(defaultTokenPath(), {
  clientId: requireEnv("GOOGLE_CLIENT_ID"),
  clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"),
});
const gmail = createGmail({ email: tokens.email, accessToken: tokens.get });

const paywall = createPaywall({
  baseUrl: requireEnv("PAYWALL_URL"),
  apiKey: requireEnv("PAYWALL_PUBLISHER_KEY"),
  // The security boundary: the user is whoever signed in to Gmail, never a tool argument.
  getUserId: () => gmail.signedInEmail(),
});

const server = createGmailServer({
  gmail,
  paywall,
  freeReadSender: process.env.FREE_READ_SENDER || "david.peterson@justifi.tech",
});

await server.connect(new StdioServerTransport());
console.error(`gmail-demo MCP running as ${gmail.signedInEmail()}`);
