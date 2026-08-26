import { Schema } from "effect";

const UserSchema = Schema.Struct({ name: Schema.String });

export function decodeUser(input: unknown) {
  return Schema.decodeUnknownSync(UserSchema)(input);
}

export function narrowTypedUnion(value: string | number) {
  return typeof value === "string" ? value.length : value;
}

export const omitOptional = (enabled: boolean) => (enabled ? { enabled } : { enabled: false });
