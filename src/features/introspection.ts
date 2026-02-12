import * as vscode from "vscode";
import {
  Introspection,
  makeIntrospectionQuery,
  parseIntrospectionResults,
} from "pg-introspection";
import { PGLITE_EXECUTE, type ExtendedResults } from "./constants.js";

export class DatabaseExplorerProvider
  implements vscode.TreeDataProvider<Entity>
{
  introspection: Introspection | undefined;

  #onDidChangeTreeData: vscode.EventEmitter<Entity | undefined | null | void> =
    new vscode.EventEmitter<Entity | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Entity | undefined | null | void> =
    this.#onDidChangeTreeData.event;

  refresh = async (): Promise<void> => {
    const [result] = await vscode.commands.executeCommand<ExtendedResults[]>(
      PGLITE_EXECUTE,
      makeIntrospectionQuery(),
    );
    if (!result || "error" in result) {
      console.error("Failed to fetch introspection data");
      return;
    }
    const introspectionJson = result.rows[0]?.introspection as string;
    if (!introspectionJson) {
      console.error("No introspection data returned");
      return;
    }
    this.introspection = parseIntrospectionResults(introspectionJson, true);
    this.#onDidChangeTreeData.fire();
  };

  getTreeItem(element: Entity): vscode.TreeItem {
    return element;
  }

  getParent(element: Entity): vscode.ProviderResult<Entity> {
    return element.parent;
  }

  getChildren(parent?: Entity): Entity[] {
    if (!this.introspection) return [];
    if (!parent) {
      return this.introspection.namespaces
        .filter((n) => n.nspname !== "pg_catalog" && n.nspname !== "pg_toast")
        .map(
          (n) =>
            new Entity({
              id: n._id,
              label: n.nspname,
              description: "schema",
              kind: "schema",
              icon: "symbol-namespace",
              state: vscode.TreeItemCollapsibleState.Expanded,
            }),
        );
    }
    switch (parent.kind) {
      case "schema": {
        if (
          vscode.workspace
            .getConfiguration("postgres.garden.introspection-tree")
            .get(
              "grouping",
              "grouped by type" as "grouped by type" | "alphabetical",
            ) === "alphabetical"
        ) {
          const id = parent.id;
          const tables = this.introspection.classes
            .filter(
              (table) => table.relnamespace === id && table.relkind === "r",
            )
            .map(
              (t) =>
                new Entity({
                  id: t._id,
                  label: t.relname,
                  kind: "table",
                  description: "table",
                  icon: "symbol-structure",
                  state: vscode.TreeItemCollapsibleState.Collapsed,
                }),
            );
          const views = this.introspection.classes
            .filter(
              (table) => table.relnamespace === id && table.relkind === "v",
            )
            .map(
              (t) =>
                new Entity({
                  id: t._id,
                  label: t.relname,
                  kind: "view",
                  description: "view",
                  icon: "symbol-structure",
                  state: vscode.TreeItemCollapsibleState.Collapsed,
                }),
            );
          const domains = this.introspection.types
            .filter((t) => t.typtype === "d" && t.typnamespace === id)
            .map(
              (t) =>
                new Entity({
                  id: t._id,
                  label: t.typname,
                  kind: "label",
                  // TODO: find how to get domain type name [text, int, etc]
                  description: "domain",
                  icon: "symbol-attribute",
                  state: vscode.TreeItemCollapsibleState.None,
                }),
            );

          const enums = this.introspection.types
            .filter((t) => t.typtype === "e" && t.typnamespace === id)
            .map((t) => {
              const values = t.getEnumValues();
              if (!values)
                throw new Error(`could not find enum values for ${t.typname}`);
              return new Entity({
                id: t._id,
                label: t.typname,
                kind: "enum",
                description: "enum",
                icon: "symbol-attribute",
                state: vscode.TreeItemCollapsibleState.Collapsed,
                // values: values.map(x => x.enumlabel),
              });
            });

          const composites = this.introspection.classes
            .filter((cls) => cls.relkind === "c" && cls.relnamespace === id)
            .map(
              (t) =>
                new Entity({
                  id: t._id,
                  label: t.relname,
                  kind: "composite",
                  description: "composite",
                  icon: "symbol-structure",
                  state: vscode.TreeItemCollapsibleState.Collapsed,
                  // values: t.getAttributes().map(a => {
                  //   const type = a.getType();
                  //   if (!type)
                  //     throw new Error(
                  //       `could not find type for composite attribute ${t.relname}`,
                  //     );
                  //   return { name: a.attname, type: type.typname };
                  // }),
                }),
            );
          const types = [...domains, ...enums, ...composites];
          const functions = this.introspection.procs
            .filter((proc) => proc.pronamespace === id)
            .map((proc) => {
              const args =
                proc.pronargs && proc.pronargs > 0 ? proc.pronargs : "";
              return new Entity({
                id: proc._id,
                label: `${proc.proname}(${args}):`,
                kind: "function",
                description: "function",
                icon: "symbol-function",
                state: vscode.TreeItemCollapsibleState.Collapsed,
              });
            });
          return [...tables, ...views, ...types, ...functions];
        }
        const items = [];
        if (
          this.introspection.classes.find(
            (cls) => cls.relnamespace === parent.id && cls.relkind === "r",
          )
        ) {
          items.push(
            new Entity({
              id: `${parent.id}-tables`,
              kind: "tables",
              label: "tables",
              icon: "symbol-namespace",
              state: vscode.TreeItemCollapsibleState.Expanded,
            }),
          );
        }
        if (
          this.introspection.classes.find(
            (cls) => cls.relnamespace === parent.id && cls.relkind === "v",
          )
        ) {
          items.push(
            new Entity({
              id: `${parent.id}-views`,
              kind: "views",
              label: "views",
              icon: "symbol-namespace",
              state: vscode.TreeItemCollapsibleState.Expanded,
            }),
          );
        }
        if (
          this.introspection.procs.find(
            (proc) => proc.pronamespace === parent.id,
          )
        ) {
          items.push(
            new Entity({
              id: `${parent.id}-functions`,
              kind: "functions",
              label: "functions",
              icon: "symbol-function",
              state: vscode.TreeItemCollapsibleState.Expanded,
            }),
          );
        }
        if (
          this.introspection.types.find(
            (t) =>
              t.typnamespace === parent.id &&
              (t.typtype === "e" || t.typtype === "d"),
          ) ||
          this.introspection.classes.find(
            (cls) => cls.relkind === "c" && cls.relnamespace === parent.id,
          )
        ) {
          items.push(
            new Entity({
              id: `${parent.id}-types`,
              kind: "types",
              label: "types",
              icon: "symbol-namespace",
              state: vscode.TreeItemCollapsibleState.Expanded,
            }),
          );
        }
        return items;
      }
      case "tables": {
        const [id] = parent.id.split("-");
        return this.introspection.classes
          .filter((table) => table.relnamespace === id && table.relkind === "r")
          .map(
            (t) =>
              new Entity({
                id: t._id,
                label: t.relname,
                kind: "table",
                icon: "symbol-structure",
                state: vscode.TreeItemCollapsibleState.Collapsed,
              }),
          );
      }
      case "views": {
        const [id] = parent.id.split("-");
        return this.introspection.classes
          .filter((table) => table.relnamespace === id && table.relkind === "v")
          .map(
            (t) =>
              new Entity({
                id: t._id,
                label: t.relname,
                kind: "view",
                icon: "symbol-structure",
                state: vscode.TreeItemCollapsibleState.Collapsed,
              }),
          );
      }
      case "types": {
        const [id] = parent.id.split("-");
        const domains = this.introspection.types
          .filter((t) => t.typtype === "d" && t.typnamespace === id)
          .map(
            (t) =>
              new Entity({
                id: t._id,
                label: t.typname,
                kind: "label",
                // TODO: find how to get domain type name [text, int, etc]
                description: "domain",
                icon: "symbol-attribute",
                state: vscode.TreeItemCollapsibleState.None,
              }),
          );

        const enums = this.introspection.types
          .filter((t) => t.typtype === "e" && t.typnamespace === id)
          .map((t) => {
            const values = t.getEnumValues();
            if (!values)
              throw new Error(`could not find enum values for ${t.typname}`);
            return new Entity({
              id: t._id,
              label: t.typname,
              kind: "enum",
              description: "enum",
              icon: "symbol-attribute",
              state: vscode.TreeItemCollapsibleState.Collapsed,
              // values: values.map(x => x.enumlabel),
            });
          });

        const composites = this.introspection.classes
          .filter((cls) => cls.relkind === "c" && cls.relnamespace === id)
          .map(
            (t) =>
              new Entity({
                id: t._id,
                label: t.relname,
                kind: "composite",
                description: "composite",
                icon: "symbol-structure",
                state: vscode.TreeItemCollapsibleState.Collapsed,
                // values: t.getAttributes().map(a => {
                //   const type = a.getType();
                //   if (!type)
                //     throw new Error(
                //       `could not find type for composite attribute ${t.relname}`,
                //     );
                //   return { name: a.attname, type: type.typname };
                // }),
              }),
          );
        return [...domains, ...enums, ...composites];
      }
      case "functions": {
        const [id] = parent.id.split("-");
        return this.introspection.procs
          .filter((proc) => proc.pronamespace === id)
          .map((proc) => {
            const type = this.introspection!.getType({ id: proc?.prorettype });
            const returnType = proc.proretset
              ? "setof " + type?.typname
              : type?.typname;
            const args =
              proc.pronargs && proc.pronargs > 0 ? proc.pronargs : "";
            return new Entity({
              id: proc._id,
              label: `${proc.proname}(${args}):`,
              kind: "function",
              description: returnType,
              icon: "symbol-function",
              state: vscode.TreeItemCollapsibleState.Collapsed,
            });
          });
      }

      case "function": {
        const func = this.introspection.getProc({ id: parent.id });
        if (!func) return [];
        const attrs = [
          new Entity({
            id: `${parent.id}-vol`,
            label:
              {
                i: "immutable",
                s: "stable",
              }[func.provolatile as "i" | "s"] ?? "volatile",
            kind: "label",
            icon: "symbol-property",
            state: vscode.TreeItemCollapsibleState.None,
          }),
          ...(func.prosecdef
            ? [
                new Entity({
                  id: `${parent.id}-secdef`,
                  label: "security definer",
                  kind: "label",
                  icon: "symbol-property",
                  state: vscode.TreeItemCollapsibleState.None,
                }),
              ]
            : []),
          ...(func.pronargs && func.pronargs > 0
            ? [
                new Entity({
                  id: `${parent.id}-args`,
                  label: "arguments",
                  kind: "fnarguments",
                  icon: "symbol-property",
                  state: vscode.TreeItemCollapsibleState.Expanded,
                }),
              ]
            : []),
        ];
        return attrs;
      }

      case "fnreturns": {
        const id = parent.id.split("-")[0]!;
        const proc = this.introspection.getProc({ id });
        if (!proc) return [];
        const type = this.introspection.getType({ id: proc?.prorettype });
        if (!type) return [];
        return [
          new Entity({
            id: `${parent.id}-return-val`,
            label: type.typname,
            kind: "label",
            icon: "symbol-property",
            state: vscode.TreeItemCollapsibleState.None,
          }),
        ];
      }

      case "fnarguments": {
        const argId = parent.id.split("-")[0]!;
        const proc = this.introspection.getProc({ id: argId });
        const types = proc?.proargtypes ?? [];
        return (
          proc?.proargnames ??
          Array.from({ length: proc?.pronargs ?? 0 }, (_, i) => `arg${i + 1}`)
        ).map(
          (arg, i) =>
            new Entity({
              id: `${parent.id}-${arg}`,
              label: arg,
              description: this.introspection!.getType({ id: types[i]! })
                ?.typname,
              kind: "label",
              icon: "symbol-property",
              state: vscode.TreeItemCollapsibleState.None,
            }),
        );
      }

      case "enum": {
        const type = this.introspection.getType({ id: parent.id });
        return (
          type?.getEnumValues()?.map(
            (x) =>
              new Entity({
                id: x._id,
                label: x.enumlabel,
                kind: "enum_value",
                icon: "symbol-property",
                state: vscode.TreeItemCollapsibleState.None,
              }),
          ) ?? []
        );
      }

      case "composite":
      case "view":
      case "table": {
        const indexes = this.introspection.indexes.filter(
          (idx) => idx.indrelid === parent.id,
        );

        const primaryKey = indexes
          .find((idx) => idx.indisprimary)
          ?.getKeys()
          .map((k) => k!.attname);

        const columns = this.introspection.attributes.filter(
          (attr) => attr.attrelid === parent.id,
        );
        return [
          ...columns.map((c) => {
            return new Entity({
              id: `${c.attrelid}-${c.attnum}`,
              label: c.attname,
              description: [
                c.getType()?.typname,
                ...(primaryKey?.includes(c.attname)
                  ? ["primary key"]
                  : c.attnotnull
                    ? ["not null"]
                    : []),
              ].join(" "),
              kind: "column",
              icon: "symbol-property",
              state: vscode.TreeItemCollapsibleState.None,
            });
          }),
          ...indexes
            .filter((idx) => !idx.indisprimary)
            .map((idx) => {
              const cls = idx.getIndexClass()!;
              const am = cls.getAccessMethod()!;
              return new Entity({
                id: String(idx.indexrelid),
                label: cls.relname,
                description: [
                  ...(idx.indisunique ? ["unique"] : []),
                  am.amname,
                ].join(" "),
                kind: "index",
                icon: "symbol-property",
                state: vscode.TreeItemCollapsibleState.None,
              });
            }),
        ];
      }
      default:
        return [];
    }
  }
}

class Entity extends vscode.TreeItem {
  public readonly id: string;
  public readonly label: string;
  public readonly kind: string;
  public readonly description: string | undefined;
  declare iconPath: string;
  public readonly collapsibleState: vscode.TreeItemCollapsibleState;
  public parent?: Entity;

  constructor(props: {
    id: string;
    label: string;
    kind: string;
    description?: string;
    icon: string;
    state: vscode.TreeItemCollapsibleState;
  }) {
    super(props.label, props.state);
    this.id = props.id;
    this.label = props.label;
    this.kind = props.kind;
    this.description = props.description;
    // this.iconPath = props.icon;
    this.collapsibleState = props.state;
  }
}
