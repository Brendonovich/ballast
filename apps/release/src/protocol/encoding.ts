export function hex(bytes: Uint8Array | ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes))
}
