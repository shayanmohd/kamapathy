import type { WebContents } from "electron";
import { ERRORS } from "../../skills/kamapathy/scripts/schema/index.mjs";
import { AGENT_TEXT_LIMITS, cleanAgentText } from "../../shared/agent-text";
import type { PageOperation } from "../automation-dom";
import type { Authority } from "./authority";
import type { PageStateOperation } from "./dom/page-state";
import { ApiError, fail } from "./errors";
import type { FrameGroupsByTab } from "./frames/groups";
import type { Park, Run } from "./http";
import {
  createInputActions,
  type DragAction,
  type FieldAction,
  type InputActions,
  type MouseAction,
  type PointerAction,
  type PointerKind,
  type PressAction,
} from "./input/actions";
import type { InputDispatcher, InputDispatchers } from "./input/dispatch";
import type { RefBook } from "./refs";
import { createResolver, type FrameTarget } from "./resolve";
import type { AutomationController } from "./server";
import { createSnapshots, type SnapshotRequest } from "./snapshot";
import {
  CdpTimeoutError,
  DialogOpenError,
  PageCrashedError,
} from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { Step } from "./session/types";
import type { ToolAction } from "./validate";

export type Point = { x: number; y: number };

/** The frame a page operation ran in, which the caller passes in empty. */
export type RanIn = { frameId?: string; path?: string };

// The step types the pointer runner owns.
const POINTER_KINDS: readonly PointerKind[] = ["click", "dblclick", "hover"];

// The frame note one request's action earned, read by the activity line
// after the action returns. Section 5's runner records it against the
// request it ran for, so nothing about a frame reaches the response.
const notes = new WeakMap<Run, string>();
/** Records the frame a request acted in, for its activity entry. */
export const noteFrame = (run: Run, note: string): void => {
  if (note) notes.set(run, note);
};
const hostOf = (value: string): string => {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
};
/**
 * The activity suffix for a target in a frame from another host:
 * " in a frame from <host>", with the host cleaned like any agent text and
 * cut at 60 characters. A frame of the page's own host adds nothing.
 */
export function frameNote(target: FrameTarget, topUrl: string): string {
  const host = cleanAgentText(hostOf(target.origin)).slice(
    0,
    AGENT_TEXT_LIMITS.label,
  );
  if (!host || host === hostOf(topUrl)) return "";
  return ` in a frame from ${host}`;
}

export const finitePoint = (point: unknown): point is Point =>
  !!point &&
  Number.isFinite((point as Point).x) &&
  Number.isFinite((point as Point).y);
// Refs the page moved to a control it drew again, as the page reported them.
export const reboundOf = (result: Record<string, unknown>) =>
  Array.isArray(result.rebound) ? { rebound: result.rebound } : {};

export async function bounded<T>(
  operation: Promise<T>,
  timeout = 15000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ApiError(
                "page_timeout",
                "The page did not respond in time.",
                { awaited: "page", timeoutMs: timeout },
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function remaining(deadline: number): number {
  const milliseconds = deadline - Date.now();
  if (milliseconds <= 0)
    return fail(
      "action_timeout",
      "The action time budget expired. Inspect the page before retrying a side effect.",
    );
  return Math.min(15000, milliseconds);
}

export interface Actions {
  /** The namespace a page operation of this tab's current page runs under. */
  namespace(id: string, session: TabSession): string;
  readyContents(
    id: string,
    timeout?: number,
    allowLoading?: boolean,
    park?: Park,
  ): Promise<{ contents: WebContents; session: TabSession }>;
  evaluatePage(
    id: string,
    session: TabSession,
    operation: PageOperation | PageStateOperation,
    payload: Record<string, unknown>,
    deadline: number,
    step?: Step,
    /** The frame whose world runs it, for a read inside a frame group. */
    frameId?: string,
    /** Filled in with the frame whose world ran it, for section 9. */
    ran?: RanIn,
  ): Promise<Record<string, unknown>>;
  executeToolAction(
    id: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  /** The tab's one input dispatcher; every route sends input through it. */
  dispatcher(id: string, session: TabSession): InputDispatcher;
  /** Section 5's element actions, which the input routes also run. */
  input: InputActions;
}

export function createActions(deps: {
  controller: AutomationController;
  authority: Authority;
  sessions: TabSessions;
  referenceSession: string;
  dispatchers: InputDispatchers;
  refs: RefBook;
  frames: FrameGroupsByTab;
}): Actions {
  const {
    controller,
    authority,
    sessions,
    referenceSession,
    dispatchers,
    refs,
  } = deps;
  const { authorizeTab } = authority;
  // Targets, refs, role nodes and section 9's search are the resolver's
  // business.
  const resolver = createResolver({ refs, frames: deps.frames });
  // Each page of a tab the agent controls has a debugger session from the
  // moment its view exists.
  const sessionOf = (id: string, contents: WebContents): TabSession => {
    const session = sessions.get(id);
    if (session?.contents === contents) return session;
    return fail(
      "debugger_busy",
      "Kamapathy lost its connection to this tab. Try again shortly.",
      { reason: "unavailable" },
    );
  };
  // A dialog left open holds the page, so its requests fail at once.
  const withoutDialog = (session: TabSession) => {
    const dialog = session.dialog();
    if (dialog) throw new DialogOpenError(dialog, false);
    return session;
  };
  const readyContents = async (
    id: string,
    timeout = 15000,
    allowLoading = false,
    park?: Park,
  ) => {
    authorizeTab(id);
    const contents = controller.getWebContents(id);
    if (!contents || contents.isDestroyed())
      return fail(
        "no_web_page",
        "Navigate this tab to an HTTP or HTTPS page first.",
      );
    const loading = withoutDialog(sessionOf(id, contents));
    if (!allowLoading && contents.isLoadingMainFrame()) {
      const load = () =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            contents.removeListener("did-stop-loading", loaded);
            contents.removeListener("destroyed", destroyed);
            stopDialog();
          };
          const loaded = () => {
            cleanup();
            resolve();
          };
          const destroyed = () => {
            cleanup();
            reject(new ApiError("tab_closed", "The tab was closed."));
          };
          // A dialog that opens while the page loads ends the wait.
          const stopDialog = loading.on("dialog", ({ params }) => {
            if (!params.dialog) return;
            cleanup();
            reject(new DialogOpenError(params.dialog, false));
          });
          const timer = setTimeout(() => {
            cleanup();
            reject(
              new ApiError(
                "page_timeout",
                "The page is still loading. Try again.",
                { awaited: "load", timeoutMs: timeout },
              ),
            );
          }, timeout);
          contents.once("did-stop-loading", loaded);
          contents.once("destroyed", destroyed);
        });
      await (park ? park(load) : load());
    }
    authorizeTab(id);
    if (contents.isDestroyed())
      return fail("tab_closed", "The tab was closed.");
    const session = withoutDialog(sessionOf(id, contents));
    if (session.state === "crashed") throw new PageCrashedError();
    return { contents, session };
  };

  // Page registries start empty once a tab's refs are retired.
  const namespaceOf = (id: string, session: TabSession) => {
    const generation = refs.generation(id);
    const retired = generation ? `:g${generation}` : "";
    return `${referenceSession}:${id}:${session.epoch}${retired}`;
  };
  const evaluatePage = async (
    id: string,
    session: TabSession,
    operation: PageOperation | PageStateOperation,
    payload: Record<string, unknown>,
    deadline: number,
    step?: Step,
    frameId?: string,
    ran?: RanIn,
  ) => {
    authorizeTab(id);
    const epoch = session.epoch;
    const namespace = namespaceOf(id, session);
    const result = await resolver.run(id, session, operation, payload, {
      deadline,
      namespace,
      signal: step?.signal,
      guard: () => authorizeTab(id),
      dispatch: step?.dispatch,
      ...(frameId === undefined ? {} : { frameId }),
      ...(ran === undefined ? {} : { ran }),
    });
    authorizeTab(id);
    if (
      ["snapshot", "target", "actionPoint", "focus", "drag"].includes(
        operation,
      ) &&
      session.epoch !== epoch
    )
      return fail(
        "page_changed",
        "The page navigated during this operation. Inspect the new page before continuing.",
      );
    // The page's code keeps its registered status and its fields; a code the
    // registry does not know is reported as element_action_failed, without
    // them. The page's blocker stays inside: section 5 waits on it.
    if (result?.ok === false) {
      const known =
        typeof result.code === "string" && Object.hasOwn(ERRORS, result.code);
      const fields = result.fields;
      return fail(
        known ? (result.code as string) : "element_action_failed",
        typeof result.error === "string"
          ? result.error
          : "Could not interact with the element.",
        known && fields && typeof fields === "object" && !Array.isArray(fields)
          ? (fields as Record<string, unknown>)
          : undefined,
      );
    }
    return result;
  };
  // Snapshots carry the scope rules, the locators and the header of their
  // own.
  const snapshots = createSnapshots({
    controller,
    evaluatePage,
    resolver,
    namespace: namespaceOf,
    frames: deps.frames,
  });
  const dispatcherFor = (_id: string, session: TabSession) =>
    dispatchers.for(session);
  // Section 5's element actions, which drive the attempt loop themselves.
  const input = createInputActions({
    controller,
    authority,
    actions: { readyContents, evaluatePage, dispatcher: dispatcherFor },
    dispatchers,
    frames: deps.frames,
  });
  const executeToolAction = async (
    id: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>> => {
    const tab = authorizeTab(id);
    const deadline = run.deadline;
    // The request's dispatch record, or its batch step's.
    const step: Step = {
      deadline,
      signal: run.signal,
      guard: () => authorizeTab(id),
      dispatch: run.dispatch,
    };
    const waitDeadline =
      action.type === "wait"
        ? Math.min(deadline, Date.now() + (action.payload.timeoutMs as number))
        : deadline;
    const ready = await readyContents(
      id,
      remaining(deadline),
      action.type === "wait",
      run.park,
    );
    let session = ready.session;
    const payload = action.payload;
    let result: Record<string, unknown>;
    if (action.type === "snapshot") {
      result = await snapshots.take(
        id,
        session,
        payload as unknown as SnapshotRequest,
        deadline,
        step,
      );
    } else if (POINTER_KINDS.includes(action.type as PointerKind)) {
      // Click, dblclick and hover wait for a target that can take the input,
      // scroll it into view and press it on the loop in input/actions.ts.
      result = await input.pointer(
        id,
        payload as unknown as PointerAction,
        run,
      );
    } else if (action.type === "fill" || action.type === "select") {
      // Fill and select wait for a field that can take the value, then
      // type or choose on the loop in input/actions.ts.
      result = await input.field(id, payload as unknown as FieldAction, run);
    } else if (action.type === "drag") {
      // Both ends wait for a layout that can take the drag, then today's
      // engine runs in input/actions.ts.
      result = await input.drag(id, payload as unknown as DragAction, run);
    } else if (action.type === "mouse-click") {
      // A raw click at a point: no target is resolved, so the runner moves,
      // presses and waits out what the page does next.
      result = await input.mouse(id, payload as unknown as MouseAction, run);
    } else if (action.type === "press") {
      // One chord on the key path: the optional target is focused first,
      // then the modifiers, the key and the releases go out.
      result = await input.press(id, payload as unknown as PressAction, run);
    } else if (action.type === "scroll") {
      result = await evaluatePage(id, session, "scroll", payload, deadline, step);
    } else {
      // The frames the last check was left without, which its timeout names.
      let unread = 0;
      for (;;) {
        authorizeTab(id);
        let observation: Record<string, unknown>;
        try {
          observation = await evaluatePage(
            id,
            session,
            "check",
            payload,
            // Zero makes one attempt with a short IPC response allowance.
            payload.timeoutMs === 0
              ? Math.min(deadline, Date.now() + 250)
              : Math.min(deadline, Math.max(Date.now() + 1, waitDeadline)),
            step,
          );
        } catch (error) {
          const timedOut =
            error instanceof CdpTimeoutError ||
            (error instanceof ApiError &&
              ["page_timeout", "action_timeout"].includes(error.code));
          if (!timedOut || Date.now() < waitDeadline) throw error;
          return fail(
            "wait_timeout",
            "The requested page condition was not observed before the timeout.",
            {
              awaited: "condition",
              timeoutMs: payload.timeoutMs,
              ...(unread > 0 ? { unreadFrames: unread } : {}),
            },
          );
        }
        if (typeof observation.unreadFrames === "number")
          unread = observation.unreadFrames;
        else unread = 0;
        if (observation.matched) {
          result = { ok: true };
          break;
        }
        if (Date.now() >= waitDeadline)
          return fail(
            "wait_timeout",
            "The requested page condition was not observed before the timeout.",
            {
              awaited: "condition",
              timeoutMs: payload.timeoutMs,
              ...(unread > 0 ? { unreadFrames: unread } : {}),
            },
          );
        await run.park(
          () =>
            new Promise((resolve) =>
              setTimeout(resolve, Math.min(100, waitDeadline - Date.now())),
            ),
        );
        session = (await readyContents(id, remaining(deadline), true, run.park))
          .session;
      }
    }
    authorizeTab(id);
    // The step types this runs; the navigation steps log their own lines.
    const descriptions: Record<string, string> = {
      snapshot: "Agent read a page snapshot",
      click: "Agent clicked an element",
      dblclick: "Agent double-clicked an element",
      hover: "Agent hovered an element",
      fill: "Agent filled a field",
      select: "Agent chose an option",
      press: "Agent pressed a key",
      scroll: "Agent scrolled a page",
      drag: "Agent dragged an element",
      "mouse-click": "Agent clicked a point",
      wait: "Agent observed a page condition",
    };
    // A target inside a frame from another host says so, which is how the
    // person sees an agent working in an embedded form.
    controller.addActivity(
      tab.spaceId,
      `${descriptions[action.type]}${notes.get(run) ?? ""}`,
      "info",
    );
    return result;
  };
  return {
    namespace: namespaceOf,
    readyContents,
    evaluatePage,
    executeToolAction,
    dispatcher: dispatcherFor,
    input,
  };
}
