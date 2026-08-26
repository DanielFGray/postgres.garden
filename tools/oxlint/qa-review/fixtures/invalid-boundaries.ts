import { Schema } from "effect";

const UserShape = Schema.Struct({ name: Schema.String });

export function forwardUnknown(input: unknown): unknown {
  return input;
}

export function handParse(input: unknown) {
  return typeof input === "string" ? input.trim() : input;
}

export const omitted = (enabled: boolean) => ({
  ...(enabled ? { enabled } : {}),
});

const widened: unknown = { name: "Ada" };
const asserted = widened as { name: string };

const chained = { name: "Ada" } as unknown as { name: string };

void UserShape;
void asserted;
void chained;
