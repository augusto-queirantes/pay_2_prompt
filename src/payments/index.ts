import { loadConfig } from "./config.ts";
import { createJustifiClient } from "./clients/justifi.ts";
import { openStore } from "./store.ts";
import { createVerifyHandler } from "./verify.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

const clientId = requireEnv("JUSTIFI_CLIENT_ID");
if (clientId.startsWith("live_")) throw new Error("Refusing to start with a live JustiFi key");

// The SDK reads JUSTIFI_API_URL itself and falls back to production when it's unset.
requireEnv("JUSTIFI_API_URL");

const config = loadConfig(process.env.PAYWALL_CONFIG_PATH || "paywall.config.json");
const store = openStore(process.env.PAYWALL_DB_PATH || "paywall.sqlite");
const justifi = createJustifiClient({
  clientId,
  clientSecret: requireEnv("JUSTIFI_CLIENT_SECRET"),
  hostedCheckoutUrl: requireEnv("JUSTIFI_HOSTED_CHECKOUT_URL"),
});

const server = Bun.serve({
  hostname: process.env.HOST || "localhost",
  port: Number(process.env.PORT || 4242),
  routes: {
    "/v1/verify": { POST: createVerifyHandler({ publishers: config.publishers, store, justifi }) },
    "/health": () => Response.json({ ok: true }),
  },
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
  error(err) {
    console.error(err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  },
});

console.log(`paywall service listening on ${server.url}`);
