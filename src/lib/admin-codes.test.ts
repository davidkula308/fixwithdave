import { describe, expect, it } from "vitest";

import { adminCodeMatches, hashAdminCode, validateNewAdminCode } from "./admin-codes";

describe("admin code rules", () => {
  it("rejects a code shorter than 4 digits", () => {
    expect(validateNewAdminCode("35", "35")).toBe("The new code must be 4 to 12 digits.");
  });

  it("rejects a code containing letters", () => {
    expect(validateNewAdminCode("40a0", "40a0")).toBe("The new code must be 4 to 12 digits.");
  });

  it("rejects a code whose confirmation differs", () => {
    expect(validateNewAdminCode("4031", "4032")).toBe("The two new codes do not match.");
  });

  it("accepts a 4-digit code typed the same twice", () => {
    expect(validateNewAdminCode("4030", "4030")).toBeNull();
  });

  it("a saved code signs in only with the same digits", async () => {
    const stored = await hashAdminCode("9060");
    expect(await adminCodeMatches("9060", stored)).toBe(true);
    expect(await adminCodeMatches("4030", stored)).toBe(false);
  });
});
