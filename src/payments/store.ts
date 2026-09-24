import { Database } from "bun:sqlite";
import type { CheckoutStatus } from "./types/clients/justifi.types.ts";

export type { CheckoutStatus };

export interface CheckoutRow {
  checkout_id: string;
  publisher: string;
  user_id: string;
  product: string;
  status: CheckoutStatus;
  created_at: string; // ISO 8601, so it sorts as text
}

export interface Store {
  findLatest(publisher: string, userId: string, product: string): CheckoutRow | null;
  insert(row: CheckoutRow): void;
  markStatus(checkoutId: string, status: CheckoutStatus): void;
  close(): void;
}

export function openStore(path: string): Store {
  const db = new Database(path, { create: true, strict: true });

  db.run(`
    CREATE TABLE IF NOT EXISTS checkouts (
      checkout_id TEXT PRIMARY KEY,
      publisher   TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      product     TEXT NOT NULL,
      status      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS checkouts_lookup ON checkouts (publisher, user_id, product, created_at)",
  );

  // rowid breaks ties between rows inserted in the same millisecond.
  const findLatestQuery = db.query<CheckoutRow, [string, string, string]>(`
    SELECT checkout_id, publisher, user_id, product, status, created_at
    FROM checkouts
    WHERE publisher = ? AND user_id = ? AND product = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `);
  const insertQuery = db.query<never, [string, string, string, string, string, string]>(`
    INSERT INTO checkouts (checkout_id, publisher, user_id, product, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const markStatusQuery = db.query<never, [string, string]>(
    "UPDATE checkouts SET status = ? WHERE checkout_id = ?",
  );

  return {
    findLatest(publisher, userId, product) {
      return findLatestQuery.get(publisher, userId, product);
    },
    insert(row) {
      insertQuery.run(
        row.checkout_id,
        row.publisher,
        row.user_id,
        row.product,
        row.status,
        row.created_at,
      );
    },
    markStatus(checkoutId, status) {
      markStatusQuery.run(status, checkoutId);
    },
    close() {
      db.close();
    },
  };
}
