import type { DefaultBrowserStatus } from "../../shared/types";
import { signInNoticeCopy } from "../copy";

export type SignInAction = "open-external" | "import-sign-ins" | "copy-link";

/**
 * While Kamapathy is the default browser the link would come back here, so the
 * notice offers the link itself instead. A status still being read counts as
 * not default.
 */
export function signInNotice(status: DefaultBrowserStatus | null): {
  message: string;
  actions: SignInAction[];
} {
  if (status?.state === "default")
    return {
      message: signInNoticeCopy.whenDefault,
      actions: ["import-sign-ins", "copy-link"],
    };
  return {
    message: signInNoticeCopy.elsewhere,
    actions: ["open-external", "import-sign-ins"],
  };
}
