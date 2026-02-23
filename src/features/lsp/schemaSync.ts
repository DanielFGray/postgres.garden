/**
 * Transforms pg-introspection results into the PGLS SchemaCache format
 * and syncs it to the language server worker.
 */
import * as S from "effect/Schema";
import { Array, Option, pipe } from "effect";
import type { Introspection } from "pg-introspection";
import type { LanguageClient } from "vscode-languageclient/browser";

// ─── Effect Schema definitions for PGLS SchemaCache ─────────────────────────

const PglsSchema = S.Struct({
  id: S.Number,
  name: S.String,
  owner: S.String,
  allowed_users: S.Array(S.String),
  allowed_creators: S.Array(S.String),
  table_count: S.Number,
  view_count: S.Number,
  function_count: S.Number,
  total_size: S.String,
  comment: S.NullOr(S.String),
});

const ReplicaIdentity = S.Literal("Default", "Index", "Full", "Nothing");
const TableKind = S.Literal("Ordinary", "View", "MaterializedView", "Partitioned");

const PglsTable = S.Struct({
  id: S.Number,
  schema: S.String,
  name: S.String,
  rls_enabled: S.Boolean,
  rls_forced: S.Boolean,
  replica_identity: ReplicaIdentity,
  table_kind: TableKind,
  bytes: S.Number,
  size: S.String,
  live_rows_estimate: S.Number,
  dead_rows_estimate: S.Number,
  comment: S.NullOr(S.String),
});

const ColumnClassKind = S.Literal(
  "OrdinaryTable",
  "View",
  "MaterializedView",
  "ForeignTable",
  "PartitionedTable",
);

const PglsColumn = S.Struct({
  name: S.String,
  table_name: S.String,
  table_oid: S.Number,
  class_kind: ColumnClassKind,
  number: S.Number,
  schema_name: S.String,
  type_id: S.Number,
  type_name: S.NullOr(S.String),
  is_nullable: S.Boolean,
  is_primary_key: S.Boolean,
  is_unique: S.Boolean,
  default_expr: S.NullOr(S.String),
  varchar_length: S.NullOr(S.Number),
  comment: S.NullOr(S.String),
});

const PglsFunctionArg = S.Struct({
  mode: S.String,
  name: S.String,
  type_id: S.Number,
  has_default: S.NullOr(S.Boolean),
});

const PglsFunction = S.Struct({
  id: S.Number,
  schema: S.String,
  name: S.String,
  language: S.String,
  kind: S.Literal("Function", "Aggregate", "Window", "Procedure"),
  body: S.NullOr(S.String),
  definition: S.NullOr(S.String),
  args: S.Struct({ args: S.Array(PglsFunctionArg) }),
  argument_types: S.NullOr(S.String),
  identity_argument_types: S.NullOr(S.String),
  return_type_id: S.NullOr(S.Number),
  return_type: S.NullOr(S.String),
  return_type_relation_id: S.NullOr(S.Number),
  is_set_returning_function: S.Boolean,
  behavior: S.Literal("Immutable", "Stable", "Volatile"),
  security_definer: S.Boolean,
});

const PglsVersion = S.Struct({
  version: S.NullOr(S.String),
  version_num: S.NullOr(S.Number),
  major_version: S.NullOr(S.Number),
  active_connections: S.NullOr(S.Number),
  max_connections: S.NullOr(S.Number),
});

export const SchemaCache = S.Struct({
  schemas: S.Array(PglsSchema),
  tables: S.Array(PglsTable),
  columns: S.Array(PglsColumn),
  functions: S.Array(PglsFunction),
  types: S.Array(S.Unknown),
  version: PglsVersion,
  policies: S.Array(S.Unknown),
  extensions: S.Array(S.Unknown),
  triggers: S.Array(S.Unknown),
  roles: S.Array(S.Unknown),
});

export type SchemaCache = typeof SchemaCache.Type;

// ─── Transform pg-introspection → PGLS SchemaCache ──────────────────────────

const SYSTEM_SCHEMAS = new Set(["pg_catalog", "pg_toast", "information_schema"]);

function relkindToTableKind(
  relkind: string,
): "Ordinary" | "View" | "MaterializedView" | "Partitioned" {
  switch (relkind) {
    case "v":
      return "View";
    case "m":
      return "MaterializedView";
    case "p":
      return "Partitioned";
    default:
      return "Ordinary";
  }
}

function relkindToClassKind(
  relkind: string,
): "OrdinaryTable" | "View" | "MaterializedView" | "ForeignTable" | "PartitionedTable" {
  switch (relkind) {
    case "v":
      return "View";
    case "m":
      return "MaterializedView";
    case "f":
      return "ForeignTable";
    case "p":
      return "PartitionedTable";
    default:
      return "OrdinaryTable";
  }
}

function prokindToPglsKind(
  prokind: string | null | undefined,
): "Function" | "Aggregate" | "Window" | "Procedure" {
  switch (prokind) {
    case "a":
      return "Aggregate";
    case "w":
      return "Window";
    case "p":
      return "Procedure";
    default:
      return "Function";
  }
}

function provolatileToBehavior(
  provolatile: string | null | undefined,
): "Immutable" | "Stable" | "Volatile" {
  switch (provolatile) {
    case "i":
      return "Immutable";
    case "s":
      return "Stable";
    default:
      return "Volatile";
  }
}

const fromNullableOr = <A>(value: A | null | undefined, fallback: A): A =>
  value ?? fallback;

/**
 * Transform a pg-introspection result into the PGLS SchemaCache format.
 * Filters out system schemas (pg_catalog, pg_toast, information_schema).
 */
export function toSchemaCache(introspection: Introspection): SchemaCache {
  const userNamespaces = introspection.namespaces.filter(
    (n) =>
      !SYSTEM_SCHEMAS.has(n.nspname) &&
      !n.nspname.startsWith("pg_temp_") &&
      !n.nspname.startsWith("pg_toast_temp_"),
  );

  const nsIdSet = new Set(userNamespaces.map((n) => n._id));

  // Build a lookup: class _id → namespace name
  const classToNs = new Map(
    Array.filterMap(introspection.classes, (cls) =>
      pipe(
        Array.findFirst(introspection.namespaces, (n) => n._id === cls.relnamespace),
        Option.map((ns) => [cls._id, ns.nspname] as const),
      ),
    ),
  );

  // Primary key lookup: attrelid+attnum → isPK
  const pkSet = new Set(
    Array.flatMap(introspection.constraints, (con) =>
      con.contype === "p" && con.conkey
        ? con.conkey.map((num) => `${con.conrelid}:${num}`)
        : ([] as string[]),
    ),
  );
  const uniqueSet = new Set(
    Array.flatMap(introspection.constraints, (con) =>
      con.contype === "u" && con.conkey
        ? con.conkey.map((num) => `${con.conrelid}:${num}`)
        : ([] as string[]),
    ),
  );

  const userClasses = introspection.classes.filter(
    (cls) => nsIdSet.has(cls.relnamespace) && ["r", "v", "m", "p", "f"].includes(cls.relkind),
  );

  const schemas: SchemaCache["schemas"] = userNamespaces.map((n) => {
    const tables = introspection.classes.filter(
      (c) => c.relnamespace === n._id && ["r", "p"].includes(c.relkind),
    );
    const views = introspection.classes.filter(
      (c) => c.relnamespace === n._id && ["v", "m"].includes(c.relkind),
    );
    const funcs = introspection.procs.filter((p) => p.pronamespace === n._id);
    return {
      id: Number(n._id),
      name: n.nspname,
      owner: pipe(
        Array.findFirst(introspection.roles, (r) => r._id === n.nspowner),
        Option.map((role) => role.rolname),
        Option.getOrElse(() => "unknown"),
      ),
      allowed_users: [],
      allowed_creators: [],
      table_count: tables.length,
      view_count: views.length,
      function_count: funcs.length,
      total_size: "0 bytes",
      comment: null,
    };
  });

  const tables: SchemaCache["tables"] = userClasses.map((cls) => ({
    id: Number(cls._id),
    schema: fromNullableOr(classToNs.get(cls._id), "public"),
    name: cls.relname,
    rls_enabled: cls.relrowsecurity ?? false,
    rls_forced: cls.relforcerowsecurity ?? false,
    replica_identity: "Default" as const,
    table_kind: relkindToTableKind(cls.relkind),
    bytes: 0,
    size: "0 bytes",
    live_rows_estimate: Number(cls.reltuples ?? 0),
    dead_rows_estimate: 0,
    comment: null,
  }));

  const columns: SchemaCache["columns"] = introspection.attributes
    .flatMap((attr) => {
      if (attr.attnum < 1 || attr.attisdropped) return [];
      return pipe(
        Array.findFirst(introspection.classes, (c) => c._id === attr.attrelid),
        Option.filter(
          (cls) => nsIdSet.has(cls.relnamespace) && ["r", "v", "m", "p", "f"].includes(cls.relkind),
        ),
        Option.match({
          onNone: () => [] as SchemaCache["columns"],
          onSome: (cls) => {
            const key = `${attr.attrelid}:${attr.attnum}`;
            const typeName = pipe(
              Array.findFirst(introspection.types, (t) => t._id === attr.atttypid),
              Option.map((type) => type.typname),
              Option.getOrNull,
            );
            return [
              {
                name: attr.attname,
                table_name: cls.relname,
                table_oid: Number(cls._id),
                class_kind: relkindToClassKind(cls.relkind),
                number: attr.attnum,
                schema_name: fromNullableOr(classToNs.get(cls._id), "public"),
                type_id: Number(attr.atttypid),
                type_name: typeName,
                is_nullable: !(attr.attnotnull ?? false),
                is_primary_key: pkSet.has(key),
                is_unique: pkSet.has(key) || uniqueSet.has(key),
                default_expr: null,
                varchar_length: attr.atttypmod != null && attr.atttypmod > 0 ? attr.atttypmod - 4 : null,
                comment: null,
              },
            ];
          },
        }),
      );
    });

  const functions: SchemaCache["functions"] = introspection.procs
    .filter((p) => nsIdSet.has(p.pronamespace))
    .map((p) => {
      const ns = introspection.namespaces.find((n) => n._id === p.pronamespace);
      const lang = introspection.languages.find((l) => l._id === p.prolang);
      const argNames = p.proargnames ?? [];
      const argTypes = p.proargtypes ?? [];
      const argModes = p.proargmodes ?? [];
      const args = argTypes.map((typeId, i) => ({
        mode: argModes[i] ?? "i",
        name: argNames[i] ?? `$${i + 1}`,
        type_id: Number(typeId),
        has_default: null,
      }));
      return {
        id: Number(p._id),
        schema: pipe(
          Option.fromNullable(ns),
          Option.map((namespace) => namespace.nspname),
          Option.getOrElse(() => "public"),
        ),
        name: p.proname,
        language: pipe(
          Option.fromNullable(lang),
          Option.flatMap((language) => Option.fromNullable(language.lanname)),
          Option.getOrElse(() => "sql"),
        ),
        kind: prokindToPglsKind(p.prokind),
        body: p.prosrc ?? null,
        definition: null,
        args: { args },
        argument_types: null,
        identity_argument_types: null,
        return_type_id: pipe(
          Option.fromNullable(p.prorettype),
          Option.map((typeId) => Number(typeId)),
          Option.getOrNull,
        ),
        return_type: pipe(
          Option.fromNullable(p.prorettype),
          Option.flatMap((returnTypeId) =>
            Array.findFirst(introspection.types, (type) => type._id === returnTypeId),
          ),
          Option.map((type) => type.typname),
          Option.getOrNull,
        ),
        return_type_relation_id: null,
        is_set_returning_function: p.proretset ?? false,
        behavior: provolatileToBehavior(p.provolatile),
        security_definer: p.prosecdef ?? false,
      };
    });

  return {
    schemas,
    tables,
    columns,
    functions,
    types: [],
    version: {
      version: null,
      version_num: null,
      major_version: null,
      active_connections: null,
      max_connections: null,
    },
    policies: [],
    extensions: [],
    triggers: [],
    roles: [],
  };
}

// ─── Sync to language server ────────────────────────────────────────────────

/**
 * Send a SchemaCache to the language server via pgls/setSchema notification.
 */
export function syncSchema(client: LanguageClient, introspection: Introspection): void {
  try {
    const cache = toSchemaCache(introspection);
    const encoded = S.encodeSync(SchemaCache)(cache);
    void client.sendNotification("pgls/setSchema", {
      schema: JSON.stringify(encoded),
    });
    console.log(
      `[PGLS] Schema synced: ${cache.schemas.length} schemas, ${cache.tables.length} tables, ${cache.columns.length} columns, ${cache.functions.length} functions`,
    );
  } catch (err) {
    console.warn("[PGLS] Schema sync error:", err instanceof Error ? err.message : String(err));
  }
}
