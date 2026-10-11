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

export function formatSnapshot(snapshot) {
  const lines = [line(snapshot.title) || "Untitled page", line(snapshot.url)];
  if (snapshot.text) lines.push("", printable(snapshot.text).trim());
  if (snapshot.interactables?.length) {
    lines.push("", "Controls:");
    for (const control of snapshot.interactables) {
      lines.push(
        `${line(control.ref || control.selector)} ${line(control.role || control.tag)} ${JSON.stringify(line(control.label))}${controlDetails(control)}`,
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
  if (snapshot.truncated)
    lines.push(
      "",
      "Truncated. Scope with --selector or request --full if needed.",
    );
  return lines.join("\n");
}

// What an action did beyond succeeding, such as which panel scrolled.
export function actionSummary(data) {
  const notes = [];
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
  return notes.length ? `ok: ${notes.join("; ")}` : "ok";
}

// Older Kamapathy versions return spaces without signIns; nothing is added then.
const signIns = (space) =>
  space.signIns === "separate"
    ? " isolated"
    : space.signIns === "shared"
      ? " shared"
      : "";

export function formatResult(data) {
  if (data && "interactables" in data && "url" in data)
    return formatSnapshot(data);
  if (data?.space)
    return `space ${data.space.id} ${JSON.stringify(line(data.space.name))} ${line(data.space.owner)}${signIns(data.space)}`;
  if (data?.tab) return `tab ${data.tab.id} ${line(data.tab.url)}`;
  if (data?.spaces)
    return data.spaces.length
      ? data.spaces
          .map(
            (space) =>
              `${space.id} ${JSON.stringify(line(space.name))} ${line(space.owner)}${signIns(space)}`,
          )
          .join("\n")
      : "No agent spaces.";
  if (data?.tabs)
    return data.tabs.length
      ? data.tabs
          .map((tab) => `${tab.id} ${line(tab.title)} ${line(tab.url)}`)
          .join("\n")
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
            : ` ${actionSummary(payload || {})}`;
      return `${index + 1}. ${line(name)}${detail}`;
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
        ? "ok: agent control resumed"
        : actionSummary(data);
  return JSON.stringify(data);
}
