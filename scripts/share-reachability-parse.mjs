#!/usr/bin/env node

import ts from "typescript";

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

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
