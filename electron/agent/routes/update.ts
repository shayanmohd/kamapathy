import type { UpdateReminder, UpdateStatus } from "../../../shared/types";
import { fail } from "../errors";
import { send, type RouteImpl } from "../http";

// Agents read the update status, ask for a check and start the download. The
// person alone opens, installs, cancels or quits, so no route does.

// What the routes need of electron/updates.ts, which they never import.
export interface UpdateService {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  download(): Promise<{ status: UpdateStatus; started: boolean }>;
  reminder(): UpdateReminder | null;
}

const SOURCE_MESSAGE =
  "This copy runs from source. Pull the latest code to update it.";
const NO_INSTALLER_MESSAGE = "No installer is published for this computer yet.";

// The updater's refusals and check failures reach here by shape, so this file
// stays free of Electron imports.
interface UpdateFailureShape {
  code: string;
  message: string;
  fields?: Record<string, unknown>;
}
function updateFailure(error: unknown): UpdateFailureShape | undefined {
  if (!(error instanceof Error) || error.name !== "UpdateFailure") return;
  const { code, message, fields } = error as Error &
    Partial<UpdateFailureShape>;
  return code === "update_unsupported" || code === "update_check_failed"
    ? { code, message, fields }
    : undefined;
}
// A check or download failure keeps its code, status and fields; the envelope
// adds retryable from the registry's rules.
function failed(error: unknown): never {
  const failure = updateFailure(error);
  if (!failure) throw error;
  return fail(failure.code, failure.message, failure.fields ?? {});
}

export function updateRoutes(deps: {
  updates?: UpdateService;
}): Record<string, RouteImpl> {
  // A copy built from source, and a platform with no published installer,
  // never contact GitHub.
  const service = (): UpdateService => {
    const found = deps.updates;
    const kind = found?.status().kind;
    if (found && kind !== "source" && kind !== "other") return found;
    return fail(
      "update_unsupported",
      kind === "source" ? SOURCE_MESSAGE : NO_INSTALLER_MESSAGE,
      {
        reason: kind === "source" ? "source" : "platform",
        platform: process.platform,
        arch: process.arch,
      },
    );
  };
  return {
    "GET /update": {
      handler: async ({ response }) => send(response, 200, service().status()),
    },
    "POST /update/check": {
      handler: async ({ response }) => {
        const updates = service();
        const status = await updates.check().catch(failed);
        send(response, 200, status);
      },
    },
    "POST /update/download": {
      handler: async ({ response }) => {
        const updates = service();
        const { status, started } = await updates.download().catch(failed);
        // 202 while the download runs, whether this request started it or
        // joined one; 200 when it is current, ready or stopped with an error.
        send(
          response,
          started || status.state === "downloading" ? 202 : 200,
          status,
        );
      },
    },
  };
}
