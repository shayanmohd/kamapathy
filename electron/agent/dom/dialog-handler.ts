export interface DialogHandlerConfig {
  /** The Runtime.addBinding name the handler reports through, random per tab. */
  binding: string;
  /** The non-configurable, non-enumerable updater key on globalThis. */
  key: string;
  /** agent: Kamapathy answers. person: the page's own functions are restored. */
  mode: "agent" | "person";
  policy: { accept: boolean; promptText?: string } | null;
  /** The event a context without the binding reports through instead. */
  event?: string;
}
export const MAX_REPORT_BYTES = 8192;
export const MAX_REPORTS_PER_DOCUMENT = 50;
/** Where the isolated world keeps the reports the binding could not carry. */
export const QUEUE_GLOBAL = "__kamapathyDialogQueue";

/** Self-contained: no imports, no closure over anything but its argument. */
export function dialogHandler(config: DialogHandlerConfig): void {
  type Scope = Record<string, unknown> & {
    alert(message?: unknown): void;
    confirm(message?: unknown): boolean;
    prompt(message?: unknown, value?: unknown): string | null;
  };
  const scope = globalThis as unknown as Scope;
  // A handler is already here: hand it the new policy instead of redefining
  // anything, which is how a change reaches contexts that already exist.
  const update = scope[config.key];
  if (typeof update === "function") {
    (update as (next: DialogHandlerConfig) => void)(config);
    return;
  }
  let current = config;
  const binding = scope[config.binding];
  const sink =
    typeof binding === "function"
      ? (binding as (text: string) => void)
      : undefined;
  try {
    delete scope[config.binding];
  } catch {
    // A page that froze the global keeps it; reports still go out.
  }
  const original = {
    alert: scope.alert,
    confirm: scope.confirm,
    prompt: scope.prompt,
  };
  const text = (value: unknown) => (value === undefined ? "" : String(value));
  const cut = (value: string, max: number) => value.slice(0, max);
  let sent = 0;
  const report = (data: Record<string, unknown>) => {
    if (sent >= 50) return;
    sent += 1;
    try {
      let payload = JSON.stringify(data);
      if (payload.length > 8192) {
        data.message = cut(text(data.message), 500);
        if (typeof data.defaultValue === "string")
          data.defaultValue = cut(data.defaultValue, 500);
        payload = JSON.stringify(data);
        if (payload.length > 8192) return;
      }
      if (sink) sink(payload);
      else if (current.event)
        dispatchEvent(new CustomEvent(current.event, { detail: payload }));
    } catch {
      // The page never learns that a report failed.
    }
  };
  const armed = () => {
    const { policy } = current;
    return policy && policy.accept === true ? policy : undefined;
  };
  const install = () => {
    try {
      if (current.mode === "person") {
        scope.alert = original.alert;
        scope.confirm = original.confirm;
        scope.prompt = original.prompt;
        return;
      }
      scope.alert = (message?: unknown) => {
        report({
          type: "alert",
          message: text(message),
          answer: "accepted",
          url: location.href,
        });
      };
      scope.confirm = (message?: unknown) => {
        const accept = armed() !== undefined;
        report({
          type: "confirm",
          message: text(message),
          answer: accept ? "accepted" : "dismissed",
          url: location.href,
        });
        return accept;
      };
      scope.prompt = (message?: unknown, value?: unknown) => {
        const accept = armed();
        const given =
          value === undefined || value === null ? undefined : text(value);
        const answer = accept
          ? accept.promptText === undefined
            ? (given ?? "")
            : accept.promptText
          : null;
        report({
          type: "prompt",
          message: text(message),
          ...(given === undefined ? {} : { defaultValue: given }),
          answer: accept ? "accepted" : "dismissed",
          ...(answer === null ? {} : { promptText: answer }),
          url: location.href,
        });
        return answer;
      };
    } catch {
      // A page may have frozen one of them; the others still answer.
    }
  };
  try {
    Object.defineProperty(scope, config.key, {
      value: (next: DialogHandlerConfig) => {
        current = next;
        install();
      },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Something else owns the key, so this handler keeps its own config.
  }
  install();
}

/** Queues what the main world reports in a context the binding missed. */
export function dialogQueue(config: { event: string }): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.__kamapathyDialogQueueOn === config.event) return;
  scope.__kamapathyDialogQueueOn = config.event;
  const queue = (scope.__kamapathyDialogQueue as string[] | undefined) ?? [];
  scope.__kamapathyDialogQueue = queue;
  addEventListener(
    config.event,
    (event) => {
      const { detail } = event as CustomEvent<unknown>;
      if (typeof detail === "string" && queue.length < 50) queue.push(detail);
    },
    true,
  );
}

export function dialogHandlerSource(config: DialogHandlerConfig): string {
  return `(${dialogHandler.toString()})(${JSON.stringify(config)})`;
}
export function dialogQueueSource(event: string): string {
  return `(${dialogQueue.toString()})(${JSON.stringify({ event })})`;
}
/** Reads and clears one isolated world's queue. */
export const DIALOG_DRAIN_SOURCE = `(() => { const q = globalThis[${JSON.stringify(QUEUE_GLOBAL)}]; return q ? q.splice(0, q.length) : []; })()`;
