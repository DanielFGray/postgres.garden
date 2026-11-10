import { DateTime } from "effect";

export function formatDate(date: Date) {
  return DateTime.formatLocal(DateTime.fromDateUnsafe(date), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** A text field's value from a submitted form; a missing or file field reads as empty. */
export function formText(data: FormData, name: string) {
  const value = data.get(name);
  return value instanceof File ? "" : (value ?? "");
}
