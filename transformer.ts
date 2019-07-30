import * as ts from "typescript";

interface ArrayTypeChecker extends ts.TypeChecker {
  isArrayType(a: ts.Type): boolean;
  isArrayLikeType(a: ts.Type): boolean;
}

const predefined: { [interfaceName: string]: string } = {
  IDate: "date",
  IEmail: "email",
  IForbidden: "forbidden",
  IUrl: "url",
  IUUID: "uuid"
};

interface MaybeIntrinsicType {
  intrinsicName?: string;
}

interface LiteralType {
  value: string | number | ts.PseudoBigInt;
}

export default function transformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => (file: ts.SourceFile) => visitNodeAndChildren(file, program, context);
}

/**
 * TRANSFORMER LOGIC
 */

// tslint:disable-next-line:max-line-length
function visitNodeAndChildren(node: ts.SourceFile, program: ts.Program, context: ts.TransformationContext): ts.SourceFile;
function visitNodeAndChildren(node: ts.Node, program: ts.Program, context: ts.TransformationContext): ts.Node;

function visitNodeAndChildren(node: ts.Node, program: ts.Program, context: ts.TransformationContext): ts.Node {
  return ts.visitEachChild(visitNode(node, program), (childNode) =>
    visitNodeAndChildren(childNode, program, context), context);
}

function visitNode(node: ts.Node, program: ts.Program): ts.Node {
  const typeChecker = program.getTypeChecker();

  if (!isKeysCallExpression(node, typeChecker)) {
    return node;
  }
  if (!node.typeArguments) {
    return ts.createObjectLiteral();
  }

  let additional = true;
  const typeArg = typeChecker.getTypeAtLocation(node.arguments[0]);
  if (node.arguments[0] &&
    (typeArg as MaybeIntrinsicType).intrinsicName === "false") {
    additional = false;
  }

  const type = typeChecker.getTypeFromTypeNode(node.typeArguments[0]);
  return parseType(type, typeChecker, 0, [], additional);
}

function isKeysCallExpression(node: ts.Node, typeChecker: ts.TypeChecker): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) { return false; }

  const signature = typeChecker.getResolvedSignature(node);
  if (typeof signature === "undefined") { return false; }

  const { declaration } = signature;
  return !!declaration
    && !ts.isJSDocSignature(declaration)
    && !!declaration.name
    && declaration.name!.getText() === "schema";
}

/**
 * PARSING LOGIC
 */

function parseType(type: ts.Type, tc: ts.TypeChecker, depth: number, history?: string[],
  additional?: boolean, optional?: boolean): ts.ObjectLiteralExpression {

  const flags = type.flags;

  if (flags & ts.TypeFlags.StringLike ||
    flags & ts.TypeFlags.NumberLike ||
    flags & ts.TypeFlags.BooleanLike ||
    flags === ts.TypeFlags.Any) {
    return parsePrimitive(type, tc, ++depth);
  }

  if (flags === ts.TypeFlags.Null ||
    flags === ts.TypeFlags.Undefined) {
    return ts.createObjectLiteral();
  }

  if (flags === ts.TypeFlags.Object) {
    const objectType: ts.ObjectType = type as ts.ObjectType;
    const name = objectType.symbol.name;

    if (predefined[name]) {
      return ts.createObjectLiteral([
        ts.createPropertyAssignment("type", ts.createLiteral(predefined[name]))
      ]);
    }

    if ((tc as ArrayTypeChecker).isArrayType(objectType)) {
      return parseArray(objectType as ts.TypeReference, tc, ++depth);
    }

    if(tc.getIndexInfoOfType(type, ts.IndexKind.Number) || tc.getIndexInfoOfType(type, ts.IndexKind.String)){
      return ts.createObjectLiteral([
        ts.createPropertyAssignment("type", ts.createLiteral("object"))
      ]);
    }

    if (history && history.indexOf(name) !== -1) {
      return ts.createObjectLiteral([
        ts.createPropertyAssignment("type", ts.createLiteral("any"))
      ]);
    } else if (history && (name !== "__type" && name !== "Array")) {
      history.push(name);
    }

    return parseInterface(type, tc, ++depth, history, additional);
  }

  if (flags === ts.TypeFlags.Union) {
    return parseUnion(type, tc, ++depth, history, additional, optional);
  }

  if (flags === ts.TypeFlags.Intersection) {
    return parseIntersection(type, tc, ++depth, history);
  }

  if (flags & ts.TypeFlags.EnumLike) {
    return parseEnum(type, tc, ++depth);
  }

  throw new Error("Unknown type");
}

function parsePrimitive(type: ts.Type, tc: ts.TypeChecker, depth: number): ts.ObjectLiteralExpression {
  const type_string = tc.typeToString(type);
  return ts.createObjectLiteral([
    ts.createPropertyAssignment("type", ts.createLiteral(type_string))
  ]);
}

function parseEnum(type: ts.Type, tc: ts.TypeChecker, depth: number): ts.ObjectLiteralExpression {
  const enum_type = type as ts.UnionOrIntersectionType;
  const values = enum_type.types.map(enum_property => {
    return ts.createLiteral((enum_property as unknown as LiteralType).value);
  });

  return ts.createObjectLiteral([
    ts.createPropertyAssignment("type", ts.createLiteral("enum")),
    ts.createPropertyAssignment("values", ts.createArrayLiteral(values))
  ]);
}

function parseArray(type: ts.TypeReference, tc: ts.TypeChecker, depth: number, history?: string[]): ts.ObjectLiteralExpression {
  if (type.typeArguments) {
    return ts.createObjectLiteral([
      ts.createPropertyAssignment("type", ts.createLiteral("array")),
      ts.createPropertyAssignment("items", parseType(type.typeArguments[0], tc, depth, history))
    ]);
  }
  return ts.createObjectLiteral([
    ts.createPropertyAssignment("type", ts.createLiteral("array"))
  ]);
}

function parseUnion(type: ts.Type, tc: ts.TypeChecker, depth: number, history?: string[],
  additional?: boolean, optional?: boolean): ts.ObjectLiteralExpression {
  const union_type = type as ts.UnionOrIntersectionType;

  let firstBoolean = true;
  const types = union_type.types.filter(union_property => {
    if (union_property.flags & ts.TypeFlags.BooleanLiteral) {
      if (firstBoolean) {
        firstBoolean = false;
        return true;
      } else {
        return false;
      }
    }

    if (tc.typeToString(union_property) !== 'undefined') {
      return true;
    } else {
      return false;
    }
  });

  if (types.length === 1) {
    const union_property = types[0];
    if (union_property.flags & ts.TypeFlags.BooleanLiteral) {
      return ts.createObjectLiteral([
        ts.createPropertyAssignment("type", ts.createLiteral("boolean"))
      ]);
    }

    return parseType(union_property, tc, depth, history, additional);
  }

  /**
   * If all types of union are literals, make an enum
   */
  let literals = types.length? true: false;
  for (let union_property of types) {
    if (!(union_property.flags & ts.TypeFlags.Literal)) {
      literals = false;
    }
  }
  if (literals) {
    const values = types.map(union_property => {
      if (union_property.flags & ts.TypeFlags.BooleanLiteral) {
        if(tc.typeToString(union_property) == 'false'){
          return ts.createLiteral(false);
        }else{
          return ts.createLiteral(true);
        }
      }
      return ts.createLiteral((union_property as unknown as LiteralType).value);
    });
    return ts.createObjectLiteral([
      ts.createPropertyAssignment("type", ts.createLiteral("enum")),
      ts.createPropertyAssignment("values", ts.createArrayLiteral(values))
    ]);
  }

  const mapped_types = types.map(union_property => {
    if (union_property.flags & ts.TypeFlags.BooleanLiteral) {
      return ts.createObjectLiteral([
        ts.createPropertyAssignment("type", ts.createLiteral("boolean"))
      ]);
    }

    return parseType(union_property, tc, depth, history, additional);
  });

  if (optional) {
    mapped_types.push(ts.createObjectLiteral([
      ts.createPropertyAssignment("type", ts.createLiteral("forbidden"))
    ]))
  }

  return ts.createArrayLiteral(mapped_types) as unknown as ts.ObjectLiteralExpression;
}

function parseIntersection(type: ts.Type, tc: ts.TypeChecker, depth: number, history?: string[],
  additional?: boolean): ts.ObjectLiteralExpression {
  const intersection_type = type as ts.UnionOrIntersectionType;
  const types = intersection_type.types.map(intersection_property => {
    return parseType(intersection_property, tc, depth, history, additional);
  });

  const combined_properties: ts.ObjectLiteralElementLike[] = [];
  types.forEach(type => {
    type.properties.forEach(property => {
      if (property.name) {
        const indentifier = property.name as ts.Identifier;
        if (indentifier.escapedText === "props") {
          const assignment = property as ts.PropertyAssignment;
          const props = assignment.initializer as unknown as ts.ObjectLiteralExpressionBase<ts.PropertyAssignment>;
          props.properties.forEach(prop => {
            combined_properties.push(prop)
          });
        }
      }
    });
  });


  let properties_assignments = [];
  if (depth > 1) {
    properties_assignments.push(ts.createPropertyAssignment("type", ts.createLiteral("object")));
    properties_assignments.push(ts.createPropertyAssignment("props", ts.createObjectLiteral(combined_properties)));
  } else {
    properties_assignments = combined_properties
  }

  return ts.createObjectLiteral(properties_assignments);
}

function parseInterface(type: ts.Type, tc: ts.TypeChecker, depth: number, history?: string[],
  additional?: boolean): ts.ObjectLiteralExpression {
  const properties = tc.getPropertiesOfType(type).filter((property) => property.declarations!.length);

  const properties_assignments = properties.map(property => {
    const declaration: ts.ParameterDeclaration = property.declarations[0] as ts.ParameterDeclaration;

    const optional = declaration.questionToken ? true : false;
    let parsed = parseType(tc.getTypeOfSymbolAtLocation(property, property.declarations![0]), tc, depth, history, additional, optional);

    if (optional && parsed.properties) {
      parsed = addProperty(parsed, "optional", true);
    }

    const docs = property.getJsDocTags();
    if (additional && docs.length && parsed.properties) {
      parsed = addProperties(parsed, parseJSDoc(docs));
    }

    return ts.createPropertyAssignment(property.name, parsed);
  })

  if (properties_assignments.length === 0) {
    return ts.createObjectLiteral();
  }

  let neasted_properties_assignments = [];

  if (depth > 1) {
    neasted_properties_assignments.push(ts.createPropertyAssignment("type", ts.createLiteral("object")));
    neasted_properties_assignments.push(ts.createPropertyAssignment("props", ts.createObjectLiteral(properties_assignments)));
  } else {
    neasted_properties_assignments = properties_assignments
  }

  const docs = type.symbol.getJsDocTags();
  if (additional && docs.length) {
    parseJSDoc(docs).forEach(property => {
      neasted_properties_assignments.push(property);
    });
  }

  return ts.createObjectLiteral(neasted_properties_assignments);

}



/**
 * HELPER FUNCTIONS
 */
function combineObjects(o1: ts.ObjectLiteralExpression, o2: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression {
  const combined_properties: ts.ObjectLiteralElementLike[] = [];

  o1.properties.forEach(property => combined_properties.push(property));
  o2.properties.forEach(property => combined_properties.push(property));

  return ts.createObjectLiteral(combined_properties);
}

function addProperties(object: ts.ObjectLiteralExpression, combined_properties: ts.ObjectLiteralElementLike[]): ts.ObjectLiteralExpression {
  object.properties.forEach(property => combined_properties.push(property));
  return ts.createObjectLiteral(combined_properties);
}

function addProperty(object: ts.ObjectLiteralExpression, name: string, value: any): ts.ObjectLiteralExpression {
  const combined_properties: ts.ObjectLiteralElementLike[] = [];

  object.properties.forEach(property => combined_properties.push(property));
  combined_properties.push(ts.createPropertyAssignment(name, ts.createLiteral(value)));

  return ts.createObjectLiteral(combined_properties);
}

function parseJSDoc(docs: ts.JSDocTagInfo[]): ts.PropertyAssignment[] {
  return docs.filter(doc => doc.text).map(doc => {
    let value: any = doc.text;
    if (value === "true") {
      value = true;
    }

    if (value === "false") {
      value = false;
    }

    if (/^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$/.test(value)) {
      value = Number(value);
    }

    return ts.createPropertyAssignment(doc.name, ts.createLiteral(value))
  });
}
