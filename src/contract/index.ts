// Wire types for `POST /v1/verify`, shared by the paywall service and paywall-client.

export interface VerifyRequest {
  user_id: string;
  product: string;
}

export type VerifyResponse =
  | { paid: true }
  | {
      paid: false;
      checkout_url: string;
      qr_text: string;
      qr_png_base64: string;
    };

export type VerifyErrorCode =
  | "unknown_publisher"
  | "unknown_product"
  | "invalid_request"
  | "payment_provider_unavailable";

export interface VerifyErrorResponse {
  error: VerifyErrorCode;
}

export const PUBLISHER_KEY_HEADER = "X-Publisher-Key";
