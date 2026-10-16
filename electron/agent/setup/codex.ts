import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import { errorCode, writeFailure, type SetupEnvironment } from "./paths";

const MARKER =
  "# Added by Kamapathy: lets Codex run the kamapathy command without asking";
export const CODEX_BLOCK = `${MARKER}\nprefix_rule(pattern=["kamapathy"], decision="allow")\n# End of Kamapathy lines\n`;

const pathsFor = (env: SetupEnvironment) =>
  env.platform === "win32" ? win32 : posix;

export const codexHome = (env: SetupEnvironment) =>
  env.env.CODEX_HOME || pathsFor(env).join(env.home, ".codex");

export const codexRulesFile = (env: SetupEnvironment) =>
  pathsFor(env).join(codexHome(env), "rules", "default.rules");

function readRules(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

// The block counts only from the start of a line.
const holdsBlock = (text: string) => `\n${text}`.includes(`\n${CODEX_BLOCK}`);

export function codexRuleState(
  env: SetupEnvironment,
): "present" | "absent" | "changed" {
  const text = readRules(codexRulesFile(env));
  if (text === null) return "absent";
  if (holdsBlock(text)) return "present";
  return text.includes(MARKER) ? "changed" : "absent";
}

// Adds or removes only Kamapathy's exact block. An edited block is the
// person's, so it stays either way.
export function setCodexRule(
  env: SetupEnvironment,
  allowed: boolean,
): "present" | "absent" | "profile_changed" {
  const file = codexRulesFile(env);
  try {
    const state = codexRuleState(env);
    if (state === "changed") return "profile_changed";
    if (allowed === (state === "present")) return state;
    const text = readRules(file) ?? "";
    if (allowed) {
      mkdirSync(pathsFor(env).dirname(file), { recursive: true });
      appendFileSync(
        file,
        text && !text.endsWith("\n") ? `\n${CODEX_BLOCK}` : CODEX_BLOCK,
      );
    } else
      writeFileSync(
        file,
        `\n${text}`.split(`\n${CODEX_BLOCK}`).join("\n").slice(1),
      );
  } catch (error) {
    throw writeFailure(error, file);
  }
  return allowed ? "present" : "absent";
}
