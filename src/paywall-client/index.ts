import { PUBLISHER_KEY_HEADER, type VerifyRequest, type VerifyResponse } from "contract";

export type { VerifyResponse } from "contract";

export interface PaywallOptions {
  /** Paywall service URL, for example `http://localhost:4242`. */
  baseUrl: string;
  /** Publisher key from `paywall.config.json`. */
  apiKey: string;
  /**
   * Returns the user from the server's own login. This is the security
   * boundary: never derive it from tool arguments or anything the agent sends.
   */
  getUserId: () => string | Promise<string>;
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

/** An MCP tool result returned instead of running a paid handler. */
export interface PaywallToolResult {
  [key: string]: unknown;
  isError: true;
  content: Array<TextContent | ImageContent>;
}

export interface Paywall {
  verify(product: string): Promise<VerifyResponse>;
  require<Args extends unknown[], R>(
    product: string,
    handler: (...args: Args) => R | Promise<R>,
  ): (...args: Args) => Promise<R | PaywallToolResult>;
}

export const UNAVAILABLE_MESSAGE = "This paid tool is unavailable right now. Try again later.";

const VERIFY_TIMEOUT_MS = 10_000;

export function createPaywall({ baseUrl, apiKey, getUserId }: PaywallOptions): Paywall {
  const verifyUrl = `${baseUrl.replace(/\/+$/, "")}/v1/verify`;

  async function verify(product: string): Promise<VerifyResponse> {
    const body: VerifyRequest = { user_id: await getUserId(), product };
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", [PUBLISHER_KEY_HEADER]: apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`paywall verify failed: ${res.status} ${await res.text()}`);
    }
    return parseVerifyResponse(await res.json());
  }

  function require<Args extends unknown[], R>(
    product: string,
    handler: (...args: Args) => R | Promise<R>,
  ) {
    return async (...args: Args): Promise<R | PaywallToolResult> => {
      let result: VerifyResponse;
      try {
        result = await verify(product);
      } catch {
        return { isError: true, content: [{ type: "text", text: UNAVAILABLE_MESSAGE }] };
      }
      // Fail closed: only an explicit `paid: true` runs the handler.
      if (result.paid === true) return handler(...args);
      return paymentRequired(result);
    };
  }

  return { verify, require };
}

function parseVerifyResponse(body: unknown): VerifyResponse {
  const b = body as Record<string, unknown> | null;
  if (b?.paid === true) return { paid: true };
  if (
    b?.paid === false &&
    typeof b.checkout_url === "string" &&
    typeof b.qr_text === "string" &&
    typeof b.qr_png_base64 === "string"
  ) {
    return {
      paid: false,
      checkout_url: b.checkout_url,
      qr_text: b.qr_text,
      qr_png_base64: b.qr_png_base64,
    };
  }
  throw new Error(`paywall verify returned an unexpected body: ${JSON.stringify(body)}`);
}

function paymentRequired(result: Extract<VerifyResponse, { paid: false }>): PaywallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        // Addressed to the user, not the agent, so the agent doesn't poll verify.
        text: [
          "This tool needs a one-time payment.",
          `Pay here: ${result.checkout_url}`,
          result.qr_text,
          "Once you have paid, ask me to try again.",
        ].join("\n\n"),
      },
      { type: "image", data: result.qr_png_base64, mimeType: "image/png" },
    ],
  };
}
