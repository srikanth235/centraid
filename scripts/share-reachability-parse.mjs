#!/usr/bin/env node
/**
 * Syntax-level module scanner for the sharing-plane reachability check (#750).
 *
 * Split out of `check-share-reachability.mjs` so neither file exceeds the
 * repo-hygiene line ceiling: this module owns the TypeScript AST walk that
 * turns one source file into an import/export/usage record, and the analyzer
 * next door owns the graph resolution that consumes those records. It parses
 * with the repo-pinned TypeScript compiler at syntax level only — no type
 * checking, no program construction, no new dependencies.
 */

import ts from "typescript";

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/** Syntax-level extraction of one module's imports, exports, and identifier usage. */
export function parseModule(absPath, text) {
  const sourceFile = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.ES2022,
    false,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const info = {
    imports: [], // { spec, names: [{ imported, local, typeOnly }] }
    namespaceImports: [], // { spec, local, typeOnly }
    dynamicImportSpecs: [],
    reexports: [], // { spec, star, names: [{ imported, exported, typeOnly }], typeOnly }
    exportList: [], // { local, exported, typeOnly } — `export { a as b }` with no specifier
    localExports: new Map(), // exported name → "value" | "type"
    // The identifier a `default` export is declared under, when it has one
    // (`export default function ShareSheet`, `export default ShareSheet`).
    // `default` is not a usable identifier, so the analyzer's same-file rule
    // has to look the declaration up under this name instead. Anonymous
    // defaults (`export default () => …`) leave it undefined, which is
    // correct: nothing in the file can reference them.
    defaultLocal: undefined,
    declKinds: new Map(), // top-level declaration name → "value" | "type"
    valueUse: new Map(), // identifier → count of value-position uses
    typeUse: new Map(), // identifier → count of type-position uses
    nsValueUse: new Map(), // namespace local → Map(member → count)
    nsTypeUse: new Map(),
  };

  const hasExportModifier = (stmt) =>
    stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ===
    true;

  const hasDefaultModifier = (stmt) =>
    stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ===
    true;

  const bindingNames = (name, out) => {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (
      ts.isObjectBindingPattern(name) ||
      ts.isArrayBindingPattern(name)
    ) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) bindingNames(el.name, out);
      }
    }
    return out;
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) continue; // side-effect import: no bindings, no reach
      const clauseTypeOnly = clause.isTypeOnly === true;
      // `import ShareSheet from "./ShareSheet"` binds the target's `default`
      // export. Skipping this clause is what made every default-exported
      // component look unreached no matter how many screens mounted it.
      if (clause.name) {
        info.imports.push({
          spec,
          names: [
            {
              imported: "default",
              local: clause.name.text,
              typeOnly: clauseTypeOnly,
            },
          ],
        });
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          info.namespaceImports.push({
            spec,
            local: clause.namedBindings.name.text,
            typeOnly: clauseTypeOnly,
          });
        } else {
          const names = clause.namedBindings.elements.map((el) => ({
            imported: (el.propertyName ?? el.name).text,
            local: el.name.text,
            typeOnly: clauseTypeOnly || el.isTypeOnly === true,
          }));
          info.imports.push({ spec, names });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      const stmtTypeOnly = stmt.isTypeOnly === true;
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const spec = stmt.moduleSpecifier.text;
        if (!stmt.exportClause) {
          info.reexports.push({
            spec,
            star: true,
            names: [],
            typeOnly: stmtTypeOnly,
          });
        } else if (ts.isNamedExports(stmt.exportClause)) {
          info.reexports.push({
            spec,
            star: false,
            typeOnly: stmtTypeOnly,
            names: stmt.exportClause.elements.map((el) => ({
              imported: (el.propertyName ?? el.name).text,
              exported: el.name.text,
              typeOnly: stmtTypeOnly || el.isTypeOnly === true,
            })),
          });
        }
        // `export * as ns from` (NamespaceExport) is not used in this repo's
        // sharing plane; a consumer of it would not be resolved.
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          info.exportList.push({
            local: (el.propertyName ?? el.name).text,
            exported: el.name.text,
            typeOnly: stmtTypeOnly || el.isTypeOnly === true,
          });
        }
      }
      continue;
    }

    // `export default <expression>`. `export = x` (isExportEquals) is CommonJS
    // interop and has no import form in this repo, so it is not a capability.
    if (ts.isExportAssignment(stmt)) {
      if (stmt.isExportEquals !== true) {
        info.localExports.set("default", "value");
        if (ts.isIdentifier(stmt.expression))
          info.defaultLocal = stmt.expression.text;
      }
      continue;
    }

    const exported = hasExportModifier(stmt);
    const isDefault = exported && hasDefaultModifier(stmt);
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      info.declKinds.set(stmt.name.text, "type");
      if (exported) info.localExports.set(stmt.name.text, "type");
    } else if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      // `export default function ShareSheet` is exported as `default`, never
      // as `ShareSheet` — importers cannot name it, so neither may the graph.
      if (isDefault) {
        info.localExports.set("default", "value");
        if (stmt.name) info.defaultLocal = stmt.name.text;
      }
      if (stmt.name) {
        info.declKinds.set(stmt.name.text, "value");
        if (exported && !isDefault)
          info.localExports.set(stmt.name.text, "value");
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        for (const name of bindingNames(decl.name, [])) {
          info.declKinds.set(name, "value");
          if (exported) info.localExports.set(name, "value");
        }
      }
    } else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      info.declKinds.set(stmt.name.text, "value");
      if (exported) info.localExports.set(stmt.name.text, "value");
    }
  }

  // The *name* node of a top-level declaration is not a use of that
  // declaration — without this set, `export const X = 1` would record a
  // `valueUse` for `X` and every export would look self-reached. Binding
  // patterns contribute their bound identifiers only; initializers and
  // computed keys still walk normally. Imported locals are unaffected because
  // the walk returns early on import declarations.
  const declaredNameNodes = new Set();
  const collectNameNodes = (name) => {
    if (ts.isIdentifier(name)) declaredNameNodes.add(name);
    else if (
      ts.isObjectBindingPattern(name) ||
      ts.isArrayBindingPattern(name)
    ) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) collectNameNodes(el.name);
      }
    }
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectNameNodes(decl.name);
      }
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      stmt.name &&
      ts.isIdentifier(stmt.name)
    ) {
      declaredNameNodes.add(stmt.name);
    }
  }

  // Usage walk: count value-position vs type-position identifier uses, plus
  // `ns.member` accesses, skipping import/export statements and member-name
  // positions so `foo.bar` never counts as a use of a local `bar`.
  const recordUse = (name, inType) => {
    bump(inType ? info.typeUse : info.valueUse, name);
  };
  const recordNsUse = (nsName, member, inType) => {
    const target = inType ? info.nsTypeUse : info.nsValueUse;
    if (!target.has(nsName)) target.set(nsName, new Map());
    bump(target.get(nsName), member);
  };

  const visit = (node, inTypeBefore) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    // `export default ShareSheet` names the declaration the way
    // `export { ShareSheet as default }` does — a re-export site, not a call.
    // Counting it would rescue every default export under the same-file rule,
    // which is the same defect `declaredNameNodes` exists to prevent.
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) return;
    if (declaredNameNodes.has(node)) return;
    const inType =
      inTypeBefore ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isTypeNode(node);
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        recordNsUse(node.expression.text, node.name.text, inType);
        recordUse(node.expression.text, inType);
      } else {
        visit(node.expression, inType);
      }
      return; // never count the member name as a bare identifier use
    }
    if (ts.isQualifiedName(node)) {
      if (ts.isIdentifier(node.left)) {
        recordNsUse(node.left.text, node.right.text, true);
        recordUse(node.left.text, true);
      } else {
        visit(node.left, true);
      }
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name, inType);
      visit(node.initializer, inType);
      return;
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertySignature(node) ||
        ts.isEnumMember(node)) &&
      ts.isIdentifier(node.name)
    ) {
      ts.forEachChild(node, (child) => {
        if (child !== node.name) visit(child, inType);
      });
      return;
    }
    if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName)
    ) {
      ts.forEachChild(node, (child) => {
        if (child !== node.propertyName) visit(child, inType);
      });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg))
        info.dynamicImportSpecs.push(arg.text);
    }
    if (ts.isIdentifier(node)) {
      recordUse(node.text, inType);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inType));
  };
  for (const stmt of sourceFile.statements) visit(stmt, false);

  return info;
}
