/**
 * Excalidraw names a canvas nobody named `${t("labels.untitled")}-YYYY-MM-DD-HHMM`
 * (upstream App.tsx, getDateTime). That is a timestamp, not a name: treat it as
 * no name so it never becomes a room's or scene's default label. Only the
 * untitled prefixes of the languages this app offers count — a chosen name that
 * happens to end in a timestamp is still a name.
 */
const UPSTREAM_DEFAULT_NAME =
  /^(?:Untitled|\u7121\u6a19\u984c|\u65e0\u6807\u9898)-\d{4}-\d{2}-\d{2}-\d{4}$/;

export function meaningfulSceneName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  return UPSTREAM_DEFAULT_NAME.test(trimmed) ? "" : trimmed;
}
