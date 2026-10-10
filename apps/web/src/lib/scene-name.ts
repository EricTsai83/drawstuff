/**
 * Excalidraw names a canvas nobody named `${t("labels.untitled")}-YYYY-MM-DD-HHMM`
 * (upstream App.tsx, getDateTime). That is a timestamp, not a name: treat it as
 * no name so it never becomes a room's or scene's default label.
 */
const UPSTREAM_DEFAULT_NAME = /^.+-\d{4}-\d{2}-\d{2}-\d{4}$/;

export function meaningfulSceneName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  return UPSTREAM_DEFAULT_NAME.test(trimmed) ? "" : trimmed;
}
