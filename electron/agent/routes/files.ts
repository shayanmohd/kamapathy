import type { IncomingMessage } from "node:http";
import { ApiError, fail } from "../errors";
import { chooserNotFound } from "../file-choosers";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { refNumber } from "../refs";
import type { Step } from "../session/types";
import { chooserFilesFields, setInputFilesFields } from "../validate";
import {
  beginTransfer,
  sameTransfer,
  withReceipt,
  type Transfer,
} from "./tabs";

// How long the retarget waits before looking again while nothing matches,
// the ladder an element action waits on.
const RETRY_AT_MS = [50, 100, 250];
// The id segment of /file-choosers/:id/files. Paths carry no query strings
// or encoded segments, so this is the raw id.
const idOf = (request: IncomingMessage) =>
  (request.url ?? "").split("/").filter(Boolean)[1] ?? "";

export function fileRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const {
    controller,
    authority: { authorizeTab },
    actions: { evaluatePage },
    choosers,
    refs,
  } = deps;
  return {
    "POST /tabs/:id/set-input-files": {
      // The bytes arrive in a larger body, so this reserves the one transfer
      // and looks up the page before reading any of them.
      beforeBody: ({ tab }) => beginTransfer(deps, tab!.id),
      handler: async ({ response, body, tab, run, prepared }) => {
        const transfer = prepared as Transfer;
        if (!sameTransfer(deps, tab!.id, transfer))
          return fail(
            "page_changed",
            "The page changed during the transfer. Take a fresh snapshot.",
          );
        const { files, timeoutMs, ...target } = setInputFilesFields(body!);
        const { session } = transfer;
        const step: Step = {
          deadline: run.deadline,
          signal: run.signal,
          dispatch: run.dispatch,
        };
        // The input the files go on is named by a ref of this call: a file
        // input's ref never moves to another element, so the apply files the
        // input the retarget chose or nothing.
        const firstRef = refs.reserve(1);
        const result = await withReceipt(deps, tab!.id, async () => {
          const until = Date.now() + timeoutMs;
          let chosen: Record<string, unknown> | undefined;
          for (let attempt = 0; chosen === undefined; attempt += 1) {
            try {
              chosen = await evaluatePage(
                tab!.id,
                session,
                "retargetFile",
                { ...target, firstRef },
                run.deadline,
                step,
              );
            } catch (error) {
              // The page may not have drawn the input yet. Every other answer
              // is this target's, now and after a wait.
              if (
                !(error instanceof ApiError) ||
                error.code !== "no_match" ||
                Date.now() >= until
              )
                throw error;
              const pause = Math.max(
                Math.min(RETRY_AT_MS[attempt] ?? 500, until - Date.now()),
                0,
              );
              await run.park(
                () => new Promise<void>((done) => setTimeout(done, pause)),
              );
              authorizeTab(tab!.id);
            }
          }
          const ref = typeof chosen.ref === "string" ? chosen.ref : "";
          // Only a number this call reserved joins the tab's refs.
          if (refNumber(ref) === firstRef) refs.record(tab!.id, [firstRef]);
          const applied = await evaluatePage(
            tab!.id,
            session,
            "applyFiles",
            { ref, files },
            run.deadline,
            step,
          );
          authorizeTab(tab!.id);
          return { ok: true as const, selected: applied.selected as number };
        });
        controller.addActivity(
          tab!.spaceId,
          files.length
            ? `Agent selected ${files.length} file(s) for a file input`
            : "Agent cleared a file input",
          "info",
        );
        return send(response, 200, result);
      },
    },
    "POST /file-choosers/:id/files": {
      // The chooser's own tab authorizes the route and lends it its space's
      // lane, so a page the agent released answers 409 tab_unmanaged.
      resolve: (parts) => {
        const chooser = choosers.get(parts[1]);
        if (!chooser) throw chooserNotFound();
        return { tabId: chooser.tabId };
      },
      beforeBody: ({ tab }) => beginTransfer(deps, tab!.id),
      handler: async ({ request, response, body, tab, run, prepared }) => {
        if (!sameTransfer(deps, tab!.id, prepared as Transfer))
          return fail(
            "page_changed",
            "The page changed during the transfer. Take a fresh snapshot.",
          );
        const { files } = chooserFilesFields(body!);
        const result = await choosers.setFiles(idOf(request), files, run);
        authorizeTab(tab!.id);
        controller.addActivity(
          tab!.spaceId,
          files.length
            ? `Agent gave a file chooser ${files.length} file(s)`
            : "Agent cancelled a file chooser",
          "info",
        );
        return send(response, 200, result);
      },
    },
  };
}
