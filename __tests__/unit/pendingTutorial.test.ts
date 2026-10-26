import { describe, expect, it } from "vitest";
import { consumeTutorialRequest, requestTutorial } from "@/utils/pendingTutorial";

describe("pendingTutorial", () => {
  it("is false until requested", () => {
    expect(consumeTutorialRequest()).toBe(false);
  });

  it("is true exactly once per request", () => {
    requestTutorial();
    expect(consumeTutorialRequest()).toBe(true);
    expect(consumeTutorialRequest()).toBe(false);
  });
});
