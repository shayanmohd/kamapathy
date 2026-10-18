import { PasswordError } from "./errors";

export type ReauthPurpose = "show" | "export";
export const REAUTH_WINDOW_MS = 60000;
export const REAUTH_REASONS: Record<ReauthPurpose, string> = {
  show: "show your saved passwords",
  export: "export your saved passwords",
};

export interface ReauthDeps {
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
  confirm(): Promise<boolean>;
  now?: () => number;
}

export interface Reauth {
  check(purpose: ReauthPurpose): Promise<void>;
  forget(): void;
}

// Touch ID where the computer has it, otherwise the confirmation. A check
// that passed serves every password shown in the next REAUTH_WINDOW_MS.
export function createReauth(deps: ReauthDeps): Reauth {
  const now = deps.now ?? Date.now;
  let passed: number | undefined;
  let asking: Promise<void> | undefined;

  async function ask(purpose: ReauthPurpose): Promise<void> {
    let allowed = false;
    try {
      if (deps.canPromptTouchID()) {
        await deps.promptTouchID(REAUTH_REASONS[purpose]);
        allowed = true;
      } else allowed = await deps.confirm();
    } catch {
      // A cancelled prompt and a failed one read the same.
    }
    if (!allowed) throw new PasswordError("reauth_failed");
    passed = now();
  }

  return {
    async check(purpose) {
      if (passed !== undefined && now() - passed <= REAUTH_WINDOW_MS) return;
      // Two actions at once share one prompt.
      asking ??= ask(purpose).finally(() => {
        asking = undefined;
      });
      await asking;
    },
    forget() {
      passed = undefined;
    },
  };
}
