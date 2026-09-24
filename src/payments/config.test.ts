import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "./config.ts";

const valid = {
  publishers: [
    {
      id: "gmail-demo",
      api_key: "pub_test",
      sub_account_id: "acc_1",
      products: { gmail_send: { amount: 500, description: "send" } },
    },
  ],
};

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("parses a valid config", () => {
  expect(parseConfig(valid)).toEqual(valid);
});

test("loadConfig substitutes $ENV values", () => {
  dir = mkdtempSync(join(tmpdir(), "paywall-config-"));
  const path = join(dir, "paywall.config.json");
  writeFileSync(path, JSON.stringify({ publishers: [{ ...valid.publishers[0], sub_account_id: "$SUB" }] }));

  expect(loadConfig(path, { SUB: "acc_env" }).publishers[0]!.sub_account_id).toBe("acc_env");
  expect(() => loadConfig(path, {})).toThrow("env var SUB is not set");
});

for (const [name, amount] of [
  ["non-integer", 500.5],
  ["too small", 50],
  ["string", "500"],
] as const) {
  test(`rejects ${name} amount`, () => {
    const bad = structuredClone(valid) as { publishers: { products: Record<string, { amount: unknown }> }[] };
    bad.publishers[0]!.products.gmail_send!.amount = amount;
    expect(() => parseConfig(bad)).toThrow("amount must be an integer greater than 50");
  });
}

test("rejects missing sub_account_id", () => {
  expect(() => parseConfig({ publishers: [{ ...valid.publishers[0], sub_account_id: "" }] })).toThrow("sub_account_id");
});

test("rejects duplicate api keys", () => {
  const second = { ...valid.publishers[0], id: "other" };
  expect(() => parseConfig({ publishers: [valid.publishers[0], second] })).toThrow("duplicate");
});
