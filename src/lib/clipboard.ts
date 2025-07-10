import { MIME_TYPES } from "@excalidraw/excalidraw/constants";

export const probablySupportsClipboardWriteText =
  "clipboard" in navigator && "writeText" in navigator.clipboard;

export const copyTextToSystemClipboard = async (
  text: string | null,
  clipboardEvent?: ClipboardEvent | null,
) => {
  // (1) first try using Async Clipboard API
  if (probablySupportsClipboardWriteText) {
    try {
      // NOTE: doesn't work on FF on non-HTTPS domains, or when document
      // not focused
      await navigator.clipboard.writeText(text ?? "");
      return;
    } catch (error: unknown) {
      console.error(error);
    }
  }

  // (2) if fails and we have access to ClipboardEvent, use plain old setData()
  try {
    if (clipboardEvent) {
      clipboardEvent.clipboardData?.setData(MIME_TYPES.text, text ?? "");
      if (clipboardEvent.clipboardData?.getData(MIME_TYPES.text) !== text) {
        throw new Error("Failed to setData on clipboardEvent");
      }
      return;
    }
  } catch (error: unknown) {
    console.error(error);
  }

  // (3) if that fails, use document.execCommand
  if (!copyTextViaExecCommand(text)) {
    throw new Error("Error copying to clipboard.");
  }
};

const copyTextViaExecCommand = (text: string | null) => {
  // execCommand doesn't allow copying empty strings, so if we're
  // clearing clipboard using this API, we must copy at least an empty char
  text ??= " ";

  const isRTL = document.documentElement.getAttribute("dir") === "rtl";

  const textarea = document.createElement("textarea");

  textarea.style.border = "0";
  textarea.style.padding = "0";
  textarea.style.margin = "0";
  textarea.style.position = "absolute";
  textarea.style[isRTL ? "right" : "left"] = "-9999px";
  const yPosition = window.pageYOffset || document.documentElement.scrollTop;
  textarea.style.top = `${yPosition}px`;
  // Prevent zooming on iOS
  textarea.style.fontSize = "12pt";

  textarea.setAttribute("readonly", "");
  textarea.value = text;

  document.body.appendChild(textarea);

  let success = false;

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    success = document.execCommand("copy");
  } catch (error: unknown) {
    console.error(error);
  }

  textarea.remove();

  return success;
};
