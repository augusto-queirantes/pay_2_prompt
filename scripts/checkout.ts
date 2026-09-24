import { createJustifiClient } from "../src/payments/clients/justifi.ts";
import { createCheckoutQrCode } from "../src/payments/qr/qrcode.ts";

const justifi = createJustifiClient({
  clientId: process.env.JUSTIFI_CLIENT_ID!,
  clientSecret: process.env.JUSTIFI_CLIENT_SECRET!,
  hostedCheckoutUrl: process.env.JUSTIFI_HOSTED_CHECKOUT_URL!,
});

const checkoutId = process.argv[2];

if (checkoutId) {
  console.log(await justifi.getCheckout(checkoutId));
} else {
  const checkout = await justifi.createCheckout({
    subAccountId: process.env.JUSTIFI_SUB_ACCOUNT_ID!,
    amount: 500,
    description: "pay2prompt manual test",
    metadata: { source: "manual-test" },
  });
  const { checkoutUrl, qrText, qrPngBase64 } = await createCheckoutQrCode(
    justifi.hostedCheckoutUrl(checkout.id),
  );
  const pngPath = `checkout-${checkout.id}.png`;
  await Bun.write(pngPath, Buffer.from(qrPngBase64, "base64"));

  console.log(checkout);
  console.log(qrText);
  console.log(checkoutUrl);
  console.log(`QR image saved to ${pngPath}`);
}
