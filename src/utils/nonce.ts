const NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const generateNonce = (length = 32): string =>
  Array.from(
    { length },
    () => NONCE_CHARS[Math.floor(Math.random() * NONCE_CHARS.length)] ?? "",
  ).join("");
