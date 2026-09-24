import { readFileSync } from "node:fs";

export interface Product {
  amount: number; // cents
  description: string;
}

export interface Publisher {
  id: string;
  api_key: string;
  sub_account_id: string;
  products: Record<string, Product>;
}

export interface PaywallConfig {
  publishers: Publisher[];
}

/**
 * Reads the publishers file. A string value of the form `$NAME` is replaced by
 * that env var, so `sub_account_id` can come from `.env`.
 */
export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): PaywallConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"), (_key, value) => {
    if (typeof value !== "string" || !value.startsWith("$")) return value;
    const resolved = env[value.slice(1)];
    if (!resolved) throw new Error(`${path}: env var ${value.slice(1)} is not set`);
    return resolved;
  });
  return parseConfig(raw, path);
}

export function parseConfig(raw: unknown, source = "config"): PaywallConfig {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

  if (!isObject(raw) || !Array.isArray(raw.publishers)) fail("expected { publishers: [...] }");
  const publishers = (raw as { publishers: unknown[] }).publishers.map((p, i): Publisher => {
    const at = `publishers[${i}]`;
    if (!isObject(p)) return fail(`${at} must be an object`);
    if (!isString(p.id)) fail(`${at}.id must be a non-empty string`);
    if (!isString(p.api_key)) fail(`${at}.api_key must be a non-empty string`);
    if (!isString(p.sub_account_id)) fail(`${at}.sub_account_id must be a non-empty string`);
    if (!isObject(p.products)) fail(`${at}.products must be an object`);

    const products: Record<string, Product> = {};
    for (const [name, product] of Object.entries(p.products as Record<string, unknown>)) {
      const pat = `${at}.products.${name}`;
      if (!isObject(product)) fail(`${pat} must be an object`);
      const { amount, description } = product as Record<string, unknown>;
      if (!Number.isInteger(amount) || (amount as number) <= 50) fail(`${pat}.amount must be an integer greater than 50`);
      if (!isString(description)) fail(`${pat}.description must be a non-empty string`);
      products[name] = { amount: amount as number, description: description as string };
    }
    return {
      id: p.id as string,
      api_key: p.api_key as string,
      sub_account_id: p.sub_account_id as string,
      products,
    };
  });

  const seen = new Set<string>();
  for (const p of publishers) {
    if (seen.has(p.id) || seen.has(`key:${p.api_key}`)) fail(`duplicate publisher id or api_key (${p.id})`);
    seen.add(p.id).add(`key:${p.api_key}`);
  }
  return { publishers };
}
