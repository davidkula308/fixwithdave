import { parseUsdAmount } from "@/lib/payment-validation";

export function getFixedServicePrice(showPrice: boolean, value: unknown): string | null {
  if (!showPrice || (typeof value !== "number" && typeof value !== "string")) return null;
  return parseUsdAmount(String(value));
}