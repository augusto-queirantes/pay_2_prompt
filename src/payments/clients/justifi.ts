import Justifi from "@justifi/justifi-node";
import type {
  Checkout,
  CheckoutStatus,
  CreateCheckoutInput,
  JustifiConfig,
} from "../types/clients/justifi.types.ts";

export function createJustifiClient(config: JustifiConfig) {
  const sdk = Justifi.client().withCredentials({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  return {
    async createCheckout(
      input: CreateCheckoutInput,
    ): Promise<Pick<Checkout, "id" | "status">> {
      const { data } = await sdk.createCheckout(
        {
          amount: input.amount,
          description: input.description,
          metadata: input.metadata,
        },
        input.subAccountId,
      );
      return { id: data.id, status: data.status as CheckoutStatus };
    },

    async getCheckout(id: string): Promise<Checkout> {
      const { data } = await sdk.getCheckout(id);
      return {
        id: data.id,
        status: data.status as CheckoutStatus,
        successfulPaymentId: data.successfulPaymentId ?? null,
      };
    },

    hostedCheckoutUrl(id: string): string {
      return `${config.hostedCheckoutUrl}/${encodeURIComponent(id)}`;
    },
  };
}
