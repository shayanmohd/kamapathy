// Text output for the CLI and Page.text(): one control or tab per line,
// with control characters removed from anything a page or agent wrote.
export const printable = (value) =>
  String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
export const line = (value) => printable(value).replace(/\s+/g, " ").trim();

const STATES = {
  checked: { true: "[checked]", false: "[unchecked]", mixed: "[mixed]" },
  selected: { true: "[selected]" },
  expanded: { true: "[expanded]", false: "[collapsed]" },
  pressed: {
    true: "[pressed]",
    false: "[not pressed]",
    mixed: "[partly pressed]",
  },
};
// State, value and group question after a control's label, for example
// [checked] value="Kamapathy" group "Does your app target children?".
function controlDetails(control) {
  const details = [];
  if (control.disabled) details.push("[disabled]");
  for (const [name, words] of Object.entries(STATES))
    if (Object.hasOwn(words, String(control[name])))
      details.push(words[String(control[name])]);
  if (control.valueHidden) details.push("(value hidden)");
  else if (control.value)
    details.push(
      `value=${JSON.stringify(printable(control.value))}${control.valueTruncated ? " (truncated)" : ""}`,
    );
  if (control.group)
    details.push(`group ${JSON.stringify(line(control.group))}`);
  return details.map((detail) => ` ${detail}`).join("");
}

// Which tab a header line names: its label, or its ID without one.
const tabName = (tab) => line(tab.label ?? tab.id);
// Who a tab belongs to: this page, a popup the page opened, or the person.
const whose = (tab) =>
  tab.current
    ? " (this page)"
    : tab.openedBy === "page"
      ? " (popup)"
      : tab.openedBy === "person"
        ? " (person)"
        : "";

/** The line naming the page, its space and the space's tabs. */
export function formatHeader(header) {
  const tabs = (header.tabs ?? []).map(
    (tab) =>
      `${tabName(tab)} ${JSON.stringify(line(tab.title))}${whose(tab)}${
        tab.managed === false ? " (unmanaged)" : ""
      }`,
  );
  return [
    `page ${tabName(header.page ?? {})} ${JSON.stringify(line(header.page?.title))}`,
    `space ${JSON.stringify(line(header.space?.name))} ${line(header.space?.id)}`,
    `tabs: ${tabs.join(", ")}`,
    ...(header.budget
      ? [
          `budget ${Number(header.budget.used)} of ${Number(header.budget.limit)}`,
        ]
      : []),
    ...(header.pdf ? ["pdf: read it with pdfText()"] : []),
  ].join(" | ");
}

export function formatSnapshot(snapshot) {
  const lines = [
    snapshot.header
      ? formatHeader(snapshot.header)
      : line(snapshot.title) || "Untitled page",
    line(snapshot.url),
  ];
  // An outline prints as sent, with its indentation and the locators the
  // server already appended; it takes the place of the text and controls.
  const outlined = typeof snapshot.outline === "string";
  if (outlined && snapshot.outline.trim())
    lines.push("", printable(snapshot.outline).replace(/\s+$/, ""));
  else if (!outlined && snapshot.text)
    lines.push("", printable(snapshot.text).trim());
  if (!outlined && snapshot.interactables?.length) {
    lines.push("", "Controls:");
    for (const control of snapshot.interactables) {
      lines.push(
        `${line(control.ref || control.selector)} ${line(control.role || control.tag)} ${JSON.stringify(line(control.label))}${controlDetails(control)}${control.locator ? ` locator: ${line(control.locator)}` : ""}`,
      );
      if (control.type === "file")
        lines.push(
          `  file upload: ${control.multiple ? "multiple" : "single"}${control.accept ? `; accepts ${line(control.accept)}` : ""}${control.hidden ? "; hidden input in visible form" : ""}`,
        );
      for (const option of control.options || [])
        lines.push(
          `  ${JSON.stringify(line(option.value))}: ${JSON.stringify(line(option.label))}${option.disabled ? " [disabled]" : ""}${option.selected ? " [selected]" : ""}`,
        );
      if (control.optionsTruncated)
        lines.push(
          "  More options omitted. Scope the select or inspect it in Kamapathy.",
        );
    }
  }
  if (snapshot.omittedControls > 0)
    lines.push(
      ...(snapshot.interactables?.length ? [] : [""]),
      `${Number(snapshot.omittedControls)} more controls not listed. Scope with --selector to list them.`,
    );
  if (snapshot.locatorsIncomplete)
    lines.push("Some locators were not checked in time.");
  // A continued snapshot says where the next part starts instead of that it
  // was cut short.
  if (snapshot.truncated && snapshot.next === undefined)
    lines.push(
      "",
      "Truncated. Scope with --selector or request --full if needed.",
    );
  if (snapshot.next) lines.push("", `Next part: cursor ${line(snapshot.next)}`);
  return lines.join("\n");
}

// Page or agent text on one line: whitespace collapsed and cut to 80
// characters, so one record stays one line.
const short = (value) => {
  const text = line(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

// One answered dialog: its kind, its message and how it was answered.
const dialogLine = (dialog) =>
  `${line(dialog.type)} ${JSON.stringify(short(dialog.message))} ${line(
    dialog.answer,
  )}`;

/**
 * What an action caused, printed under its own line: the pages it opened,
 * the dialogs Kamapathy answered, a download and the requests it refused.
 */
export function receiptLines(result) {
  const download = result?.download;
  const more = Number(result?.moreDialogs ?? 0);
  return [
    ...(result?.popups ?? []).map(
      (tab) => `opened ${tabName(tab)} ${line(tab.id)} ${line(tab.url)}`,
    ),
    ...(result?.dialog ? [dialogLine(result.dialog)] : []),
    ...(more > 0
      ? [`and ${more} more ${more === 1 ? "dialog" : "dialogs"}`]
      : []),
    ...(download
      ? [
          `download ${download.blocked ? "blocked" : line(download.id)} ${line(
            download.suggestedFilename,
          )}`,
        ]
      : []),
    ...(result?.deniedRequests ?? []).map(
      (request) =>
        `refused ${line(request.permission)} for ${line(request.origin)}`,
    ),
  ];
}

/** The line an armed wait prints. */
export const expectationLine = (expectation) =>
  `expectation ${line(expectation.id)} ${line(expectation.event)} ${line(
    expectation.tabId,
  )}`;

/** The line a wait prints once its event arrives. */
export function eventLine(result) {
  const popup = result?.popup;
  const download = result?.download;
  const chooser = result?.fileChooser;
  if (popup)
    return `popup ${tabName(popup)} ${line(popup.id)} ${line(popup.url)}`;
  if (download)
    return `download ${line(download.id)} ${line(download.suggestedFilename)}`;
  if (chooser)
    return `file-chooser ${line(chooser.id)} ${
      chooser.multiple ? "multiple" : "single"
    }`;
  if (result?.dialog) return `dialog ${dialogLine(result.dialog)}`;
  return JSON.stringify(result);
}

/** One held download: its id, state, bytes so far and the site's name. */
export const downloadLine = (download) =>
  `${line(download.id)} ${line(download.state)} ${Number(
    download.receivedBytes,
  )}/${Number(download.totalBytes)} ${line(download.suggestedFilename)}`;

/** A tab's dialog policy, then one line per dialog it answered. */
export function dialogLines(body) {
  const policy = body?.policy;
  return [
    policy
      ? `policy ${policy.accept ? "accept" : "dismiss"} ${Number(
          policy.remaining,
        )} left`
      : "policy none",
    ...(body?.dialogs ?? []).map(dialogLine),
  ];
}

// The raw commands that report where the pointer stands; the other input
// commands report the keys the page holds.
const POINTER_STEPS = [
  "mouse-move",
  "mouse-down",
  "mouse-up",
  "mouse-click",
  "mouse-wheel",
];

// What an action did beyond succeeding, such as where it clicked or which
// panel scrolled. `kind` is the command or batch step it answers.
export function actionSummary(data, kind) {
  const notes = [];
  if (data.point)
    notes.push(
      `${kind === "hover" ? "moved to" : "clicked at"} ${Number(data.point.x)},${Number(data.point.y)}`,
    );
  if (data.input)
    notes.push(
      POINTER_STEPS.includes(kind)
        ? `mouse at ${Number(data.input.x)},${Number(data.input.y)} buttons ${Number(data.input.buttons)}`
        : data.input.keys?.length
          ? `keys ${data.input.keys.map(line).join(", ")}`
          : "no keys held",
    );
  if (data.match) notes.push(`filled (${line(data.match)})`);
  if (Array.isArray(data.values))
    notes.push(
      data.values.length
        ? `selected ${data.values.map(line).join(", ")}`
        : "selection cleared",
    );
  if (Array.isArray(data.released))
    notes.push(
      data.released.length
        ? `released ${data.released.map(line).join(", ")}`
        : "nothing held",
    );
  if (data.drag)
    notes.push(
      data.drag === "html5"
        ? "dragged with HTML drag and drop"
        : "dragged with the mouse",
    );
  if (data.fallback === "dom_click")
    notes.push("clicked in the page because the control has no size");
  if (data.scrolled) {
    const where =
      data.scrolled === "element" ? `panel ${line(data.selector)}` : "page";
    notes.push(
      data.moved === false
        ? `${where} did not move`
        : `scrolled ${where} to ${Number(data.x)},${Number(data.y)}`,
    );
  }
  if (Array.isArray(data.rebound) && data.rebound.length)
    notes.push(
      data.rebound.length === 1
        ? `${line(data.rebound[0])} now points to the redrawn control`
        : `${data.rebound.map(line).join(", ")} now point to the redrawn controls`,
    );
  const text = notes.length ? `ok: ${notes.join("; ")}` : "ok";
  return data.loading ? `${text} (page loading)` : text;
}

// Older Kamapathy versions return spaces without signIns; nothing is added then.
const signIns = (space) =>
  space.signIns === "separate"
    ? " isolated"
    : space.signIns === "shared"
      ? " shared"
      : "";

// How a listed space stands and the status the person reads, after its owner.
const task = (space) =>
  `${space.state ? ` ${line(space.state)}` : ""}${
    space.status === undefined
      ? ""
      : ` status ${JSON.stringify(line(space.status))}`
  }`;

// One tab per line: its label, ID, origin and flags, or, from a Kamapathy
// without labels, its ID, title and URL. An opener in tabs is named by its
// label.
function tabLine(tab, tabs = []) {
  if (tab.label === undefined)
    return `${tab.id} ${line(tab.title)} ${line(tab.url)}`;
  const opener =
    tab.openerId &&
    (tabs.find((item) => item.id === tab.openerId)?.label ?? tab.openerId);
  return [
    line(tab.label),
    tab.id,
    line(tab.openedBy),
    ...(opener ? [`from ${line(opener)}`] : []),
    ...(tab.managed === false ? ["unmanaged"] : []),
    ...(tab.active ? ["active"] : []),
    ...(tab.unseen ? ["new"] : []),
    line(tab.url),
    JSON.stringify(line(tab.title)),
  ].join(" ");
}

const activeLine = (tab) =>
  `active ${line(tab.label)} ${tab.id} ${line(tab.url)}`;

// What changed while the person had control.
const boundaryLines = (data) => [
  ...(data.active ? [activeLine(data.active)] : []),
  ...(data.opened ?? []).map((tab) => `opened ${tabLine(tab, data.opened)}`),
  ...(data.closed ?? []).map((label) => `closed ${line(label)}`),
];

// A dialog a navigation or a wait answered, or the one holding the page.
const navigationDialogLine = (dialog) =>
  [
    "dialog",
    line(dialog.type),
    ...(dialog.answer ? [line(dialog.answer)] : []),
    ...(dialog.message ? [JSON.stringify(line(dialog.message))] : []),
  ].join(" ");

// What info read in the page, under its tab line.
const infoLines = (data) =>
  data.viewport
    ? [
        `viewport ${Number(data.viewport.width)}x${Number(data.viewport.height)} scroll ${Number(data.scroll?.x)},${Number(data.scroll?.y)} document ${Number(data.document?.width)}x${Number(data.document?.height)} ${line(data.readyState)}`,
      ]
    : [];

// How much of a page function's value a line carries.
const VALUE_CHARS = 200;
// One line per wait command, since each answer reads differently.
const WAITS = {
  "wait-for-url": (data) => `ok: url ${line(data.url)}`,
  "wait-for-load-state": (data) =>
    `ok: ${line(data.state)} ${line(data.tab?.url)}`,
  "wait-for-selector": (data) =>
    `ok: ${line(data.state)} ${Number(data.matched)} ${data.matched === 1 ? "match" : "matches"}`,
  "wait-for-function": (data) =>
    data.unserializable !== undefined
      ? `ok: value ${line(data.unserializable)}`
      : data.value === undefined
        ? "ok: value undefined"
        : `ok: value ${printable(JSON.stringify(data.value)).slice(0, VALUE_CHARS)}`,
};

// A PDF's pages, each under its own [page N] line.
const pdfPages = (data) =>
  (data.pages ?? []).flatMap((page) => {
    const text = printable(page.text).trim();
    return [`[page ${Number(page.number)}]`, ...(text ? [text] : [])];
  });

// command names the CLI command, where the same answer reads differently.
export function formatResult(data, command) {
  if (data && "interactables" in data && "url" in data)
    return formatSnapshot(data);
  if (command === "status")
    return data.status === undefined
      ? "ok: status cleared"
      : `ok: status ${JSON.stringify(line(data.status))}`;
  if (command === "fail") return "ok: failure reported, the person has control";
  if (Object.hasOwn(WAITS, command ?? "")) return WAITS[command](data);
  if (command === "space finish")
    return [
      `ok: space ${line(data.spaceId)} finished${data.closedSpace ? " and closed" : ""}`,
      ...["closed", "kept", "protected"]
        .filter((key) => data[key]?.length)
        .map((key) => `${key} ${data[key].map(line).join(" ")}`),
    ].join("\n");
  if (command === "pdf-text")
    return [
      `${line(data.title)}, ${Number(data.pageCount)} ${data.pageCount === 1 ? "page" : "pages"}, ${line(data.url)}`,
      ...pdfPages(data),
      ...(data.truncated
        ? [`More pages: rerun with --from ${Number(data.nextPage)}.`]
        : []),
      ...(data.noText ? ["No text on these pages; they may be scans."] : []),
    ].join("\n");
  if (command === "wait-expectation") return eventLine(data);
  if (command === "downloads")
    return data.downloads?.length
      ? data.downloads.map(downloadLine).join("\n")
      : "No downloads.";
  if (command === "cancel-download") return downloadLine(data.download ?? {});
  if (["set-input-files", "set-files"].includes(command))
    return [
      `ok: selected ${Number(data.selected)}`,
      ...receiptLines(data),
    ].join("\n");
  if (command === "http-credentials")
    return data.origin === undefined
      ? "ok: credentials cleared"
      : `ok: ${line(data.origin)}`;
  if (data?.expectation) return expectationLine(data.expectation);
  if (data && typeof data === "object" && "policy" in data)
    return dialogLines(data).join("\n");
  if (data?.space)
    return [
      `space ${data.space.id} ${JSON.stringify(line(data.space.name))} ${line(data.space.owner)}${signIns(data.space)}`,
      ...(Array.isArray(data.tabs)
        ? data.tabs.map((tab) => tabLine(tab, data.tabs))
        : []),
      ...(data.active ? [activeLine(data.active)] : []),
    ].join("\n");
  if (data?.tab)
    return [
      `tab ${data.tab.id} ${line(data.tab.url)}${
        data.httpStatus === undefined ? "" : ` ${Number(data.httpStatus)}`
      }`,
      ...(data.dialog ? [navigationDialogLine(data.dialog)] : []),
      ...infoLines(data),
      ...receiptLines({ ...data, dialog: undefined }),
    ].join("\n");
  if (data?.spaces)
    return data.spaces.length
      ? data.spaces
          .map(
            (space) =>
              `${space.id} ${JSON.stringify(line(space.name))} ${line(space.owner)}${signIns(space)}${task(space)}`,
          )
          .join("\n")
      : "No agent spaces.";
  if (data?.tabs)
    return data.tabs.length
      ? data.tabs.map((tab) => tabLine(tab, data.tabs)).join("\n")
      : "No tabs.";
  if (Array.isArray(data?.results)) {
    const output = data.results.map((result, index) => {
      const payload = result.snapshot || result.result || result;
      const name = result.type || result.action || "action";
      const detail =
        payload && "interactables" in payload
          ? `\n${formatSnapshot(payload)}`
          : result.ok === false || payload?.ok === false
            ? ` ${line(result.error?.message || result.error || payload.error?.message || payload.error || "failed")}`
            : ` ${actionSummary(payload || {}, result.type || result.action)}`;
      return [
        `${index + 1}. ${line(name)}${detail}`,
        ...receiptLines(payload || {}),
      ].join("\n");
    });
    if (data.ok === false)
      output.push(
        `Stopped at action ${Number(data.failedIndex) + 1}: ${line(data.error?.message || data.error || "failed")}`,
      );
    return output.join("\n");
  }
  if (data?.status)
    return `${line(data.status)}${data.version ? ` Kamapathy ${line(data.version)}` : ""}`;
  if (data?.ok)
    return data.owner === "human"
      ? "ok: human control, automation paused"
      : data.owner === "agent"
        ? [
            command === "wait-for-control"
              ? "ok: agent has control"
              : "ok: agent control resumed",
            ...boundaryLines(data),
          ].join("\n")
        : [actionSummary(data, command), ...receiptLines(data)].join("\n");
  return JSON.stringify(data);
}
