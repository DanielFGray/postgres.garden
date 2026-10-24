import { DateTime } from "effect";

export function formatDate(dateStr: string) {
  return DateTime.toDate(DateTime.makeUnsafe(dateStr)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
