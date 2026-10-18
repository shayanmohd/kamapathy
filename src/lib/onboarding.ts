import type { BrowserState, DefaultBrowserStatus } from "../../shared/types";
import { defaultBrowserCopy } from "../copy";

export const ONBOARDING_STEPS = [
  "welcome",
  "privacy",
  "import",
  "agents",
  "sign-in",
  "finish",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function stepNumber(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step) + 1;
}

export function nextStep(step: OnboardingStep): OnboardingStep | undefined {
  return ONBOARDING_STEPS[stepNumber(step)];
}

export function previousStep(step: OnboardingStep): OnboardingStep | undefined {
  return ONBOARDING_STEPS[stepNumber(step) - 2];
}

/** Import and agent setup can be left for later. */
export function canSkip(step: OnboardingStep): boolean {
  return step === "import" || step === "agents";
}

/** The finish step offers the default browser only when it can be set here. */
export function defaultBrowserChoice(
  status: DefaultBrowserStatus | null,
  platform: BrowserState["platform"],
): { show: boolean; note?: string } {
  if (status?.state !== "available") return { show: false };
  if (platform === "darwin")
    return { show: true, note: defaultBrowserCopy.macConfirm };
  if (platform === "win32")
    return { show: true, note: defaultBrowserCopy.windowsSettings };
  return { show: true };
}
