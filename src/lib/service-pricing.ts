import { parseUsdAmount } from "@/lib/payment-validation";

export function getFixedServicePrice(showPrice: boolean, value: unknown): string | null {
  if (!showPrice || (typeof value !== "number" && typeof value !== "string")) return null;
  return parseUsdAmount(String(value));
}

export function resolveCheckoutServicePrice(
  service: { show_price: boolean; price_usd: number | null },
): string | null {
  if (!service.show_price) return null;
  const savedAmount = getFixedServicePrice(service.show_price, service.price_usd);
  if (!savedAmount) return null;
  return savedAmount;
}