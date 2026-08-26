import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

function isTypePositionParameter(parameter: Parameter): boolean {
  let current: ESTree.Node | null = parameter.parent;
  while (current !== null) {
    if (
      current.type === "TSAsExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeLiteral"
    )
      return true;
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression" ||
      current.type === "Program"
    )
      return false;
    current = current.parent;
  }
  return false;
}

function isSchemaDecodeCall(node: ESTree.CallExpression): boolean {
  let current: ESTree.Expression = node.callee;
  while (current.type === "CallExpression") current = current.callee;
  return (
    current.type === "MemberExpression" &&
    !current.computed &&
    current.object.type === "Identifier" &&
    (current.object.name === "Schema" || current.object.name === "S") &&
    current.property.type === "Identifier" &&
    /^decodeUnknown(?:Sync|Effect)?$/u.test(current.property.name)
  );
}

function hasSchemaDecodeBoundary(
  node: ESTree.Node | null | undefined,
  parameterName: string,
): boolean {
  if (node === null || node === undefined) return false;
  if (
    node.type === "CallExpression" &&
    isSchemaDecodeCall(node) &&
    node.arguments.some(
      (argument) => argument.type === "Identifier" && argument.name === parameterName,
    )
  )
    return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range" || key === "tokens") continue;
    if (Array.isArray(value)) {
      if (
        value.some(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            hasSchemaDecodeBoundary(item as ESTree.Node, parameterName),
        )
      )
        return true;
    } else if (
      value !== null &&
      typeof value === "object" &&
      hasSchemaDecodeBoundary(value as ESTree.Node, parameterName)
    ) {
      return true;
    }
  }
  return false;
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` accepts `unknown` without establishing its contract. Define the expected schema or parser so the value becomes a strongly typed domain type at the earliest possible point, as close as possible to the I/O boundary where the data originated.",
    },
  },
  create(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const name = parameterName(parameter, context.sourceCode.getText(parameter));
        if (name === "cause") continue;
        if (isTypePositionParameter(parameter)) continue;
        if ("body" in node && hasSchemaDecodeBoundary(node.body as ESTree.Node | null, name))
          continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
