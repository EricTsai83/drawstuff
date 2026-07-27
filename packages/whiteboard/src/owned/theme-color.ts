import type { WhiteboardTheme } from "../contracts";

export const OWNED_DARK_THEME_FILTER = "invert(93%) hue-rotate(180deg)";

interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

const darkColorCache = new Map<string, string>();

/**
 * Mirrors Excalidraw's dark-canvas color transform without mutating the
 * persisted element color. The operation order matches the CSS filter used by
 * Excalidraw's interactive canvas.
 */
export function applyOwnedDarkModeFilter(
  color: string,
  enabled = true,
): string {
  if (!enabled) return color;
  const cached = darkColorCache.get(color);
  if (cached) return cached;
  const parsed = parseCssColor(color);
  if (!parsed) return color;
  const inverted = {
    red: invertChannel(parsed.red, 0.93),
    green: invertChannel(parsed.green, 0.93),
    blue: invertChannel(parsed.blue, 0.93),
  };
  const rotated = rotateHue180(inverted.red, inverted.green, inverted.blue);
  const result = rgbaToHex({ ...rotated, alpha: parsed.alpha });
  darkColorCache.set(color, result);
  return result;
}

export function resolveOwnedThemeColor(
  color: string,
  theme: WhiteboardTheme,
): string {
  return applyOwnedDarkModeFilter(color, theme === "dark");
}

function parseCssColor(color: string): RgbaColor | null {
  const value = color.trim().toLowerCase();
  if (value === "transparent") {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }
  const named = NAMED_COLORS[value];
  if (named) return parseHexColor(named);
  const hex = parseHexColor(value);
  if (hex) return hex;
  const functional = parseFunctionalColor(value);
  if (functional) return functional;
  return parseBrowserColor(value);
}

function parseHexColor(value: string): RgbaColor | null {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (!match?.[1]) return null;
  const hex =
    match[1].length <= 4
      ? [...match[1]].map((character) => character.repeat(2)).join("")
      : match[1];
  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16),
    alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function parseFunctionalColor(value: string): RgbaColor | null {
  const match = /^rgba?\((.*)\)$/.exec(value);
  if (!match?.[1]) return null;
  const components = match[1]
    .trim()
    .replace(/\s*\/\s*/, ",")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (components.length !== 3 && components.length !== 4) return null;
  const channels = components
    .slice(0, 3)
    .map((component) => parseRgbChannel(component));
  if (channels.some((channel) => channel === null)) return null;
  const alpha =
    components[3] === undefined ? 1 : parseAlphaChannel(components[3]);
  if (alpha === null) return null;
  return {
    red: channels[0]!,
    green: channels[1]!,
    blue: channels[2]!,
    alpha,
  };
}

function parseRgbChannel(value: string): number | null {
  const percentage = value.endsWith("%");
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(percentage ? (parsed / 100) * 255 : parsed, 0, 255);
}

function parseAlphaChannel(value: string): number | null {
  const percentage = value.endsWith("%");
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(percentage ? parsed / 100 : parsed, 0, 1);
}

function parseBrowserColor(value: string): RgbaColor | null {
  if (typeof document === "undefined" || !document.body) return null;
  const probe = document.createElement("span");
  probe.style.color = value;
  if (!probe.style.color) return null;
  probe.style.display = "none";
  document.body.append(probe);
  const normalized = getComputedStyle(probe).color;
  probe.remove();
  return parseFunctionalColor(normalized) ?? parseHexColor(normalized);
}

function invertChannel(channel: number, amount: number): number {
  return Math.round(
    clamp(channel * (1 - amount) + (255 - channel) * amount, 0, 255),
  );
}

function rotateHue180(
  red: number,
  green: number,
  blue: number,
): Pick<RgbaColor, "red" | "green" | "blue"> {
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const cosine = -1;
  const sine = 0;
  const matrix = [
    0.213 + cosine * 0.787 - sine * 0.213,
    0.715 - cosine * 0.715 - sine * 0.715,
    0.072 - cosine * 0.072 + sine * 0.928,
    0.213 - cosine * 0.213 + sine * 0.143,
    0.715 + cosine * 0.285 + sine * 0.14,
    0.072 - cosine * 0.072 - sine * 0.283,
    0.213 - cosine * 0.213 - sine * 0.787,
    0.715 - cosine * 0.715 + sine * 0.715,
    0.072 + cosine * 0.928 + sine * 0.072,
  ] as const;
  return {
    red: Math.round(
      clamp(
        normalizedRed * matrix[0] +
          normalizedGreen * matrix[1] +
          normalizedBlue * matrix[2],
        0,
        1,
      ) * 255,
    ),
    green: Math.round(
      clamp(
        normalizedRed * matrix[3] +
          normalizedGreen * matrix[4] +
          normalizedBlue * matrix[5],
        0,
        1,
      ) * 255,
    ),
    blue: Math.round(
      clamp(
        normalizedRed * matrix[6] +
          normalizedGreen * matrix[7] +
          normalizedBlue * matrix[8],
        0,
        1,
      ) * 255,
    ),
  };
}

function rgbaToHex(color: RgbaColor): string {
  const channels = [color.red, color.green, color.blue].map(toHexChannel);
  const alpha = Math.round(clamp(color.alpha, 0, 1) * 255);
  return `#${channels.join("")}${alpha === 255 ? "" : toHexChannel(alpha)}`;
}

function toHexChannel(value: number): string {
  return Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: "#000000",
  blue: "#0000ff",
  green: "#008000",
  red: "#ff0000",
  white: "#ffffff",
};
