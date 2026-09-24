import { PUBLISHER_KEY_HEADER, type VerifyErrorCode, type VerifyResponse } from "contract";
import type { Publisher } from "./config.ts";
import { createCheckoutQrCode } from "./qr/qrcode.ts";
import type { JustifiClient } from "./types/clients/justifi.types.ts";
import type { Store } from "./store.ts";

export interface VerifyDeps {
  publishers: Publisher[];
  store: Store;
  justifi: Pick<JustifiClient, "createCheckout" | "getCheckout" | "hostedCheckoutUrl">;
  now?: () => Date;
}

/** Wraps any failure of a JustiFi call. SDK errors are `{code, message}` objects, not `Error`s. */
class ProviderError extends Error {
  constructor(readonly cause: unknown) {
    super(describe(cause));
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (Array.isArray(err)) return err.map(describe).join("; "); // the SDK rejects with a list after retries
  if (typeof err === "object" && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    return `${code ?? "?"} ${message ?? JSON.stringify(err)}`;
  }
  return String(err);
}

function provider<T>(call: Promise<T>): Promise<T> {
  return call.catch((err: unknown) => {
    throw new ProviderError(err);
  });
}

/** Handler for `POST /v1/verify`. See checkout_spec.md for the algorithm. */
export function createVerifyHandler({ publishers, store, justifi, now = () => new Date() }: VerifyDeps) {
  const byKey = new Map(publishers.map((p) => [p.api_key, p]));

  async function unpaid(checkoutId: string): Promise<VerifyResponse> {
    const qr = await createCheckoutQrCode(justifi.hostedCheckoutUrl(checkoutId));
    return { paid: false, checkout_url: qr.checkoutUrl, qr_text: qr.qrText, qr_png_base64: qr.qrPngBase64 };
  }

  async function resolve(publisher: Publisher, userId: string, product: string): Promise<VerifyResponse> {
    const row = store.findLatest(publisher.id, userId, product);

    if (row?.status === "completed") return { paid: true };

    if (row && (row.status === "created" || row.status === "attempted")) {
      const checkout = await provider(justifi.getCheckout(row.checkout_id));
      if (checkout.status !== row.status) store.markStatus(row.checkout_id, checkout.status);
      if (checkout.status === "completed") return { paid: true };
      // Still open: hand back the same checkout so the user keeps one link.
      if (checkout.status !== "expired") return unpaid(row.checkout_id);
    }

    // No row, or the latest checkout expired: start a new one.
    const { amount, description } = publisher.products[product]!;
    const checkout = await provider(
      justifi.createCheckout({
        subAccountId: publisher.sub_account_id,
        amount,
        description,
        metadata: { user_id: userId, product, publisher: publisher.id },
      }),
    );
    store.insert({
      checkout_id: checkout.id,
      publisher: publisher.id,
      user_id: userId,
      product,
      status: checkout.status,
      created_at: now().toISOString(),
    });
    return unpaid(checkout.id);
  }

  return async function verify(req: Request): Promise<Response> {
    const publisher = byKey.get(req.headers.get(PUBLISHER_KEY_HEADER) ?? "");
    if (!publisher) return error(401, "unknown_publisher");

    const body = await req.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.user_id !== "string" ||
      typeof body.product !== "string" ||
      body.user_id === "" ||
      body.product === ""
    ) {
      return error(400, "invalid_request");
    }
    const { user_id, product } = body as { user_id: string; product: string };

    if (!Object.hasOwn(publisher.products, product)) return error(404, "unknown_product");

    try {
      return Response.json(await resolve(publisher, user_id, product));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      console.error(`verify ${publisher.id}/${product}: JustiFi failed:`, err.message);
      return error(502, "payment_provider_unavailable");
    }
  };
}

function error(status: number, code: VerifyErrorCode): Response {
  return Response.json({ error: code }, { status });
}
