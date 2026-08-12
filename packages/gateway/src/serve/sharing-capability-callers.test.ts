import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

interface Capability {
  name: string;
  declaredIn: string;
}

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const vaultIndexPath = path.join(repository, "packages/vault/src/index.ts");
const peerLinkClientPath = path.join(
  repository,
  "packages/gateway/src/serve/peer-link-client.ts"
);

function sourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function exportedOperations(file: string): Capability[] {
  const source = sourceFile(file);
  const capabilities: Capability[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isFunctionDeclaration(statement) &&
      !ts.isClassDeclaration(statement)
    )
      continue;
    if (!statement.name) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (exported)
      capabilities.push({ name: statement.name.text, declaredIn: file });
  }
  return capabilities;
}

function vaultRootCapabilities(): Capability[] {
  const index = sourceFile(vaultIndexPath);
  const capabilities: Capability[] = [];
  for (const statement of index.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const moduleName = statement.moduleSpecifier;
    if (
      !moduleName ||
      !ts.isStringLiteral(moduleName) ||
      !moduleName.text.startsWith("./share/") ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    const target = path.join(
      path.dirname(vaultIndexPath),
      moduleName.text.replace(/\.js$/u, ".ts")
    );
    const operations = new Map(
      exportedOperations(target).map((capability) => [
        capability.name,
        capability,
      ])
    );
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const capability = operations.get(
        element.propertyName?.text ?? element.name.text
      );
      if (capability) capabilities.push(capability);
    }
  }
  return capabilities;
}

function productionSources(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", "dist", "coverage", "target"].includes(entry.name)
      )
        visit(file);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.includes(".test") &&
        !entry.name.includes("test-fixtures")
      )
        files.push(file);
    }
  };
  visit(root);
  return files;
}

function isDeclarationOnly(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isVariableDeclaration(parent)) &&
      parent.name === identifier)
  );
}

function actualCallers(
  capabilities: readonly Capability[]
): Map<string, string[]> {
  const names = new Set(capabilities.map((capability) => capability.name));
  const declarations = new Map(
    capabilities.map((capability) => [capability.name, capability.declaredIn])
  );
  const callers = new Map<string, Set<string>>();
  const roots = [
    path.join(repository, "apps"),
    path.join(repository, "packages"),
  ];
  for (const root of roots) {
    for (const file of productionSources(root)) {
      if (file === vaultIndexPath) continue;
      const source = sourceFile(file);
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          names.has(node.text) &&
          declarations.get(node.text) !== file &&
          !isDeclarationOnly(node)
        ) {
          const held = callers.get(node.text) ?? new Set<string>();
          held.add(path.relative(repository, file));
          callers.set(node.text, held);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return new Map(
    [...callers].map(([name, files]) => [name, [...files].toSorted()])
  );
}

describe("reachable sharing capabilities", () => {
  test("every exported sharing operation has an actual production caller", () => {
    const capabilities = [
      ...vaultRootCapabilities(),
      ...exportedOperations(peerLinkClientPath),
    ];
    const names = capabilities.map((capability) => capability.name);
    expect(new Set(names).size).toBe(names.length);
    const callers = actualCallers(capabilities);
    const unreachable = capabilities
      .filter((capability) => (callers.get(capability.name)?.length ?? 0) === 0)
      .map((capability) => capability.name);
    expect(unreachable).toStrictEqual([]);
    expect(callers.get("pushRouteAssertion")).toContain(
      "packages/gateway/src/cli/endpoint-host.ts"
    );
    expect(callers.get("recoverCommonsFromReplica")).toContain(
      "packages/gateway/src/routes/commons-recovery-routes.ts"
    );
    expect(callers.get("commonsCommandsFor")).toContain(
      "packages/gateway/src/routes/commons-routes.ts"
    );
  });
});
