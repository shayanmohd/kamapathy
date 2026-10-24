// The members of Download and FileChooser, the objects an armed wait answers
// with. help() and the generated reference list them after Page.

const member = (name, signature, summary, args, returns, extra = {}) => ({
  name,
  kind: "method",
  signature,
  summary,
  args,
  returns,
  ...(extra.route ? { route: extra.route } : {}),
  errors: extra.errors ?? [],
  since: extra.since ?? 2,
});

export const OBJECTS = [
  member(
    "Download.url",
    "download.url()",
    "The address the download came from.",
    [],
    "string",
  ),
  member(
    "Download.suggestedFilename",
    "download.suggestedFilename()",
    "The file name the site suggested.",
    [],
    "string",
  ),
  member(
    "Download.page",
    "download.page()",
    "The page the download started in, which may since have closed.",
    [],
    "Page",
  ),
  member(
    "FileChooser.page",
    "fileChooser.page()",
    "The page whose file chooser this is.",
    [],
    "Page",
  ),
  member(
    "FileChooser.isMultiple",
    "fileChooser.isMultiple()",
    "Whether the input takes more than one file.",
    [],
    "boolean",
  ),
];
