import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type CheckoutRow, type Store } from "./store.ts";

let dir: string;
let path: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paywall-store-"));
  path = join(dir, "paywall.sqlite");
  store = openStore(path);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(overrides: Partial<CheckoutRow> = {}): CheckoutRow {
  return {
    checkout_id: "cho_1",
    publisher: "gmail-demo",
    user_id: "someone@gmail.com",
    product: "gmail_send",
    status: "created",
    created_at: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

test("findLatest returns null when there are no rows", () => {
  expect(store.findLatest("gmail-demo", "someone@gmail.com", "gmail_send")).toBeNull();
});

test("findLatest returns the only row", () => {
  store.insert(row());
  expect(store.findLatest("gmail-demo", "someone@gmail.com", "gmail_send")).toEqual(row());
});

test("findLatest returns the newest of many rows and ignores other keys", () => {
  store.insert(row({ checkout_id: "cho_old", created_at: "2026-09-20T10:00:00.000Z" }));
  store.insert(row({ checkout_id: "cho_new", created_at: "2026-09-24T10:00:00.000Z" }));
  store.insert(row({ checkout_id: "cho_mid", created_at: "2026-09-22T10:00:00.000Z" }));
  store.insert(row({ checkout_id: "cho_other_user", user_id: "other@gmail.com", created_at: "2026-09-25T00:00:00.000Z" }));
  store.insert(row({ checkout_id: "cho_other_product", product: "other", created_at: "2026-09-25T00:00:00.000Z" }));
  store.insert(row({ checkout_id: "cho_other_pub", publisher: "other", created_at: "2026-09-25T00:00:00.000Z" }));

  expect(store.findLatest("gmail-demo", "someone@gmail.com", "gmail_send")?.checkout_id).toBe("cho_new");
});

test("findLatest breaks created_at ties by insertion order", () => {
  store.insert(row({ checkout_id: "cho_a" }));
  store.insert(row({ checkout_id: "cho_b" }));
  expect(store.findLatest("gmail-demo", "someone@gmail.com", "gmail_send")?.checkout_id).toBe("cho_b");
});

test("markStatus updates the row", () => {
  store.insert(row());
  store.markStatus("cho_1", "completed");
  expect(store.findLatest("gmail-demo", "someone@gmail.com", "gmail_send")?.status).toBe("completed");
});

test("data survives reopening the file", () => {
  store.insert(row({ status: "attempted" }));
  store.close();

  store = openStore(path);
  expect(store.findLatest("gmail-demo", "someone@gmail.com", "gmail_send")).toEqual(row({ status: "attempted" }));
});
