import type { createJustifiClient } from "../../clients/justifi.ts";

export type CheckoutStatus = "created" | "attempted" | "completed" | "expired";

export interface JustifiConfig {
  clientId: string;
  clientSecret: string;
  hostedCheckoutUrl: string;
}

export interface CreateCheckoutInput {
  subAccountId: string;
  amount: number;
  description: string;
  metadata?: Record<string, string>;
}

export interface Checkout {
  id: string;
  status: CheckoutStatus;
  successfulPaymentId: string | null;
}

export type JustifiClient = ReturnType<typeof createJustifiClient>;
