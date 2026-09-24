import QRCode from "qrcode";
import type { CheckoutQrCode } from "../types/qr/qrcode.types.ts";

export async function createCheckoutQrCode(checkoutUrl: string): Promise<CheckoutQrCode> {
  const [qrText, dataUrl] = await Promise.all([
    QRCode.toString(checkoutUrl, { type: "utf8" }),
    QRCode.toDataURL(checkoutUrl),
  ]);
  return { checkoutUrl, qrText, qrPngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}
