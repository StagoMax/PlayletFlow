import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(webRoot, "../docs/openapi.json");
const outputPath = resolve(webRoot, "src/productApi/generated.ts");

const source = await readFile(sourcePath, "utf8");
const document = JSON.parse(source);
validateDocument(document);
const generated = renderDocument(document, source);

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => null);
  if (current !== generated) {
    console.error(
      "Product API contract is stale. Run `pnpm contract:generate` in web/ and commit the result.",
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  console.log(`Generated ${outputPath}`);
}

function validateDocument(value) {
  if (!value || typeof value !== "object" || !String(value.openapi ?? "").startsWith("3.1.")) {
    throw new Error("docs/openapi.json must be an OpenAPI 3.1 document");
  }
  if (!value.info?.title || !value.info?.version) {
    throw new Error("OpenAPI info.title and info.version are required");
  }
  if (!value.paths || !value.components?.schemas) {
    throw new Error("OpenAPI paths and components.schemas are required");
  }

  const operationIds = new Set();
  for (const [path, pathItem] of Object.entries(value.paths)) {
    if (!path.startsWith("/")) throw new Error(`OpenAPI path must start with /: ${path}`);
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      if (!operation.operationId) throw new Error(`${method.toUpperCase()} ${path} lacks operationId`);
      if (!operation.responses || Object.keys(operation.responses).length === 0) {
        throw new Error(`${method.toUpperCase()} ${path} lacks responses`);
      }
      if (operationIds.has(operation.operationId)) {
        throw new Error(`Duplicate operationId: ${operation.operationId}`);
      }
      operationIds.add(operation.operationId);

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter) => resolveReference(value, parameter));
      const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const name of pathNames) {
        const parameter = parameters.find((item) => item?.in === "path" && item.name === name);
        if (!parameter || parameter.required !== true) {
          throw new Error(`${method.toUpperCase()} ${path} lacks required path parameter ${name}`);
        }
      }
    }
  }

  walk(value, (node) => {
    if (typeof node?.$ref !== "string") return;
    resolveReference(value, node);
  });

  for (const [name, schema] of Object.entries(value.components.schemas)) {
    const properties = schema?.properties ?? {};
    for (const required of schema?.required ?? []) {
      if (!(required in properties)) {
        throw new Error(`Schema ${name} requires missing property ${required}`);
      }
    }
  }
}

function resolveReference(document, value) {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith("#/")) throw new Error(`Only local references are allowed: ${value.$ref}`);
  const result = value.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], document);
  if (!result) throw new Error(`Unknown OpenAPI reference: ${value.$ref}`);
  return result;
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else walk(child, visit);
  }
}

function renderDocument(value, rawSource) {
  const hash = createHash("sha256").update(rawSource).digest("hex");
  const schemas = Object.entries(value.components.schemas)
    .map(([name, schema]) => `export type ${safeName(name)} = ${renderSchema(schema, 0)};`)
    .join("\n\n");
  const paths = Object.entries(value.paths)
    .flatMap(([path, pathItem]) =>
      ["get", "post", "put", "patch", "delete"]
        .filter((method) => pathItem[method])
        .map((method) => `  | ${JSON.stringify(`${method.toUpperCase()} ${path}`)}`),
    )
    .join("\n");
  const operations = Object.entries(value.paths)
    .flatMap(([path, pathItem]) =>
      ["get", "post", "put", "patch", "delete"]
        .filter((method) => pathItem[method])
        .map((method) => [pathItem[method].operationId, method.toUpperCase(), path]),
    );
  const operationIds = operations.map(([id]) => `  | ${JSON.stringify(id)}`).join("\n");
  const operationMap = operations
    .map(
      ([id, method, path]) =>
        `  ${propertyName(id)}: { method: ${JSON.stringify(method)}, path: ${JSON.stringify(path)} },`,
    )
    .join("\n");

  return `/* eslint-disable */
// This file is generated from docs/openapi.json. Do not edit it by hand.
// Contract SHA-256: ${hash}

${schemas}

export type ProductApiOperation =
${paths};

export type ProductApiOperationId =
${operationIds};

export const PRODUCT_API_OPERATIONS = {
${operationMap}
} as const satisfies Record<ProductApiOperationId, { method: string; path: string }>;
`;
}

function renderSchema(schema, depth) {
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  if (schema.$ref) return safeName(schema.$ref.split("/").at(-1));
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.oneOf) return schema.oneOf.map((item) => renderSchema(item, depth)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map((item) => renderSchema(item, depth)).join(" | ");
  if (schema.allOf) return schema.allOf.map((item) => `(${renderSchema(item, depth)})`).join(" & ");
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => renderSchema({ ...schema, type }, depth)).join(" | ");
  }
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, depth)}>`;
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "string") return "string";
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    if (!schema.properties && schema.additionalProperties) {
      const value = schema.additionalProperties === true ? "unknown" : renderSchema(schema.additionalProperties, depth);
      return `Record<string, ${value}>`;
    }
    const required = new Set(schema.required ?? []);
    const indentation = "  ".repeat(depth);
    const childIndentation = "  ".repeat(depth + 1);
    const properties = Object.entries(schema.properties ?? {}).map(([key, value]) => {
      const optional = required.has(key) ? "" : "?";
      return `${childIndentation}${propertyName(key)}${optional}: ${renderSchema(value, depth + 1)};`;
    });
    if (schema.additionalProperties) {
      const value = schema.additionalProperties === true ? "unknown" : renderSchema(schema.additionalProperties, depth + 1);
      properties.push(`${childIndentation}[key: string]: ${value};`);
    }
    return properties.length === 0 ? "Record<string, never>" : `{\n${properties.join("\n")}\n${indentation}}`;
  }
  return "unknown";
}

function safeName(value) {
  const name = String(value).replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(name) ? name : `_${name}`;
}

function propertyName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}
