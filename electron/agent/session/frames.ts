import type { CdpEvent } from "./types";

// Electron's PDF viewer, an extension frame like any other.
export const PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

const WEB_SCHEMES = /^(https?|about|data|blob):/i;
// Chromium reports an opaque origin, such as a data: frame's, as "://".
const opaque = (origin: string) =>
  origin === "" || origin === "null" || origin === "://";

// Whether Kamapathy may run its page functions in a frame: web documents and
// the error page Chromium shows in a main frame after a failed load. Extension
// frames, internal and local pages and Kamapathy's own pages are not.
export function isWebFrame(
  url: string,
  origin: string,
  main: boolean,
): boolean {
  if (main && url.startsWith("chrome-error://chromewebdata/")) return true;
  return (
    WEB_SCHEMES.test(url) && (opaque(origin) || /^https?:\/\//i.test(origin))
  );
}

export interface FrameRecord {
  frameId: string;
  parentFrameId?: string;
  url: string;
  origin: string;
  loaderId: string;
  sessionId?: string;
  ownSession: boolean;
  blocked: boolean;
  unavailable: boolean;
  /** Set while the frame has started loading another document. */
  navigating?: true;
}

type World = Promise<{ contextId: number }>;
// A frame inside a blocked frame is blocked too, so blocked is worked out
// when a record is read. navigating is the URL a frame started loading.
type Entry = Omit<FrameRecord, "blocked" | "navigating"> & {
  navigating?: string;
};

// The tab's frames across the page session and the sessions of
// out-of-process frames, each with Kamapathy's world for its document.
export class FrameRegistry {
  private frames = new Map<string, Entry>();
  private worlds = new Map<string, { epoch: number; world: World }>();
  private main?: string;

  get mainFrameId(): string | undefined {
    return this.main;
  }

  // A session's Page.getFrameTree. The root of an out-of-process frame's
  // tree is that frame, hosted by its own session.
  seed(tree: any, sessionId?: string): void {
    if (sessionId === undefined) {
      if (this.main !== undefined && this.main !== tree.frame.id) this.clear();
      this.main = tree.frame.id;
    }
    const visit = (node: any, root: boolean) => {
      this.commit(node.frame, sessionId, root && sessionId !== undefined);
      for (const child of node.childFrames ?? []) visit(child, false);
    };
    visit(tree, true);
  }

  apply(
    event: CdpEvent,
  ):
    | { frameId: string; change: "attached" | "navigated" | "detached" }
    | undefined {
    const { params, sessionId } = event;
    if (event.method === "Page.frameAttached") {
      const known = this.frames.get(params.frameId);
      // A frame that moved back into this session's process.
      if (known) {
        this.host(known, sessionId, false);
        known.parentFrameId = params.parentFrameId;
        return undefined;
      }
      this.frames.set(params.frameId, {
        frameId: params.frameId,
        parentFrameId: params.parentFrameId,
        url: "about:blank",
        origin: "",
        loaderId: "",
        sessionId,
        ownSession: false,
        unavailable: false,
      });
      return { frameId: params.frameId, change: "attached" };
    }
    if (event.method === "Page.frameStartedNavigating") {
      const known = this.frames.get(params.frameId);
      if (known) known.navigating = params.url;
      return undefined;
    }
    if (event.method === "Page.frameNavigated") {
      const frame = params.frame;
      // A new main frame means a new page in the tab, and a new document
      // has none of the old one's frames or its world.
      if (sessionId === undefined && !frame.parentId) {
        if (this.main !== frame.id) this.clear();
        this.main = frame.id;
      }
      this.dropChildren(frame.id);
      this.worlds.delete(frame.id);
      const known = this.frames.get(frame.id);
      this.commit(
        frame,
        sessionId,
        !!known?.ownSession && known.sessionId === sessionId,
      );
      return { frameId: frame.id, change: "navigated" };
    }
    if (event.method === "Page.navigatedWithinDocument") {
      const known = this.frames.get(params.frameId);
      if (known) known.url = params.url;
      return undefined;
    }
    if (event.method === "Page.frameDetached") {
      const known = this.frames.get(params.frameId);
      if (!known) return undefined;
      // A swap moves the frame to another process. The session there
      // reports it, and may already have.
      if (params.reason === "swap") {
        if (known.sessionId === sessionId) this.worlds.delete(params.frameId);
        return undefined;
      }
      this.remove(params.frameId);
      return { frameId: params.frameId, change: "detached" };
    }
    return undefined;
  }

  // An out-of-process frame's target. Chromium reports no URL for one it
  // attaches before the frame commits, so the URL the frame started loading
  // stands in. A blocked frame gets no session.
  attachTarget(targetId: string, sessionId: string, url: string): void {
    let frame = this.frames.get(targetId);
    if (!frame) {
      frame = {
        frameId: targetId,
        url: "",
        origin: "",
        loaderId: "",
        ownSession: false,
        unavailable: false,
      };
      this.frames.set(targetId, frame);
    }
    frame.url = url || frame.navigating || frame.url;
    if (this.blocked(frame)) this.host(frame, undefined, false);
    else this.host(frame, sessionId, true);
  }

  // Frames whose session ended are unavailable until a session reports
  // them again.
  detachSession(sessionId: string): string[] {
    const lost: string[] = [];
    for (const frame of this.frames.values())
      if (frame.sessionId === sessionId) {
        this.host(frame, undefined, false);
        frame.unavailable = !this.blocked(frame);
        lost.push(frame.frameId);
      }
    return lost;
  }

  clear(): void {
    this.frames.clear();
    this.worlds.clear();
    this.main = undefined;
  }

  get(frameId: string): FrameRecord | undefined {
    const frame = this.frames.get(frameId);
    return frame && this.record(frame);
  }

  // The main frame first, then parents before their children.
  list(): FrameRecord[] {
    const ordered: Entry[] = [];
    const visit = (frame: Entry) => {
      ordered.push(frame);
      for (const child of this.frames.values())
        if (child.parentFrameId === frame.frameId) visit(child);
    };
    const main =
      this.main === undefined ? undefined : this.frames.get(this.main);
    if (main) visit(main);
    for (const frame of this.frames.values())
      if (
        frame !== main &&
        (frame.parentFrameId === undefined ||
          !this.frames.has(frame.parentFrameId))
      )
        visit(frame);
    return ordered.map((frame) => this.record(frame));
  }

  // Whether a frame's origin differs from its parent's. Opaque origins
  // always differ.
  crossOrigin(frameId: string): boolean {
    const frame = this.frames.get(frameId);
    const parent =
      frame?.parentFrameId === undefined
        ? undefined
        : this.frames.get(frame.parentFrameId);
    if (!frame || !parent) return false;
    return (
      opaque(frame.origin) ||
      opaque(parent.origin) ||
      frame.origin !== parent.origin
    );
  }

  // The frame's world for its current document. A main-frame navigation
  // that has started ends every world, though its frame events come later.
  worldFor(frameId: string, epoch: number): World | undefined {
    const cached = this.worlds.get(frameId);
    return cached?.epoch === epoch ? cached.world : undefined;
  }

  setWorld(frameId: string, epoch: number, world: World): void {
    if (this.frames.has(frameId)) this.worlds.set(frameId, { epoch, world });
  }

  dropWorld(frameId: string): void {
    this.worlds.delete(frameId);
  }

  // Takes a frame's document from a frame tree or Page.frameNavigated.
  private commit(
    frame: any,
    sessionId: string | undefined,
    ownSession: boolean,
  ): void {
    const known = this.frames.get(frame.id);
    if (known?.loaderId !== frame.loaderId) this.worlds.delete(frame.id);
    const entry: Entry = known ?? {
      frameId: frame.id,
      url: "",
      origin: "",
      loaderId: "",
      ownSession: false,
      unavailable: false,
    };
    entry.parentFrameId = frame.parentId ?? entry.parentFrameId;
    entry.url = frame.url + (frame.urlFragment ?? "");
    entry.origin = frame.securityOrigin ?? "";
    entry.loaderId = frame.loaderId;
    entry.navigating = undefined;
    this.host(entry, sessionId, ownSession);
    this.frames.set(frame.id, entry);
  }

  // Moves a frame to the session that now reports it. Its world belonged to
  // the old one.
  private host(
    frame: Entry,
    sessionId: string | undefined,
    ownSession: boolean,
  ): void {
    if (frame.sessionId !== sessionId) this.worlds.delete(frame.frameId);
    frame.sessionId = sessionId;
    frame.ownSession = ownSession;
    frame.unavailable = false;
  }

  private remove(frameId: string): void {
    this.dropChildren(frameId);
    this.frames.delete(frameId);
    this.worlds.delete(frameId);
  }

  private dropChildren(frameId: string): void {
    for (const frame of [...this.frames.values()])
      if (frame.parentFrameId === frameId) this.remove(frame.frameId);
  }

  private blocked(frame: Entry): boolean {
    for (
      let current: Entry | undefined = frame;
      current;
      current =
        current.parentFrameId === undefined
          ? undefined
          : this.frames.get(current.parentFrameId)
    )
      if (
        !isWebFrame(current.url, current.origin, current.frameId === this.main)
      )
        return true;
    return false;
  }

  private record(frame: Entry): FrameRecord {
    const { navigating, ...record } = frame;
    return {
      ...record,
      blocked: this.blocked(frame),
      ...(navigating === undefined ? {} : { navigating: true as const }),
    };
  }
}
