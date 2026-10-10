export const FORM_DIALOG_CONTENT_CLASS_NAME =
  "max-h-(--app-dialog-max-height) max-sm:h-[calc(100dvh-2rem)] max-sm:w-[calc(100%-2rem)] sm:max-w-lg";

// Pinned to a fixed top from sm up: a vertically centred dialog moves its top
// edge whenever its content grows or shrinks (a row added, a notice shown).
export const WORKFLOW_DIALOG_CONTENT_CLASS_NAME =
  "max-h-(--app-dialog-max-height) max-sm:h-[calc(100dvh-2rem)] max-sm:w-[calc(100%-2rem)] sm:top-[10dvh] sm:max-h-[80dvh] sm:max-w-2xl sm:translate-y-0";

export const CONFIRM_DIALOG_CONTENT_CLASS_NAME =
  "max-h-(--app-dialog-max-height) max-sm:w-[calc(100%-2rem)] sm:max-w-lg";

export const DIALOG_ACTIONS_CLASS_NAME =
  "bg-popover sticky bottom-0 flex flex-col-reverse gap-2 py-2 sm:flex-row sm:justify-end [&>button]:w-full sm:[&>button]:w-auto";

export const COPY_LINK_ROW_CLASS_NAME =
  "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center [&_input]:min-w-0";
