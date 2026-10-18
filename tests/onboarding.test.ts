import { describe, expect, it } from "vitest";
import type { DefaultBrowserStatus } from "../shared/types";
import {
  canSkip,
  defaultBrowserChoice,
  nextStep,
  ONBOARDING_STEPS,
  previousStep,
  stepNumber,
  type OnboardingStep,
} from "../src/lib/onboarding";
import { defaultBrowserCopy } from "../src/copy";

function walk(
  from: OnboardingStep,
  move: (step: OnboardingStep) => OnboardingStep | undefined,
): OnboardingStep[] {
  const seen: OnboardingStep[] = [];
  let step: OnboardingStep | undefined = from;
  while (step && seen.length < 20) {
    seen.push(step);
    step = move(step);
  }
  return seen;
}

describe("onboarding steps", () => {
  it("six steps in order", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "welcome",
      "privacy",
      "import",
      "agents",
      "sign-in",
      "finish",
    ]);
    expect(ONBOARDING_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(walk("welcome", nextStep)).toEqual([...ONBOARDING_STEPS]);
    expect(walk("finish", previousStep)).toEqual(
      [...ONBOARDING_STEPS].reverse(),
    );
    expect(previousStep("welcome")).toBeUndefined();
    expect(nextStep("finish")).toBeUndefined();
    expect(ONBOARDING_STEPS.filter(canSkip)).toEqual(["import", "agents"]);
  });
  it("default browser choice", () => {
    expect(defaultBrowserChoice({ state: "available" }, "darwin")).toEqual({
      show: true,
      note: defaultBrowserCopy.macConfirm,
    });
    expect(defaultBrowserChoice({ state: "available" }, "win32")).toEqual({
      show: true,
      note: defaultBrowserCopy.windowsSettings,
    });
    expect(defaultBrowserChoice({ state: "available" }, "linux")).toEqual({
      show: true,
    });
    const hidden: (DefaultBrowserStatus | null)[] = [
      null,
      { state: "default" },
      { state: "unavailable", reason: "development" },
      { state: "unavailable", reason: "disk-image" },
      { state: "unavailable", reason: "portable" },
      { state: "unavailable", reason: "not-installed" },
      { state: "unavailable", reason: "web" },
    ];
    for (const status of hidden)
      expect(
        defaultBrowserChoice(status, "darwin"),
        String(status?.state),
      ).toEqual({
        show: false,
      });
  });
});
