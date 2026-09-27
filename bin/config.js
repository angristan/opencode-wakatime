import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  SyntaxKind,
} from "jsonc-parser";

const packageName = "opencode-wakatime";
const keys = ["plugin", "plugins"];

async function readOptional(file) {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function configDocument(file, text) {
  const errors = [];
  const options = { allowTrailingComma: true, allowEmptyContent: false };
  const value = parse(text, errors, options);
  if (errors.length > 0) {
    throw new Error(
      `Cannot edit ${file}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cannot edit ${file}: expected a JSON object`);
  }
  // Duplicate keys make a targeted edit ambiguous. Do not rewrite such a file.
  const properties = parseTree(text, [], options).children ?? [];
  const names = properties.map((property) => property.children[0].value);
  if (new Set(names).size !== names.length) {
    throw new Error(`Cannot edit ${file}: duplicate top-level keys`);
  }
  for (const key of keys) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      throw new Error(`Cannot edit ${file}: ${key} must be an array`);
    }
  }
  return { file, original: text, text, value };
}

function edit(document, path, value) {
  if (value === undefined) {
    // jsonc-parser 3.3.1's modify() can corrupt last-item array deletions.
    // Remove the value and its adjacent comma using the parsed token offsets.
    const node = findNodeAtLocation(parseTree(document.text), path);
    const scanner = createScanner(document.text, true);
    const edits = [{ offset: node.offset, length: node.length, content: "" }];
    scanner.setPosition(node.offset + node.length);
    if (scanner.scan() === SyntaxKind.CommaToken) {
      edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
    } else {
      const index = path.at(-1);
      if (index > 0) {
        const previous = node.parent.children[index - 1];
        scanner.setPosition(previous.offset + previous.length);
        if (scanner.scan() !== SyntaxKind.CommaToken)
          throw new Error(`Cannot remove plugin entry in ${document.file}`);
        edits.push({
          offset: scanner.getTokenOffset(),
          length: 1,
          content: "",
        });
      }
    }
    document.text = applyEdits(document.text, edits);
    return;
  }
  const indent = document.text.match(/\n([\t ]+)"/)?.[1] ?? "  ";
  document.text = applyEdits(
    document.text,
    modify(document.text, path, value, {
      formattingOptions: {
        insertSpaces: !indent.includes("\t"),
        tabSize: indent.includes("\t") ? 2 : indent.length,
        eol: document.text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}

function specifier(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return entry[0];
  return entry?.package;
}

function isWakatime(entry, document, legacyFiles) {
  const spec = specifier(entry);
  if (typeof spec !== "string") return false;
  if (spec === packageName || spec.startsWith(`${packageName}@`)) return true;
  try {
    const file = spec.startsWith("file://")
      ? fileURLToPath(spec)
      : resolve(dirname(document.file), spec);
    return legacyFiles.includes(file);
  } catch {
    return false;
  }
}

function packageEntry(entry) {
  const spec = specifier(entry);
  if (spec === packageName || spec.startsWith(`${packageName}@`)) return entry;
  // Preserve options when migrating a configured standalone file.
  if (Array.isArray(entry)) return [packageName, ...entry.slice(1)];
  if (typeof entry === "object") return { ...entry, package: packageName };
  return packageName;
}

/** Update only global plugin entries; never invoke OpenCode or install packages. */
export async function configure(action) {
  const directory = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "opencode",
  );
  const legacyFiles = ["plugin", "plugins"].map((folder) =>
    join(directory, folder, "wakatime.js"),
  );
  const legacy = [];
  for (const file of legacyFiles) {
    const text = await readOptional(file);
    if (text === undefined) continue;
    if (
      !text.includes("OpenCode WakaTime plugin initialized") ||
      !text.includes("opencode-version-cache.json")
    ) {
      throw new Error(
        `Refusing to remove unrecognized plugin ${file}. Move it out of OpenCode's plugin directory before retrying.`,
      );
    }
    legacy.push({ file, text });
  }

  // OpenCode merges these global files in this order.
  const documents = [];
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const file = join(directory, name);
    const text = await readOptional(file);
    if (text !== undefined) documents.push(configDocument(file, text));
  }
  if (action === "install" && documents.length === 0) {
    const document = configDocument(join(directory, "opencode.json"), "{}\n");
    document.original = undefined;
    documents.push(document);
  }

  const matches = [];
  for (const document of documents) {
    for (const key of keys) {
      for (const [index, entry] of (document.value[key] ?? []).entries()) {
        if (isWakatime(entry, document, legacyFiles))
          matches.push({ document, key, index, entry });
      }
    }
  }

  const keep = action === "install" ? matches.at(-1) : undefined;
  // Remove backwards so array indexes stay valid. Keep the highest-precedence
  // existing registration, including its version pin and options.
  for (const match of [...matches].reverse()) {
    if (match === keep) {
      const replacement = packageEntry(match.entry);
      if (replacement !== match.entry)
        edit(match.document, [match.key, match.index], replacement);
    } else {
      edit(match.document, [match.key, match.index], undefined);
    }
  }
  if (action === "install" && !keep) {
    const document = documents.at(-1);
    const key = document.value.plugins !== undefined ? "plugins" : "plugin";
    if (document.value[key])
      edit(document, [key, document.value[key].length], packageName);
    else edit(document, [key], [packageName]);
  }

  // Validate the edited text before writing or deleting anything.
  for (const document of documents)
    configDocument(document.file, document.text);

  // Check for concurrent edits before writing or deleting anything.
  for (const document of documents) {
    if ((await readOptional(document.file)) !== document.original) {
      throw new Error(
        `Config changed while editing: ${document.file}. Retry the command.`,
      );
    }
  }
  for (const item of legacy) {
    if ((await readOptional(item.file)) !== item.text) {
      throw new Error(
        `Plugin changed while editing: ${item.file}. Retry the command.`,
      );
    }
  }

  const updated = [];
  for (const document of documents) {
    if (document.text === document.original) continue;
    await mkdir(dirname(document.file), { recursive: true });
    await writeFile(document.file, document.text, { mode: 0o600 });
    updated.push(document.file);
  }
  // Remove old bundles only after package registration has been saved.
  for (const item of legacy) {
    await unlink(item.file);
  }
  return { updated, removed: legacy.map((item) => item.file) };
}
