import { ipcMain } from "electron";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContents,
} from "electron";
import { extensionIdOf, isComponentExtension } from "../../shared/extensions";
import { extensionBridgeCopy } from "../../src/copy";
import {
  EVENT_NAMES,
  EXTENSION_CALL,
  EXTENSION_EVENT,
  EXTENSION_LISTEN,
  EXTENSION_READY,
  PAGE_PRELOAD_ID,
  WORKER_PRELOAD_ID,
} from "./chrome-api";
import type { ExtensionHost, HostEvent } from "./host";

export type Surface = "tab" | "popup" | "window" | "worker";
type PageSurface = "tab" | "popup" | "window";
export interface Caller {
  extensionId: string;
  partition: string;
  surface: Surface;
  // Pages.
  contents?: WebContents;
  // Service workers.
  worker?: Electron.ServiceWorkerMain;
}
export type ApiHandler = (
  caller: Caller,
  method: string,
  args: unknown[],
) => unknown | Promise<unknown>;
// Its message is shown to the extension; anything else reads as a failure.
export class BridgeError extends Error {}
export const MAX_CALL_BYTES = 64 * 1024;
// Events kept for a stopped worker, newest wins.
const QUEUE_LIMIT = 100;
const NAME_LIMIT = 64;
const KNOWN_EVENTS: ReadonlySet<string> = new Set(EVENT_NAMES);

export interface ChannelDeps {
  host: ExtensionHost;
  // Absolute paths of the built preloads.
  preloads: { page: string; worker: string };
  surfaceOf(contents: WebContents): PageSurface | undefined;
  ipc?: Pick<
    Electron.IpcMain,
    "handle" | "removeHandler" | "on" | "removeListener"
  >;
}

interface PageRecord {
  partition: string;
  extensionId: string;
  surface: PageSurface;
  events: Set<string>;
}
interface WorkerRecord {
  partition: string;
  extensionId: string;
  session: Session;
  worker?: Electron.ServiceWorkerMain;
  // The preload reported in, so the worker can take events.
  ready: boolean;
  events: Set<string>;
  // Every name this extension's worker listened to in this run, so a stopped
  // worker can be woken for them.
  listened: Set<string>;
  queue: { event: string; args: unknown[] }[];
  started: boolean;
}
type StatusEvent =
  Electron.Event<Electron.ServiceWorkersRunningStatusChangedEventParams>;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function logError(context: string, error: unknown): void {
  console.error(`${context}:`, messageOf(error));
}

// The path between an extension's own contexts and the main process. It
// registers the two preloads on each session before its extensions load,
// answers only calls from extension main frames and workers of extensions
// loaded in that very session, and carries events back.
export class ExtensionChannel {
  private readonly deps: ChannelDeps;
  private readonly ipc: Pick<
    Electron.IpcMain,
    "handle" | "removeHandler" | "on" | "removeListener"
  >;
  private readonly handlers = new Map<string, ApiHandler>();
  private readonly pages = new Map<WebContents, PageRecord>();
  private readonly watched = new WeakSet<WebContents>();
  private readonly workers = new Map<string, WorkerRecord>();
  // Workers wired per session, by version id.
  private readonly wired = new WeakMap<Session, Map<number, WorkerRecord>>();
  private readonly sessions = new Map<string, Session>();
  private readonly offEvents: () => void;
  private readonly offSetup: () => void;

  constructor(deps: ChannelDeps) {
    this.deps = deps;
    this.ipc = deps.ipc ?? ipcMain;
    this.ipc.handle(EXTENSION_CALL, this.onCall);
    this.ipc.on(EXTENSION_LISTEN, this.onListen);
    this.offEvents = deps.host.onEvent(this.onHostEvent);
    this.offSetup = deps.host.onSessionSetup(this.onSetup);
  }

  register(
    api: "tabs" | "windows" | "action" | "runtime",
    handler: ApiHandler,
  ): void {
    this.handlers.set(api, handler);
  }

  // Sends an event to every context of that extension in that session that
  // listens to it, waking a stopped worker that listened to it before.
  emit(
    partition: string,
    extensionId: string,
    event: string,
    args: unknown[],
  ): void {
    for (const [contents, page] of [...this.pages])
      if (
        page.partition === partition &&
        page.extensionId === extensionId &&
        page.events.has(event)
      )
        try {
          if (!contents.isDestroyed())
            contents.send(EXTENSION_EVENT, event, args);
        } catch (error) {
          logError(`An extension page missed ${event}`, error);
        }
    const record = this.workers.get(key(partition, extensionId));
    if (!record) return;
    const worker = record.worker;
    if (worker && !worker.isDestroyed() && record.ready) {
      if (record.events.has(event)) this.send(record, event, args);
      return;
    }
    if (!record.listened.has(event)) return;
    record.queue.push({ event, args });
    while (record.queue.length > QUEUE_LIMIT) record.queue.shift();
    if (!worker) this.start(record);
  }

  listening(partition: string, extensionId: string, event: string): boolean {
    for (const page of this.pages.values())
      if (
        page.partition === partition &&
        page.extensionId === extensionId &&
        page.events.has(event)
      )
        return true;
    const record = this.workers.get(key(partition, extensionId));
    return !!record && (record.events.has(event) || record.listened.has(event));
  }

  callers(partition: string, extensionId: string): Caller[] {
    const callers: Caller[] = [];
    for (const [contents, page] of this.pages)
      if (
        page.partition === partition &&
        page.extensionId === extensionId &&
        !contents.isDestroyed()
      )
        callers.push({
          extensionId,
          partition,
          surface: page.surface,
          contents,
        });
    const record = this.workers.get(key(partition, extensionId));
    const worker = record?.worker;
    if (worker && !worker.isDestroyed())
      callers.push({ extensionId, partition, surface: "worker", worker });
    return callers;
  }

  dispose(): void {
    this.ipc.removeHandler(EXTENSION_CALL);
    this.ipc.removeListener(EXTENSION_LISTEN, this.onListen);
    this.offEvents();
    this.offSetup();
    this.pages.clear();
    this.workers.clear();
    this.handlers.clear();
    this.sessions.clear();
  }

  // Runs before a session's extensions load, so the preloads are in place
  // for every page and worker it starts.
  private onSetup = (partition: string, ses: Session): (() => void) => {
    this.sessions.set(partition, ses);
    this.registerPreload(
      ses,
      PAGE_PRELOAD_ID,
      "frame",
      this.deps.preloads.page,
    );
    this.registerPreload(
      ses,
      WORKER_PRELOAD_ID,
      "service-worker",
      this.deps.preloads.worker,
    );
    const status = (details: StatusEvent) => {
      if (
        details.runningStatus === "starting" ||
        details.runningStatus === "running"
      )
        this.wire(partition, ses, details.versionId);
      else if (details.runningStatus === "stopped")
        this.stopped(ses, details.versionId);
    };
    ses.serviceWorkers.on("running-status-changed", status);
    try {
      for (const versionId of Object.keys(ses.serviceWorkers.getAllRunning()))
        this.wire(partition, ses, Number(versionId));
    } catch (error) {
      logError("Running extension workers could not be read", error);
    }
    return () => {
      ses.serviceWorkers.removeListener("running-status-changed", status);
      for (const id of [PAGE_PRELOAD_ID, WORKER_PRELOAD_ID])
        try {
          ses.unregisterPreloadScript(id);
        } catch (error) {
          logError(`${id} could not be unregistered`, error);
        }
      this.sessions.delete(partition);
      this.wired.delete(ses);
      for (const [name, record] of [...this.workers])
        if (record.partition === partition) this.workers.delete(name);
    };
  };

  private registerPreload(
    ses: Session,
    id: string,
    type: "frame" | "service-worker",
    filePath: string,
  ): void {
    try {
      ses.registerPreloadScript({ id, type, filePath });
    } catch (error) {
      logError(`${id} could not be registered`, error);
    }
  }

  private onHostEvent = (event: HostEvent): void => {
    if (event.type === "loaded") {
      // Spec 4488: each worker starts once after loading, so it registers
      // its listeners.
      if (!this.deps.host.manifestOf(event.id)?.worker) return;
      const ses = this.sessions.get(event.partition);
      if (!ses) return;
      const record = this.record(event.partition, event.id, ses);
      if (record.started) return;
      record.started = true;
      this.start(record);
      return;
    }
    if (event.type === "unloaded")
      this.workers.delete(key(event.partition, event.id));
  };

  private onCall = async (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<unknown> => {
    const caller = this.pageCaller(event);
    if (!caller) throw new BridgeError(extensionBridgeCopy.notSupported);
    this.remember(event.sender, caller);
    return this.run(caller, payload);
  };

  private onListen = (event: IpcMainEvent, names: unknown): void => {
    const caller = this.pageCaller(event);
    if (!caller) return;
    this.remember(event.sender, caller).events = new Set(listenedNames(names));
  };

  // A page counts only as the main frame of an extension loaded in its own
  // session, shown as a tab, the action popup or an extension window.
  private pageCaller(
    event: IpcMainInvokeEvent | IpcMainEvent,
  ): Caller | undefined {
    try {
      const contents = event.sender;
      if (!contents || contents.isDestroyed()) return undefined;
      const frame = event.senderFrame;
      if (!frame || frame !== contents.mainFrame) return undefined;
      const extensionId = extensionIdOf(frame.url);
      if (!extensionId || isComponentExtension(extensionId)) return undefined;
      const partition = this.deps.host.partitionOf(contents.session);
      if (!partition || !this.deps.host.isLoaded(partition, extensionId))
        return undefined;
      const surface = this.deps.surfaceOf(contents);
      if (surface !== "tab" && surface !== "popup" && surface !== "window")
        return undefined;
      return { extensionId, partition, surface, contents };
    } catch (error) {
      logError("An extension call could not be placed", error);
      return undefined;
    }
  }

  private remember(contents: WebContents, caller: Caller): PageRecord {
    const existing = this.pages.get(contents);
    const record: PageRecord = existing ?? {
      partition: caller.partition,
      extensionId: caller.extensionId,
      surface: caller.surface as PageSurface,
      events: new Set(),
    };
    record.partition = caller.partition;
    record.extensionId = caller.extensionId;
    record.surface = caller.surface as PageSurface;
    this.pages.set(contents, record);
    if (this.watched.has(contents)) return record;
    this.watched.add(contents);
    const forget = () => {
      this.pages.delete(contents);
    };
    contents.once("destroyed", forget);
    // A new document registers again through its own preload.
    contents.on("did-navigate", forget);
    return record;
  }

  private async run(caller: Caller, payload: unknown): Promise<unknown> {
    const call = asCall(payload);
    const handler = this.handlers.get(call.api);
    if (!handler) throw new BridgeError(extensionBridgeCopy.notSupported);
    try {
      return await handler(caller, call.method, call.args);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      logError(`An extension call to ${call.api}.${call.method} failed`, error);
      throw new BridgeError(extensionBridgeCopy.failed);
    }
  }

  // A worker gets handlers only when its scope is exactly an extension
  // loaded in that session. Web sites' and component workers get none.
  private wire(partition: string, ses: Session, versionId: number): void {
    let known = this.wired.get(ses);
    if (!known) {
      known = new Map();
      this.wired.set(ses, known);
    }
    if (known.has(versionId)) return;
    let worker: Electron.ServiceWorkerMain | undefined;
    try {
      worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
    } catch (error) {
      logError("An extension worker could not be read", error);
      return;
    }
    if (!worker || worker.isDestroyed()) return;
    const extensionId = scopeId(worker.scope);
    if (!extensionId || !this.deps.host.isLoaded(partition, extensionId))
      return;
    const record = this.record(partition, extensionId, ses);
    known.set(versionId, record);
    record.worker = worker;
    record.ready = false;
    record.events = new Set();
    const caller: Caller = {
      extensionId,
      partition,
      surface: "worker",
      worker,
    };
    worker.ipc.handle(EXTENSION_CALL, (_event, payload: unknown) =>
      this.run(caller, payload),
    );
    worker.ipc.on(EXTENSION_LISTEN, (_event, names: unknown) => {
      record.events = new Set(listenedNames(names));
      for (const name of record.events) record.listened.add(name);
      if (record.ready) this.flush(record);
    });
    worker.ipc.on(EXTENSION_READY, () => {
      record.ready = true;
      this.flush(record);
    });
  }

  private stopped(ses: Session, versionId: number): void {
    const known = this.wired.get(ses);
    const record = known?.get(versionId);
    if (!known || !record) return;
    known.delete(versionId);
    record.worker = undefined;
    record.ready = false;
    record.events = new Set();
  }

  private record(
    partition: string,
    extensionId: string,
    session: Session,
  ): WorkerRecord {
    const name = key(partition, extensionId);
    const existing = this.workers.get(name);
    if (existing) {
      existing.session = session;
      return existing;
    }
    const record: WorkerRecord = {
      partition,
      extensionId,
      session,
      ready: false,
      events: new Set(),
      listened: new Set(),
      queue: [],
      started: false,
    };
    this.workers.set(name, record);
    return record;
  }

  private start(record: WorkerRecord): void {
    const scope = `chrome-extension://${record.extensionId}/`;
    try {
      void record.session.serviceWorkers
        .startWorkerForScope(scope)
        .catch((error: unknown) =>
          logError(`${record.extensionId}'s worker could not start`, error),
        );
    } catch (error) {
      logError(`${record.extensionId}'s worker could not start`, error);
    }
  }

  private flush(record: WorkerRecord): void {
    for (const item of record.queue.splice(0))
      if (record.events.has(item.event))
        this.send(record, item.event, item.args);
  }

  private send(record: WorkerRecord, event: string, args: unknown[]): void {
    const worker = record.worker;
    if (!worker) return;
    try {
      if (!worker.isDestroyed()) worker.send(EXTENSION_EVENT, event, args);
    } catch (error) {
      logError(`${record.extensionId}'s worker missed ${event}`, error);
    }
  }
}

const key = (partition: string, extensionId: string) =>
  `${partition}\u0000${extensionId}`;

// Only an extension's own root scope, and never a component extension's.
function scopeId(scope: string): string | undefined {
  const id = extensionIdOf(scope);
  if (!id || isComponentExtension(id)) return undefined;
  return scope === `chrome-extension://${id}/` ? id : undefined;
}

function listenedNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((name): name is string => KNOWN_EVENTS.has(name as string))
    .slice(0, NAME_LIMIT);
}

function asCall(payload: unknown): {
  api: string;
  method: string;
  args: unknown[];
} {
  const call = payload as
    { api?: unknown; method?: unknown; args?: unknown } | null | undefined;
  if (
    !call ||
    typeof call !== "object" ||
    typeof call.api !== "string" ||
    typeof call.method !== "string" ||
    !Array.isArray(call.args)
  )
    throw new BridgeError(extensionBridgeCopy.notSupported);
  let size: number;
  try {
    size = JSON.stringify(call)?.length ?? 0;
  } catch (error) {
    throw new BridgeError(extensionBridgeCopy.notSupported);
  }
  if (size > MAX_CALL_BYTES)
    throw new BridgeError(extensionBridgeCopy.tooLarge);
  return { api: call.api, method: call.method, args: call.args as unknown[] };
}
