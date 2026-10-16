import type { PasswordErrorBody, PasswordErrorCode } from "../../shared/types";

// Answers of the passwords shell calls. None of them reach the agent socket.
export type PasswordErrorFields = {
  field?: string;
  limit?: number;
  reason?: string;
  id?: string;
  retryable?: true;
};

const STATUS: Record<PasswordErrorCode, 400 | 403 | 404 | 409 | 500> = {
  invalid_login: 400,
  import_file_invalid: 400,
  vault_unavailable: 403,
  reauth_failed: 403,
  login_not_found: 404,
  vault_locked: 409,
  vault_full: 409,
  login_exists: 409,
  vault_write_failed: 500,
};
const FIELD_NAMES: Record<string, string> = { url: "web address" };

function defaultMessage(
  code: PasswordErrorCode,
  { field, limit, reason }: PasswordErrorFields,
): string {
  switch (code) {
    case "invalid_login": {
      const name = field === undefined ? "" : (FIELD_NAMES[field] ?? field);
      if (limit !== undefined)
        return `That ${name} is longer than ${limit} characters.`;
      if (field === "url")
        return "Use a web address that starts with http:// or https://.";
      if (field === "password") return "Enter a password.";
      return name
        ? `That ${name} isn't valid.`
        : "Check the details and try again.";
    }
    case "import_file_invalid":
      if (reason === "text") return "That file isn't UTF-8 text.";
      if (reason === "columns")
        return "That file has no url and password columns.";
      return "That file is larger than 10 MB or has more than 10000 rows.";
    case "vault_unavailable":
      return reason === "web"
        ? "Saved passwords are available in the desktop app."
        : "Kamapathy can't save passwords without a system keyring.";
    case "reauth_failed":
      return "Passwords stay hidden until you confirm it's you.";
    case "login_not_found":
      return "That password is no longer saved.";
    case "vault_locked":
      return "Saved passwords are locked. Choose Try again and allow Kamapathy's keychain access.";
    case "vault_full":
      return `Kamapathy keeps up to ${limit} of these.`;
    case "login_exists":
      return "That site and username are already saved.";
    case "vault_write_failed":
      return "Passwords couldn't be saved to disk. Try again.";
  }
}

export class PasswordError extends Error {
  constructor(
    readonly code: PasswordErrorCode,
    readonly fields: PasswordErrorFields = {},
    message?: string,
  ) {
    super(message ?? defaultMessage(code, fields));
  }
  get status(): 400 | 403 | 404 | 409 | 500 {
    return STATUS[this.code];
  }
  body(): PasswordErrorBody {
    return { code: this.code, message: this.message, ...this.fields };
  }
}

// Section 15's import_busy is the one other error a passwords call answers.
export function passwordErrorBody(
  error: unknown,
): PasswordErrorBody | undefined {
  if (error instanceof PasswordError) return error.body();
  if (
    error instanceof Error &&
    (error as { code?: unknown }).code === "import_busy"
  )
    return { code: "import_busy", message: error.message, retryable: true };
}
