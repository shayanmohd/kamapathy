export const FORM_CHANNELS = {
  hello: "kamapathy:form:hello",
  field: "kamapathy:form:field",
  captured: "kamapathy:form:captured",
  outcome: "kamapathy:form:outcome",
  state: "kamapathy:form:state",
  fill: "kamapathy:form:fill",
} as const;
export interface FormFlags {
  fill: boolean;
  capture: boolean;
}
export interface HelloReply extends FormFlags {
  checkOutcome: boolean;
}
// CSS pixels in the frame's viewport.
export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FieldReport {
  kind: "sign-in" | "username-only";
  rect: FieldRect;
  click?: { x: number; y: number };
  cause: "click" | "key";
}
export type CaptureReport =
  | { kind: "sign-in"; username: string; password: string }
  | { kind: "sign-up"; username: string; newPassword: string }
  | { kind: "change"; username: string; password: string; newPassword: string }
  | { kind: "username"; username: string };
export type OutcomeReport = { passwordField: boolean } | { formGone: true };
export interface FillMessage {
  origin: string;
  username: string;
  password: string;
}
export interface FormEnv {
  send(
    channel: "field" | "captured" | "outcome",
    payload: FieldReport | CaptureReport | OutcomeReport,
  ): void;
  invoke(channel: "hello"): Promise<HelloReply>;
  onMessage(
    listener: (channel: "state" | "fill", payload: unknown) => void,
  ): void;
}

// This complete function runs in each http or https frame, in the frame
// preload's isolated world. Like pageOperation it has no imports and uses
// nothing outside its body. It reports only while main's flags allow it,
// writes nothing to the page but the values main sends it to fill, and
// exposes nothing to the page.
export function watchForms(env: FormEnv): void {
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  type Kind = "sign-in" | "sign-up" | "change" | "username-only";
  let flags: FormFlags = { fill: false, capture: false };
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  const isInput = (node: unknown): node is HTMLInputElement =>
    node instanceof HTMLInputElement;
  // An input stays a password field once it was one, as when a page shows
  // the password by changing the field's type.
  const passwordFields = new WeakSet<HTMLInputElement>();
  const passwordField = (node: unknown) => {
    if (!isInput(node)) return false;
    if (node.type === "password") passwordFields.add(node);
    return passwordFields.has(node);
  };
  const textField = (node: unknown): node is HTMLInputElement =>
    isInput(node) &&
    !passwordField(node) &&
    /^(text|email|tel)$/.test(node.type);
  const buttonLike = (element: Element) =>
    element instanceof HTMLButtonElement ||
    (isInput(element) &&
      (element.type === "submit" || element.type === "image")) ||
    element.getAttribute("role") === "button";
  const tokens = (input: HTMLInputElement) =>
    (input.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
  const usernameLike = (input: HTMLInputElement) =>
    tokens(input).some((token) => token === "username" || token === "email") ||
    /user|login|email|account/i.test(`${input.name} ${input.id}`);
  const parentOf = (element: Element): Element | null =>
    element.parentElement || (element.getRootNode() as ShadowRoot).host || null;
  // The elements inside one in the order a person sees them, through open
  // shadow roots and slots. Frames run their own copy of this script.
  const elementsIn = (root: Element) => {
    const found: Element[] = [];
    const visit = (nodes: Iterable<Node>) => {
      for (const node of nodes)
        if (node instanceof Element) {
          found.push(node);
          descend(node);
        }
    };
    const descend = (element: Element) => {
      if (element.shadowRoot) visit(element.shadowRoot.childNodes);
      else if (element instanceof HTMLSlotElement) {
        const assigned = element.assignedNodes({ flatten: true });
        visit(assigned.length ? assigned : element.childNodes);
      } else visit(element.childNodes);
    };
    descend(root);
    return found;
  };
  // The snapshot's visibility rule, kept within this frame's document. The
  // hiding attributes are checked once per tree, where closest stops.
  const visible = (element: Element) => {
    if (!element.isConnected) return false;
    let ancestor: Element | null = element;
    let boundary = true;
    while (ancestor) {
      if (boundary && ancestor.closest('[hidden],[inert],[aria-hidden="true"]'))
        return false;
      if (
        ancestor instanceof HTMLDetailsElement &&
        !ancestor.open &&
        ancestor !== element
      ) {
        const summary = Array.from(ancestor.children).find(
          (child) => child.localName === "summary",
        );
        if (!summary?.contains(element)) return false;
      }
      const style = getComputedStyle(ancestor);
      if (
        style.opacity === "0" ||
        style.display === "none" ||
        style.contentVisibility === "hidden"
      )
        return false;
      boundary = !ancestor.parentElement;
      ancestor = parentOf(ancestor);
    }
    const style = getComputedStyle(element);
    return (
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      element.getClientRects().length > 0
    );
  };
  // A field's form is its group. Without one, the group is the nearest of six
  // ancestors holding what completes the field: a visible username input for
  // a password field, a visible password field for anything else, and failing
  // that a button for an input or a visible username input for a button.
  const groupOf = (element: Element): Element | undefined => {
    const form =
      isInput(element) || element instanceof HTMLButtonElement
        ? element.form
        : element.closest("form");
    if (form) return form;
    const around: Element[] = [];
    for (
      let node = parentOf(element);
      node && around.length < 6;
      node = parentOf(node)
    )
      around.push(node);
    const holding = (test: (inner: Element) => boolean) =>
      around.find((ancestor) => elementsIn(ancestor).some(test));
    const shownText = (inner: Element) => textField(inner) && visible(inner);
    return (
      (passwordField(element)
        ? holding(shownText)
        : holding((inner) => passwordField(inner) && visible(inner))) ||
      (buttonLike(element) ? holding(shownText) : holding(buttonLike))
    );
  };
  // The kind of a group from its visible password fields in order, and its
  // username input.
  const read = (group: Element) => {
    const inputs = elementsIn(group).filter(isInput);
    const shown = inputs.filter(visible);
    const passwords = shown.filter(passwordField);
    const fields = shown.filter(textField);
    const named = inputs.filter(
      (input) => !passwordField(input) && tokens(input).includes("username"),
    );
    let username: HTMLInputElement | undefined =
      named.find(visible) || named[0];
    if (!username && passwords.length)
      username = shown
        .slice(0, shown.indexOf(passwords[0]))
        .filter(textField)
        .pop();
    const [current, next, last] = passwords;
    const fresh = (input: HTMLInputElement) =>
      tokens(input).includes("new-password");
    let kind: Kind | undefined;
    if (passwords.length === 1) kind = fresh(current) ? "sign-up" : "sign-in";
    else if (passwords.length === 2)
      kind =
        current.value === next.value || (fresh(current) && fresh(next))
          ? "sign-up"
          : "change";
    else if (passwords.length === 3 && next.value === last.value)
      kind = "change";
    else if (
      !passwords.length &&
      fields.length === 1 &&
      usernameLike(fields[0])
    ) {
      kind = "username-only";
      username = fields[0];
    }
    return { kind, username, passwords };
  };
  // Nothing is reported while main has turned the flags off, as it does
  // whenever an agent has control.
  const report = (
    channel: "field" | "captured" | "outcome",
    payload: FieldReport | CaptureReport | OutcomeReport,
  ) => {
    if (channel === "field" ? flags.fill : flags.capture)
      env.send(channel, payload);
  };
  // A value counts when its last input event was trusted and came while
  // capture was on, so nothing an agent typed or a fill set is captured. A
  // username the page put in without an input event counts too.
  const typed = new WeakMap<HTMLInputElement, boolean>();
  const captured = new WeakMap<Element, number>();
  let poll: ReturnType<typeof setInterval> | undefined;
  // Main takes a captured form going away as a sign that the sign-in worked.
  const watchGone = (field: HTMLInputElement) => {
    clearInterval(poll);
    let polls = 0;
    let gone = 0;
    poll = setInterval(() => {
      polls += 1;
      gone = visible(field) ? 0 : gone + 1;
      if (gone === 2) report("outcome", { formGone: true });
      if (gone === 2 || polls === 60) clearInterval(poll);
    }, 500);
  };
  const capture = (group: Element | undefined) => {
    if (!group || !flags.capture) return;
    const now = performance.now();
    if (now - (captured.get(group) ?? -Infinity) < 1000) return;
    const { kind, username, passwords } = read(group);
    if (!kind || (username && typed.get(username) === false)) return;
    const name = username?.value || "";
    const [current, next] = passwords;
    let payload: CaptureReport;
    if (kind === "username-only") {
      if (!name) return;
      payload = { kind: "username", username: name };
    } else {
      const values = kind === "change" ? [current, next] : [current];
      if (values.some((input) => !input.value || typed.get(input) !== true))
        return;
      payload =
        kind === "sign-in"
          ? { kind, username: name, password: current.value }
          : kind === "sign-up"
            ? { kind, username: name, newPassword: current.value }
            : {
                kind,
                username: name,
                password: current.value,
                newPassword: next.value,
              };
    }
    captured.set(group, now);
    report("captured", payload);
    if (payload.kind !== "username") watchGone(current);
  };
  // The fill menu opens for the username or first password field of a
  // sign-in or username-only group.
  let lastField: HTMLInputElement | undefined;
  const reportField = (input: HTMLInputElement, click?: MouseEvent) => {
    const group = flags.fill ? groupOf(input) : undefined;
    if (!group) return;
    const { kind, username, passwords } = read(group);
    if (
      (kind !== "sign-in" && kind !== "username-only") ||
      (input !== username && input !== passwords[0])
    )
      return;
    const box = input.getBoundingClientRect();
    const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    lastField = input;
    report(
      "field",
      click
        ? {
            kind,
            rect,
            click: { x: click.clientX - box.left, y: click.clientY - box.top },
            cause: "click",
          }
        : { kind, rect, cause: "key" },
    );
  };
  // A fill reaches the group of the field last reported, at this origin only,
  // and skips fields a person could not type in.
  const fill = (message: Partial<FillMessage> | null) => {
    if (
      !flags.fill ||
      !lastField ||
      message?.origin !== location.origin ||
      typeof message.username !== "string" ||
      typeof message.password !== "string"
    )
      return;
    const group = groupOf(lastField);
    if (!group) return;
    const { kind, username, passwords } = read(group);
    const values: [HTMLInputElement | undefined, string][] =
      kind === "sign-in"
        ? [
            [username, message.username],
            [passwords[0], message.password],
          ]
        : kind === "username-only"
          ? [[username, message.username]]
          : [];
    for (const [input, value] of values) {
      if (!input || !visible(input) || input.disabled || input.readOnly)
        continue;
      setValue.call(input, value);
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const on = <K extends keyof WindowEventMap>(
    type: K,
    listener: (event: WindowEventMap[K]) => void,
  ) =>
    window.addEventListener(type, listener, { capture: true, passive: true });
  const targetOf = (event: Event) => event.composedPath()[0];
  // A page script's click on a submit button submits the form with a trusted
  // submit event, which must not count.
  let scripted = false;
  env.invoke("hello").then(
    (reply) => {
      flags = { fill: reply.fill === true, capture: reply.capture === true };
      env.onMessage((channel, payload) => {
        const message = payload as Partial<FormFlags & FillMessage> | null;
        if (channel === "fill") fill(message);
        else if (
          channel === "state" &&
          typeof message?.fill === "boolean" &&
          typeof message.capture === "boolean"
        )
          flags = { fill: message.fill, capture: message.capture };
      });
      on("focusin", (event) => {
        passwordField(targetOf(event));
      });
      on("input", (event) => {
        const target = targetOf(event);
        if (!isInput(target)) return;
        passwordField(target);
        typed.set(target, event.isTrusted && flags.capture);
      });
      on("click", (event) => {
        if (!event.isTrusted) {
          scripted = true;
          queueMicrotask(() => (scripted = false));
          return;
        }
        const path = event.composedPath();
        const target = path[0];
        if (isInput(target) && (passwordField(target) || textField(target))) {
          if (!target.value) reportField(target, event);
          return;
        }
        const button = path.find(
          (node): node is Element =>
            node instanceof Element && buttonLike(node),
        );
        if (button) capture(groupOf(button));
      });
      on("keydown", (event) => {
        const target = targetOf(event);
        if (!event.isTrusted || event.isComposing || !isInput(target)) return;
        if (event.key === "ArrowDown") reportField(target);
        else if (event.key === "Enter") capture(groupOf(target));
      });
      on("submit", (event) => {
        const target = targetOf(event);
        if (event.isTrusted && !scripted && target instanceof HTMLFormElement)
          capture(target);
      });
      on("pagehide", () => {
        lastField = undefined;
        clearInterval(poll);
      });
      // Main asks a new document whether it still shows a password field,
      // which tells a sign-in that worked from one that failed.
      if (reply.checkOutcome) {
        const check = () =>
          setTimeout(
            () =>
              report("outcome", {
                passwordField: elementsIn(document.documentElement).some(
                  (element) => passwordField(element) && visible(element),
                ),
              }),
            500,
          );
        if (document.readyState === "loading")
          document.addEventListener("DOMContentLoaded", check, { once: true });
        else check();
      }
    },
    () => undefined,
  );
}
