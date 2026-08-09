import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const sourceRoot = path.join(packageRoot, "src");
const webRoot = path.join(workspaceRoot, "apps/web");

const adapterPublicSpecifiers = new Set([
  "@drawstuff/excalidraw-adapter/client",
  "@drawstuff/excalidraw-adapter/codec",
  "@drawstuff/excalidraw-adapter/library",
  "@drawstuff/excalidraw-adapter/reconcile",
  "@drawstuff/excalidraw-adapter/types",
]);

type ModuleReference = {
  isTypeOnly: boolean;
  specifier: string;
};

const listTypeScriptFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name !== "node_modules" &&
          entry.name !== ".next" &&
          !entry.name.startsWith(".turbo"),
      )
      .map(async (entry) => {
        const entryPath = path.join(root, entry.name);

        if (entry.isDirectory()) {
          return listTypeScriptFiles(entryPath);
        }

        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [entryPath] : [];
      }),
  );

  return files.flat();
};

const getModuleReferences = async (
  filePath: string,
): Promise<ModuleReference[]> => {
  const sourceText = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const references: ModuleReference[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let isTypeOnly = false;
      if (ts.isImportDeclaration(node)) {
        const { importClause } = node;
        if (importClause?.isTypeOnly) {
          isTypeOnly = true;
        } else if (
          !importClause?.name &&
          importClause?.namedBindings &&
          ts.isNamedImports(importClause.namedBindings)
        ) {
          isTypeOnly = importClause.namedBindings.elements.every(
            (element) => element.isTypeOnly,
          );
        }
      } else if (node.isTypeOnly) {
        isTypeOnly = true;
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        isTypeOnly = node.exportClause.elements.every(
          (element) => element.isTypeOnly,
        );
      }

      references.push({
        isTypeOnly,
        specifier: node.moduleSpecifier.text,
      });
      return;
    }

    if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      if (
        argument &&
        node.arguments.length === 1 &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        ts.isStringLiteral(argument)
      ) {
        references.push({
          isTypeOnly: false,
          specifier: argument.text,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return references;
};

const resolveLocalModule = (
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | undefined => {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const unresolvedPath = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    unresolvedPath,
    `${unresolvedPath}.ts`,
    `${unresolvedPath}.tsx`,
    path.join(unresolvedPath, "index.ts"),
    path.join(unresolvedPath, "index.tsx"),
  ];

  return candidates.find((candidate) => sourceFiles.has(candidate));
};

const resolveWebModule = (
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | undefined => {
  if (specifier.startsWith(".")) {
    return resolveLocalModule(importer, specifier, sourceFiles);
  }
  if (!specifier.startsWith("@/")) {
    return undefined;
  }

  const unresolvedPath = path.join(webRoot, "src", specifier.slice(2));
  const candidates = [
    unresolvedPath,
    `${unresolvedPath}.ts`,
    `${unresolvedPath}.tsx`,
    path.join(unresolvedPath, "index.ts"),
    path.join(unresolvedPath, "index.tsx"),
  ];

  return candidates.find((candidate) => sourceFiles.has(candidate));
};

const findCycle = (
  graph: ReadonlyMap<string, readonly string[]>,
): string[] | undefined => {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): string[] | undefined => {
    if (active.has(node)) {
      return [...stack.slice(stack.indexOf(node)), node];
    }
    if (visited.has(node)) {
      return undefined;
    }

    visited.add(node);
    active.add(node);
    stack.push(node);

    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    active.delete(node);
    return undefined;
  };

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) {
      return cycle;
    }
  }

  return undefined;
};

describe("adapter import boundaries", () => {
  it("does not add app-level imports of the upstream engine", async () => {
    const webFiles = await listTypeScriptFiles(webRoot);
    const filesWithUpstreamImports: string[] = [];
    const boundaryViolations: string[] = [];

    for (const filePath of webFiles) {
      const references = await getModuleReferences(filePath);
      const upstreamReferences = references.filter(
        ({ specifier }) =>
          specifier === "@excalidraw/excalidraw" ||
          specifier.startsWith("@excalidraw/excalidraw/"),
      );

      if (upstreamReferences.length > 0) {
        filesWithUpstreamImports.push(path.relative(webRoot, filePath));
      }

      for (const { specifier } of references) {
        if (
          (specifier.startsWith("@drawstuff/excalidraw-adapter") &&
            !adapterPublicSpecifiers.has(specifier)) ||
          specifier.includes("packages/excalidraw-adapter/")
        ) {
          boundaryViolations.push(
            `${path.relative(webRoot, filePath)} -> ${specifier}`,
          );
        }
      }
    }

    expect(filesWithUpstreamImports).toEqual([]);
    expect(boundaryViolations).toEqual([]);
  });

  it("has no reverse workspace dependency or source cycle", async () => {
    const sourceFiles = await listTypeScriptFiles(sourceRoot);
    const sourceFileSet = new Set(sourceFiles);
    const graph = new Map<string, string[]>();
    const forbiddenImports: string[] = [];

    for (const filePath of sourceFiles) {
      const references = await getModuleReferences(filePath);
      const localDependencies: string[] = [];

      for (const { specifier } of references) {
        if (
          specifier === "@drawstuff/web" ||
          specifier.startsWith("@drawstuff/web/") ||
          specifier === "@drawstuff/collaboration" ||
          specifier.startsWith("@drawstuff/collaboration/") ||
          specifier.includes("/apps/web/")
        ) {
          forbiddenImports.push(
            `${path.relative(packageRoot, filePath)} -> ${specifier}`,
          );
        }

        const localDependency = resolveLocalModule(
          filePath,
          specifier,
          sourceFileSet,
        );
        if (localDependency) {
          localDependencies.push(localDependency);
        }
      }

      graph.set(filePath, localDependencies);
    }

    expect(forbiddenImports).toEqual([]);
    expect(findCycle(graph)).toBeUndefined();
  });

  it("keeps the app server graph away from the client editor runtime", async () => {
    const webFiles = await listTypeScriptFiles(path.join(webRoot, "src"));
    const webFileSet = new Set(webFiles);
    const referencesByFile = new Map<string, ModuleReference[]>();

    await Promise.all(
      webFiles.map(async (filePath) => {
        referencesByFile.set(filePath, await getModuleReferences(filePath));
      }),
    );

    const pending = webFiles.filter((filePath) => {
      const relativePath = path.relative(webRoot, filePath);
      const references = referencesByFile.get(filePath) ?? [];
      return (
        relativePath.startsWith(`src${path.sep}server${path.sep}`) ||
        relativePath.startsWith(`src${path.sep}app${path.sep}api${path.sep}`) ||
        references.some(({ specifier }) => specifier === "server-only")
      );
    });
    const visited = new Set<string>();
    const violations: string[] = [];

    while (pending.length > 0) {
      const filePath = pending.pop();
      if (!filePath || visited.has(filePath)) {
        continue;
      }
      visited.add(filePath);

      for (const { isTypeOnly, specifier } of referencesByFile.get(filePath) ??
        []) {
        if (isTypeOnly) {
          continue;
        }
        if (
          specifier === "@drawstuff/excalidraw-adapter/client" ||
          specifier === "@excalidraw/excalidraw" ||
          specifier.startsWith("@excalidraw/excalidraw/")
        ) {
          violations.push(
            `${path.relative(webRoot, filePath)} -> ${specifier}`,
          );
        }

        const dependency = resolveWebModule(filePath, specifier, webFileSet);
        if (dependency && !visited.has(dependency)) {
          pending.push(dependency);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps server-safe entries free of client, DOM, CSS, and runtime engine imports", async () => {
    const sourceFiles = await listTypeScriptFiles(sourceRoot);
    const sourceFileSet = new Set(sourceFiles);
    const pending = ["types.ts", "codec.ts"].map((fileName) =>
      path.join(sourceRoot, fileName),
    );
    const visited = new Set<string>();
    const unsafeReferences: string[] = [];

    while (pending.length > 0) {
      const filePath = pending.pop();
      if (!filePath || visited.has(filePath)) {
        continue;
      }
      visited.add(filePath);

      const references = await getModuleReferences(filePath);
      for (const { isTypeOnly, specifier } of references) {
        const localDependency = resolveLocalModule(
          filePath,
          specifier,
          sourceFileSet,
        );

        if (
          !isTypeOnly &&
          ((!specifier.startsWith(".") && !isBuiltin(specifier)) ||
            specifier.endsWith(".css") ||
            localDependency === path.join(sourceRoot, "client.ts") ||
            localDependency?.startsWith(
              `${path.join(sourceRoot, "client")}${path.sep}`,
            ))
        ) {
          unsafeReferences.push(
            `${path.relative(packageRoot, filePath)} -> ${specifier}`,
          );
        }

        if (!isTypeOnly) {
          if (localDependency) {
            pending.push(localDependency);
          }
        }
      }
    }

    expect(unsafeReferences).toEqual([]);
  });

  it("keeps the workspace package dependency graph acyclic", async () => {
    const workspaceContainers = ["apps", "packages"];
    const workspacePackageRoots = (
      await Promise.all(
        workspaceContainers.map(async (container) => {
          const containerRoot = path.join(workspaceRoot, container);
          const entries = await readdir(containerRoot, { withFileTypes: true });

          return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(containerRoot, entry.name));
        }),
      )
    ).flat();
    const manifests = (
      await Promise.all(
        workspacePackageRoots.map(async (root) => {
          let manifestSource: string;
          try {
            manifestSource = await readFile(
              path.join(root, "package.json"),
              "utf8",
            );
          } catch (error) {
            if (
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return undefined;
            }
            throw error;
          }

          const manifest = JSON.parse(manifestSource) as {
            dependencies?: Record<string, string>;
            name: string;
          };

          return [manifest.name, manifest.dependencies ?? {}] as const;
        }),
      )
    ).filter((manifest) => manifest !== undefined);
    const workspacePackageNames = new Set(
      manifests.map(([packageName]) => packageName),
    );
    const graph = new Map(
      manifests.map(([packageName, dependencies]) => [
        packageName,
        Object.keys(dependencies).filter((dependency) =>
          workspacePackageNames.has(dependency),
        ),
      ]),
    );

    expect(graph.get("@drawstuff/web")).toContain(
      "@drawstuff/excalidraw-adapter",
    );
    expect(graph.get("@drawstuff/excalidraw-adapter")).toEqual([]);
    expect(findCycle(graph)).toBeUndefined();
  });

  it("keeps the upstream engine dependency owned by the adapter", async () => {
    const webManifest = JSON.parse(
      await readFile(path.join(webRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const adapterManifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(webManifest.dependencies).not.toHaveProperty(
      "@excalidraw/excalidraw",
    );
    expect(adapterManifest.dependencies).toHaveProperty(
      "@excalidraw/excalidraw",
      "^0.18.1",
    );
  });
});
