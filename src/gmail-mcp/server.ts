import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Paywall } from "paywall-client";
import { z } from "zod";
import { addressOf, type Gmail } from "./gmail.ts";

export const PRODUCT = "gmail_send";
const MAX_BODY_CHARS = 4000;

export interface GmailServerOptions {
  gmail: Gmail;
  paywall: Paywall;
  /** The only sender whose emails `read_email` returns. Reading them is free. */
  freeReadSender: string;
}

const noLineBreaks = (s: string) => !/[\r\n]/.test(s);

export function createGmailServer({ gmail, paywall, freeReadSender }: GmailServerOptions): McpServer {
  const sender = freeReadSender.toLowerCase();
  const server = new McpServer({ name: "gmail-demo", version: "0.1.0" });

  // Free: never calls the paywall, so it keeps working if the paywall is down.
  server.registerTool(
    "read_email",
    {
      title: "Read email",
      description: `Reads the most recent emails from ${freeReadSender}. Free. Only emails from this sender can be read.`,
      inputSchema: {
        max_results: z.number().int().min(1).max(20).default(5).describe("How many emails to return (1-20)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ max_results }) => {
      const found = await gmail.listFrom(sender, max_results);
      // Gmail's `from:` search also matches display names, so check the address itself.
      const emails = found.filter((e) => addressOf(e.from) === sender);
      if (emails.length === 0) {
        return { content: [{ type: "text", text: `No emails from ${freeReadSender}.` }] };
      }
      const text = emails
        .map((e) =>
          [
            `From: ${e.from}`,
            `Date: ${e.date}`,
            `Subject: ${e.subject}`,
            "",
            e.body.length > MAX_BODY_CHARS ? `${e.body.slice(0, MAX_BODY_CHARS)}\n[truncated]` : e.body,
          ].join("\n"),
        )
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // Paid: runs only after the paywall answers `paid: true` for the signed-in user.
  server.registerTool(
    "write_email",
    {
      title: "Write email",
      description: "Sends an email from the signed-in Gmail account. Needs a one-time payment.",
      inputSchema: {
        to: z.email().describe("Recipient address"),
        subject: z.string().min(1).refine(noLineBreaks, "subject must be a single line"),
        body: z.string().min(1).describe("Plain-text body"),
      },
    },
    paywall.require(PRODUCT, async ({ to, subject, body }: { to: string; subject: string; body: string }) => {
      const sent = await gmail.send({ from: gmail.signedInEmail(), to, subject, body });
      return { content: [{ type: "text" as const, text: `Email sent to ${to} (id ${sent.id}).` }] };
    }),
  );

  return server;
}
