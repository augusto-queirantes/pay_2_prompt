// End-to-end check of paywall-client -> paywall service -> SQLite -> JustiFi (fake).
//
//   bun run e2e
//     Starts a fake JustiFi and the paywall service with a temp SQLite file,
//     runs the flow, then restarts the service to check paid state survives.
//
//   E2E_PAYWALL_URL=http://localhost:4242 E2E_JUSTIFI_URL=http://localhost:4999 bun run e2e
//     Runs the flow against services that are already up (the docker compose stack).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPaywall } from "../src/paywall-client/index.ts";
import { startFakeJustifi } from "./fake-justifi.ts";

const PUBLISHER_KEY = process.env.E2E_PUBLISHER_KEY || "pub_e2e";
const PRODUCT = "gmail_send";
const SERVICE_ENTRY = resolve(import.meta.dir, "../src/payments/index.ts");

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("   ", detail);
  }
}

interface Paywall {
  url: string;
  stop(): Promise<void>;
}

/** Spawns the real service entry point and waits for its "listening on" line. */
async function startService(env: Record<string, string>, cwd: string): Promise<Paywall> {
  const proc = Bun.spawn(["bun", SERVICE_ENTRY], {
    cwd, // a temp dir, so the child doesn't pick up the repo's .env
    env: { PATH: process.env.PATH ?? "", ...env, PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of proc.stdout) {
    out += decoder.decode(chunk);
    const match = out.match(/listening on (\S+)/);
    if (match) {
      return {
        url: match[1]!.replace(/\/$/, ""),
        stop: async () => {
          proc.kill();
          await proc.exited;
        },
      };
    }
  }
  throw new Error(`paywall service exited before listening (code ${await proc.exited}):\n${out}`);
}

async function stats(justifiUrl: string): Promise<{ creates: number; gets: number }> {
  return (await fetch(`${justifiUrl}/__test/stats`)).json() as Promise<{ creates: number; gets: number }>;
}

async function fakeAction(justifiUrl: string, action: "pay" | "expire", checkoutUrl: string) {
  const id = checkoutUrl.split("/").pop();
  const res = await fetch(`${justifiUrl}/__test/${action}/${id}`, { method: "POST" });
  if (!res.ok) throw new Error(`fake ${action} ${id} failed: ${res.status}`);
}

async function runFlow(paywallUrl: string, justifiUrl: string): Promise<string> {
  const user = `e2e-${Date.now()}@test.local`;
  const paywall = createPaywall({ baseUrl: paywallUrl, apiKey: PUBLISHER_KEY, getUserId: () => user });
  let ran = 0;
  const tool = paywall.require(PRODUCT, async () => {
    ran++;
    return { content: [{ type: "text" as const, text: "sent" }] };
  });

  const first = await paywall.verify(PRODUCT);
  check("new user is not paid and gets a checkout", first.paid === false, first);
  if (first.paid) return user;

  const page = await fetch(first.checkout_url);
  check("checkout URL opens the (fake) hosted page", page.ok, `${page.status} ${first.checkout_url}`);

  const blocked = await tool();
  check("paid tool is blocked before payment", ran === 0 && "isError" in blocked && blocked.isError === true);
  const content = (blocked as { content: { type: string; text?: string }[] }).content;
  check("blocked result has the link, QR text and QR image",
    content[0]?.text?.includes(first.checkout_url) === true && content[1]?.type === "image");

  const again = await paywall.verify(PRODUCT);
  check("second verify reuses the same checkout", !again.paid && again.checkout_url === first.checkout_url, again);

  await fakeAction(justifiUrl, "pay", first.checkout_url);
  await tool();
  check("paid tool runs after payment", ran === 1);

  const before = await stats(justifiUrl);
  await tool();
  const after = await stats(justifiUrl);
  check("once paid, verify is answered from SQLite (no JustiFi call)", ran === 2 && after.gets === before.gets, {
    before,
    after,
  });

  const other = createPaywall({ baseUrl: paywallUrl, apiKey: PUBLISHER_KEY, getUserId: () => `x-${user}` });
  const a = await other.verify(PRODUCT);
  if (!a.paid) await fakeAction(justifiUrl, "expire", a.checkout_url);
  const b = await other.verify(PRODUCT);
  check("an expired checkout is replaced by a new one",
    !a.paid && !b.paid && a.checkout_url !== b.checkout_url, { a, b });

  const wrongKey = createPaywall({ baseUrl: paywallUrl, apiKey: "wrong", getUserId: () => user });
  const denied = await wrongKey.verify(PRODUCT).then(() => null, (e: Error) => e.message);
  check("unknown publisher key is rejected (401)", denied?.includes("401") === true, denied);

  const missing = await paywall.verify("no_such_product").then(() => null, (e: Error) => e.message);
  check("unknown product is rejected (404)", missing?.includes("404") === true, missing);

  return user;
}

async function main() {
  const externalPaywall = process.env.E2E_PAYWALL_URL;
  const externalJustifi = process.env.E2E_JUSTIFI_URL;

  if (externalPaywall || externalJustifi) {
    if (!externalPaywall || !externalJustifi) throw new Error("Set both E2E_PAYWALL_URL and E2E_JUSTIFI_URL");
    console.log(`Running against ${externalPaywall} (JustiFi: ${externalJustifi})\n`);
    await runFlow(externalPaywall.replace(/\/$/, ""), externalJustifi.replace(/\/$/, ""));
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "paywall-e2e-"));
  const justifi = startFakeJustifi();
  const configPath = join(dir, "paywall.config.json");
  writeFileSync(configPath, JSON.stringify({
    publishers: [{
      id: "gmail-demo",
      api_key: PUBLISHER_KEY,
      sub_account_id: "acc_e2e",
      products: { [PRODUCT]: { amount: 500, description: "Gmail MCP: send email (lifetime)" } },
    }],
  }));
  const env = {
    JUSTIFI_CLIENT_ID: "test_e2e",
    JUSTIFI_CLIENT_SECRET: "e2e",
    JUSTIFI_API_URL: justifi.url,
    JUSTIFI_HOSTED_CHECKOUT_URL: `${justifi.url}/hosted-checkout`,
    PAYWALL_CONFIG_PATH: configPath,
    PAYWALL_DB_PATH: join(dir, "paywall.sqlite"),
  };

  let service = await startService(env, dir);
  try {
    console.log(`Paywall ${service.url}, fake JustiFi ${justifi.url}, DB ${env.PAYWALL_DB_PATH}\n`);
    const user = await runFlow(service.url, justifi.url);

    await service.stop();
    service = await startService(env, dir);
    const before = await stats(justifi.url);
    const paywall = createPaywall({ baseUrl: service.url, apiKey: PUBLISHER_KEY, getUserId: () => user });
    const result = await paywall.verify(PRODUCT);
    const after = await stats(justifi.url);
    check("paid state survives a service restart (read from the SQLite file)",
      result.paid === true && after.gets === before.gets, result);
  } finally {
    await service.stop();
    await justifi.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
