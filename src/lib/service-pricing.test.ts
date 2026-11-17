import { describe, expect, it } from "vitest";

import { getFixedServicePrice } from "./service-pricing";

describe("fixed service pricing", () => {
  it("formats the three demonstration prices for fixed checkout", () => {
    expect(getFixedServicePrice(true, 317.22)).toBe("317.22");
    expect(getFixedServicePrice(true, 151.58)).toBe("151.58");
    expect(getFixedServicePrice(true, 132.5)).toBe("132.50");
  });

  it("returns no fixed price when the tag is off or the amount is invalid", () => {
    expect(getFixedServicePrice(false, 317.22)).toBeNull();
    expect(getFixedServicePrice(true, 0)).toBeNull();
    expect(getFixedServicePrice(true, "not a price")).toBeNull();
  });
});