import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

function unwrapType(type: ESTree.TSType): ESTree.TSType {
  return type.type === "TSParenthesizedType" ? unwrapType(type.typeAnnotation) : type;
}

function isTopType(type: ESTree.TSType | null | undefined): boolean {
  if (type === null || type === undefined) return false;
  const unwrapped = unwrapType(type);
  return unwrapped.type === "TSUnknownKeyword" || unwrapped.type === "TSAnyKeyword";
}

function isUnparsedValue(node: ESTree.IdentifierReference): boolean {
  let current: ESTree.Node | null = node;
  while (current !== null) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      const parameter = current.params.find(
        (candidate) => candidate.type === "Identifier" && candidate.name === node.name,
      );
      return (
        parameter?.type === "Identifier" && isTopType(parameter.typeAnnotation?.typeAnnotation)
      );
    }
    if (
      current.type === "VariableDeclarator" &&
      current.id.type === "Identifier" &&
      current.id.name === node.name
    )
      return isTopType(current.id.typeAnnotation?.typeAnnotation);
    current = current.parent;
  }
  return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
    },
    messages: {
      runtimeTypeof:
        "A runtime `typeof` check only narrows an unparsed representation; it does not establish the expected contract. Parse the value into a strongly typed domain type at the earliest possible point, as close as possible to the I/O boundary where the data originated.",
    },
  },
  create(context) {
    return {
      UnaryExpression(node) {
        if (
          node.operator === "typeof" &&
          node.argument.type === "Identifier" &&
          isUnparsedValue(node.argument)
        ) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
