// Rewrites one REPL cell so top-level bindings outlive the call.
//
// A cell runs as `var <names>; <functions>; (async () => { <body> })()` inside a
// persistent vm context. Top-level `const`/`let`/`class` become assignments to
// context-level `var`s, so they persist and can be redeclared by a later cell.
// The last expression statement becomes the cell's return value.
import * as acorn from "acorn";

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  sourceType: "script",
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
  locations: true,
};

function patternNames(node, out) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier":
      out.push(node.name);
      break;
    case "ObjectPattern":
      for (const prop of node.properties) {
        patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const element of node.elements) patternNames(element, out);
      break;
    case "RestElement":
      patternNames(node.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(node.left, out);
      break;
  }
  return out;
}

function importToAssignments(node, src) {
  const source = src.slice(node.source.start, node.source.end);
  const names = [];
  const parts = [];
  const tmp = `__gb_import_${node.start}`;
  parts.push(`const ${tmp} = await import(${source});`);
  for (const spec of node.specifiers) {
    names.push(spec.local.name);
    if (spec.type === "ImportDefaultSpecifier") {
      parts.push(`${spec.local.name} = ${tmp}.default;`);
    } else if (spec.type === "ImportNamespaceSpecifier") {
      parts.push(`${spec.local.name} = ${tmp};`);
    } else {
      const imported =
        spec.imported.type === "Literal" ? JSON.stringify(spec.imported.value) : JSON.stringify(spec.imported.name);
      parts.push(`${spec.local.name} = ${tmp}[${imported}];`);
    }
  }
  return { names, code: parts.join(" ") };
}

export class CellSyntaxError extends Error {
  constructor(error) {
    const loc = error.loc ? ` (line ${error.loc.line}, column ${error.loc.column + 1})` : "";
    super(`SyntaxError: ${error.message.replace(/\s*\(\d+:\d+\)$/, "")}${loc}`);
    this.name = "SyntaxError";
  }
}

export function transformCell(src) {
  let ast;
  try {
    ast = acorn.parse(src, PARSE_OPTIONS);
  } catch (error) {
    throw new CellSyntaxError(error);
  }

  const hoisted = new Set();
  const prelude = [];
  const edits = []; // [start, end, replacement], non-overlapping, top-level only

  for (const node of ast.body) {
    if (node.type === "VariableDeclaration") {
      const assigns = [];
      for (const decl of node.declarations) {
        for (const name of patternNames(decl.id, [])) hoisted.add(name);
        if (decl.init) {
          const left = src.slice(decl.id.start, decl.id.end);
          const right = src.slice(decl.init.start, decl.init.end);
          assigns.push(`(${left} = ${right})`);
        } else if (node.kind !== "var") {
          assigns.push(`(${src.slice(decl.id.start, decl.id.end)} = undefined)`);
        }
      }
      edits.push([node.start, node.end, assigns.length ? `${assigns.join(", ")};` : ";"]);
    } else if (node.type === "FunctionDeclaration") {
      // Functions see only context-level bindings, so they can live outside the IIFE.
      prelude.push(src.slice(node.start, node.end));
      edits.push([node.start, node.end, ""]);
    } else if (node.type === "ClassDeclaration") {
      hoisted.add(node.id.name);
      edits.push([node.start, node.end, `${node.id.name} = ${src.slice(node.start, node.end)};`]);
    } else if (node.type === "ImportDeclaration") {
      const { names, code } = importToAssignments(node, src);
      for (const name of names) hoisted.add(name);
      edits.push([node.start, node.end, code]);
    } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      throw new CellSyntaxError({ message: "export is not supported in a cell", loc: node.loc.start });
    }
  }

  const last = ast.body.at(-1);
  if (last && last.type === "ExpressionStatement") {
    const expr = src.slice(last.expression.start, last.expression.end);
    edits.push([last.start, last.end, `return (${expr});`]);
  }

  edits.sort((a, b) => a[0] - b[0]);
  let body = "";
  let cursor = 0;
  for (const [start, end, replacement] of edits) {
    body += src.slice(cursor, start) + replacement;
    cursor = end;
  }
  body += src.slice(cursor);

  const decl = hoisted.size ? `var ${[...hoisted].join(", ")};\n` : "";
  // Keep the user's code on its own lines so stack line numbers stay close.
  return `${decl}${prelude.join("\n")}\n(async () => {\n${body}\n})()`;
}
