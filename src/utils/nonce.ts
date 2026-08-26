const NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const generateNonce = (length = 32): string =>
  Array.from({ length }, () => {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return NONCE_CHARS[Math.floor((bytes[0]! / 0xffffffff) * NONCE_CHARS.length)] ?? "";
  }).join("");
