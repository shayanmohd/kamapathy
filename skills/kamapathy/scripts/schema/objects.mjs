// The members of Download and FileChooser, the objects an armed wait answers
// with. help() and the generated reference list them after Page.

const member = (name, signature, summary, args, returns, extra = {}) => ({
  name,
  kind: "method",
  signature,
  summary,
  args,
  ...(extra.options ? { options: extra.options } : {}),
  ...(extra.expected ? { expected: extra.expected } : {}),
  returns,
  ...(extra.route ? { route: extra.route } : {}),
  errors: extra.errors ?? [],
  since: extra.since ?? 2,
});
// Everything a held download can answer with once its space is the agent's.
const DOWNLOAD = [
  "download_not_found",
  "human_control",
  "space_ended",
  "automation_stopped",
];
// The file paths a chooser takes, counted before anything is read.
const FILES = { name: "files", kind: "files", max: 8 };
const OPTIONS = { name: "options", kind: "options", optional: true };

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
    "Download.saveAs",
    "download.saveAs(path, options?)",
    "Waits for the download, then writes its bytes to a new file at mode 0600, creating missing folders. It never overwrites, and the path is this computer's.",
    [{ name: "path", kind: "string" }, OPTIONS],
    "Promise<string>",
    {
      route: "GET /downloads/:id/content",
      options: {
        timeout: {
          kind: "ms",
          min: 1,
          max: 3600000,
          description:
            "How long to wait for the download to finish. What is left of the run by default.",
        },
      },
      errors: [
        "download_timeout",
        "download_failed",
        "download_not_finished",
        "download_interrupted",
        "file_exists",
        "busy",
        ...DOWNLOAD,
      ],
    },
  ),
  member(
    "Download.path",
    "download.path()",
    "A private copy of the download on this computer, in a folder only this account can read. delete() and leaving the process remove it.",
    [],
    "Promise<string>",
    {
      route: "GET /downloads/:id/content",
      errors: [
        "download_timeout",
        "download_failed",
        "download_not_finished",
        "download_interrupted",
        "busy",
        ...DOWNLOAD,
      ],
    },
  ),
  member(
    "Download.failure",
    "download.failure()",
    "Why the download did not finish, or null while it is running or once it is complete.",
    [],
    'Promise<null | "cancelled" | "interrupted" | "too_large">',
    { route: "GET /downloads/:id", errors: DOWNLOAD },
  ),
  member(
    "Download.cancel",
    "download.cancel()",
    "Stops a download that is still running. A finished one is left as it is.",
    [],
    "Promise<{ download: DownloadRecord }>",
    { route: "POST /downloads/:id/cancel", errors: DOWNLOAD },
  ),
  member(
    "Download.delete",
    "download.delete()",
    "Deletes the download's bytes from the browser's profile, and the private copy path() wrote.",
    [],
    "Promise<{ ok: true }>",
    { route: "DELETE /downloads/:id", errors: DOWNLOAD },
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
  member(
    "FileChooser.setFiles",
    "fileChooser.setFiles(files)",
    "Puts 0 to 8 local files on the chooser's input, even one the page has removed. An empty list cancels the chooser.",
    [FILES],
    "Promise<{ ok: true, selected: number }>",
    {
      route: "POST /file-choosers/:id/files",
      expected: "fileChooser.setFiles(files) with 0 to 8 file paths",
      errors: [
        "file_chooser_not_found",
        "invalid_files",
        "invalid_file_type",
        "files_too_large",
        "invalid_upload_target",
        "upload_busy",
        "human_control",
        "tab_unmanaged",
        "tab_closed",
        "page_changed",
        "automation_stopped",
      ],
    },
  ),
];
