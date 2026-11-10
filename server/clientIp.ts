/**
 * The part of a client address that identifies one network, used as a rate-limit
 * key. An IPv4 address stands for one connection. A person on IPv6 controls a
 * whole /64 and can switch inside it for free, so every address in the /64 maps
 * to the same key.
 */
export const networkOf = (address: string): string => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!address.includes(":")) return address;
  return expandIPv6(address).slice(0, 4).join(":");
};

/** The eight hextets of an IPv6 address, lower-case, with `::` filled in. */
const expandIPv6 = (address: string): ReadonlyArray<string> => {
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const first = head === "" ? [] : head.split(":");
  const last = tail === "" ? [] : tail.split(":");
  const gap = address.includes("::") ? Array<string>(8 - first.length - last.length).fill("0") : [];
  return [...first, ...gap, ...last].map((hextet) => hextet.replace(/^0+(?=.)/, ""));
};
