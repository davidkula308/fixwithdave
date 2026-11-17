import { describe, expect, it } from "vitest";

import { clampServiceCount, cleanTabLabel, slugifyTabLabel } from "./service-categories";

describe("AI service count", () => {
  it("allows between 1 and 6 services at a time", () => {
    expect(clampServiceCount(1)).toBe(1);
    expect(clampServiceCount("6")).toBe(6);
    expect(clampServiceCount(0)).toBeNull();
    expect(clampServiceCount(7)).toBeNull();
    expect(clampServiceCount(2.5)).toBeNull();
  });
});

describe("new tab names", () => {
  it("turns a tab name into a short web-safe address", () => {
    expect(slugifyTabLabel("Phone & Tablet Repair")).toBe("phone-tablet-repair");
  });

  it("refuses names that clash with the built-in tabs or are empty", () => {
    expect(cleanTabLabel("Gaming")).toBeNull();
    expect(cleanTabLabel("Storage Fix")).toBeNull();
    expect(cleanTabLabel(" ")).toBeNull();
    expect(cleanTabLabel("Networking")).toBe("Networking");
  });
});
