const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode bytes as standard base64 without relying on Node or DOM globals. */
export const encodeBase64 = (bytes: Uint8Array): string => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += second === undefined ? "=" : alphabet[(triple >> 6) & 63];
    output += third === undefined ? "=" : alphabet[triple & 63];
  }
  return output;
};

const indexOf = (character: string): number => alphabet.indexOf(character);

/** Decode standard base64, rejecting malformed input. */
export const decodeBase64 = (input: string): Uint8Array => {
  const normalized = input.replaceAll(/\s+/g, "");
  if (normalized.length % 4 !== 0) {
    throw new Error("Invalid base64 length");
  }

  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((normalized.length / 4) * 3 - padding);
  let offset = 0;

  for (let index = 0; index < normalized.length; index += 4) {
    const a = indexOf(normalized[index] ?? "");
    const b = indexOf(normalized[index + 1] ?? "");
    const c = normalized[index + 2] === "=" ? 0 : indexOf(normalized[index + 2] ?? "");
    const d = normalized[index + 3] === "=" ? 0 : indexOf(normalized[index + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error("Invalid base64 character");
    }
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < bytes.length) bytes[offset++] = (triple >> 16) & 255;
    if (offset < bytes.length) bytes[offset++] = (triple >> 8) & 255;
    if (offset < bytes.length) bytes[offset++] = triple & 255;
  }

  return bytes;
};
