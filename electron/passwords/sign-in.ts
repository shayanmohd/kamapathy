import { agentRules } from "../../shared/state";
import type { BrowserState, Space } from "../../shared/types";
import { webOrigin } from "./origin";
import { memorySealer, type Sealer } from "./seal";
import type { Vault } from "./vault";

/** A server's challenge, as section 7 reads it from Chromium. */
export interface SignInChallenge {
  origin: string;
  realm: string;
  isProxy: boolean;
  mainFrame: boolean;
}

/** How long a typed sign-in waits for the navigation to commit. */
export const SAVE_AFTER_COMMIT_MS = 60000;
/** The most saved sign-ins the bar offers for one challenge. */
export const SIGN_IN_LOGINS = 8;
export const SIGN_IN_CONFIRM = "Agents can see sign-ins used in this space.";

export interface SignInPasswords {
  /** Up to 8 saved sign-ins for this challenge, last used first. */
  savedLogins(challenge: SignInChallenge): { id: string; username: string }[];
  /** Whether the bar may offer to save what the person types. */
  canSave(challenge: SignInChallenge): boolean;
  /** The saved values for one of those sign-ins, for main to answer with. */
  useSaved(
    tabId: string,
    loginId: string,
    challenge: SignInChallenge,
  ): Promise<{ username: string; password: string } | undefined>;
  /** Saves what the person typed once the navigation commits. */
  saveAfterCommit(
    contents: Pick<
      Electron.WebContents,
      "on" | "removeListener" | "isDestroyed"
    >,
    challenge: SignInChallenge,
    typed: { username: string; password: string },
  ): void;
}

export interface SignInDeps {
  vault: Vault;
  state(): BrowserState;
  confirm(message: string, button: string): Promise<boolean>;
  memory?: Sealer;
  now?: () => number;
}

// The saved HTTP sign-ins section 7's bar offers. Passwords stay in main:
// the bar learns ids and usernames, and answers with an id.
export function createSignInPasswords(deps: SignInDeps): SignInPasswords {
  const { vault } = deps;
  const memory = deps.memory ?? memorySealer();
  const now = deps.now ?? Date.now;
  const ready = () => vault.state === "ready";
  const spaceOf = (tabId: string): Space | undefined => {
    const { tabs, spaces } = deps.state();
    const spaceId = tabs.find((tab) => tab.id === tabId)?.spaceId;
    return spaces.find((space) => space.id === spaceId);
  };
  // Saves what the person typed: a login of their own is updated, an equal
  // one is only used, and anything else is added.
  const save = async (
    challenge: SignInChallenge,
    username: string,
    sealed: Buffer,
  ) => {
    const { text: password } = await memory.open(sealed);
    const existing = vault.find(
      "http",
      challenge.origin,
      username,
      challenge.realm,
    );
    if (!existing)
      await vault.add({
        kind: "http",
        origin: challenge.origin,
        realm: challenge.realm,
        username,
        password,
      });
    else if (await vault.passwordEquals(existing.id, password))
      vault.touch(existing.id);
    else await vault.update(existing.id, { password });
  };

  return {
    savedLogins(challenge) {
      if (challenge.isProxy || !ready()) return [];
      return vault
        .httpMatches(challenge.origin, challenge.realm)
        .slice(0, SIGN_IN_LOGINS)
        .map((login) => ({ id: login.id, username: login.username }));
    },
    canSave(challenge) {
      const { state } = vault;
      return (
        !challenge.isProxy &&
        challenge.mainFrame &&
        deps.state().settings.offerToSavePasswords &&
        (state === "empty" || state === "ready")
      );
    },
    async useSaved(tabId, loginId, challenge) {
      try {
        const login = vault.get(loginId);
        if (
          challenge.isProxy ||
          !login ||
          login.kind !== "http" ||
          login.origin !== webOrigin(challenge.origin) ||
          (login.realm ?? "") !== challenge.realm
        )
          return undefined;
        const space = spaceOf(tabId);
        if (!space) return undefined;
        if (
          agentRules(space) &&
          !(await deps.confirm(SIGN_IN_CONFIRM, "Sign in"))
        )
          return undefined;
        // The wait may have locked the vault or taken the login away.
        if (!ready() || !vault.get(loginId)) return undefined;
        const { password } = await vault.reveal(loginId);
        vault.touch(loginId);
        return { username: login.username, password };
      } catch {
        return undefined;
      }
    },
    saveAfterCommit(contents, challenge, typed) {
      if (challenge.isProxy || !challenge.mainFrame) return;
      const origin = webOrigin(challenge.origin);
      if (!origin) return;
      const { username } = typed;
      // Only the sealed copy waits, until a commit says the sign-in worked.
      const held = memory.seal(typed.password).catch(() => undefined);
      const until = now() + SAVE_AFTER_COMMIT_MS;
      let waiting = true;
      const stop = () => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timer);
        contents.removeListener("did-navigate", onCommit);
        contents.removeListener("destroyed", stop);
      };
      const onCommit = (
        _event: unknown,
        url: string,
        httpResponseCode: number,
      ) => {
        const here = webOrigin(url) === origin && httpResponseCode !== 401;
        const late = now() > until || contents.isDestroyed();
        stop();
        if (!here || late) return;
        void held
          .then((sealed) => sealed && save(challenge, username, sealed))
          .catch(() => {
            // Nothing is saved, and the person is not told.
          });
      };
      const timer = setTimeout(stop, SAVE_AFTER_COMMIT_MS);
      contents.on("did-navigate", onCommit);
      contents.on("destroyed", stop);
    },
  };
}
