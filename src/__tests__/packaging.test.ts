import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
let temporary: string;
let packageDir: string;
let manifest: { main: string; exports: Record<string, { import: string }> };

beforeAll(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-package-"));
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", temporary, "--json"],
      { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  )[0];
  execFileSync("tar", [
    "-xzf",
    path.join(temporary, packed.filename),
    "-C",
    temporary,
  ]);
  fs.mkdirSync(path.join(temporary, "node_modules"));
  fs.cpSync(
    path.join(root, "node_modules/jsonc-parser"),
    path.join(temporary, "node_modules/jsonc-parser"),
    { recursive: true },
  );
  packageDir = path.join(temporary, "node_modules", "opencode-wakatime");
  fs.renameSync(path.join(temporary, "package"), packageDir);
  manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"),
  );
}, 30_000);

afterAll(() => {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

function inspect(specifier: string) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const mod = await import(${JSON.stringify(specifier)});
    console.log(JSON.stringify({
      keys: Object.keys(mod),
      type: typeof mod.default,
      id: mod.default.id,
      server: typeof mod.default.server,
      setup: typeof mod.default.setup,
    }));
  `,
      ],
      { cwd: temporary, encoding: "utf-8" },
    ),
  );
}

describe("published package", () => {
  it("loads the legacy main and root without either SDK installed", () => {
    expect(
      fs.existsSync(path.join(temporary, "node_modules/@opencode-ai/plugin")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(temporary, "node_modules/@opencode/plugin")),
    ).toBe(false);
    const expected = {
      keys: ["default"],
      type: "function",
      server: "undefined",
      setup: "undefined",
    };
    expect(inspect("opencode-wakatime")).toEqual(expected);
    expect(inspect(path.join(packageDir, manifest.main))).toEqual(expected);
  });

  it("exposes the server subpath preferred by modern v1 and v2 loaders", () => {
    const expected = {
      keys: ["default"],
      type: "object",
      id: "opencode.wakatime",
      server: "function",
      setup: "function",
    };
    expect(inspect("opencode-wakatime/server")).toEqual(expected);
    // V1 resolves the manifest path; V2 resolves the package subpath.
    expect(
      inspect(path.join(packageDir, manifest.exports["./server"].import)),
    ).toEqual(expected);
  });

  it("ships SDK-free standalone bundles for both loaders", () => {
    expect(inspect(path.join(packageDir, "dist/bundle.js"))).toMatchObject({
      keys: ["default"],
      type: "function",
    });
    expect(inspect(path.join(packageDir, "dist/bundle-v2.js"))).toMatchObject({
      keys: ["default"],
      server: "function",
      setup: "function",
    });
    expect(fs.existsSync(path.join(packageDir, "dist/__tests__"))).toBe(false);
  });
});

function installation(xdg = false) {
  const home = fs.mkdtempSync(path.join(temporary, "home-"));
  const configHome = path.join(home, xdg ? "custom-config" : ".config");
  const directory = path.join(configHome, "opencode");
  const file = (name: string) => path.join(directory, name);
  return {
    home,
    directory,
    file,
    write(name: string, text: string) {
      fs.mkdirSync(path.dirname(file(name)), { recursive: true });
      fs.writeFileSync(file(name), text);
    },
    read(name = "opencode.json") {
      return fs.readFileSync(file(name), "utf-8");
    },
    run(...args: string[]) {
      return execFileSync(
        process.execPath,
        [path.join(packageDir, "bin/cli.js"), ...args],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: xdg ? configHome : "",
          },
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    },
    legacy(folder = "plugin") {
      const name = `${folder}/wakatime.js`;
      this.write(
        name,
        fs.readFileSync(path.join(packageDir, "dist/bundle.js"), "utf-8"),
      );
      return file(name);
    },
  };
}

describe("config installer", () => {
  it("registers one package for both versions and repeated installs do nothing", () => {
    const install = installation();
    install.run("--install");
    const text = install.read();
    expect(JSON.parse(text)).toEqual({ plugin: ["opencode-wakatime"] });
    expect(fs.existsSync(install.file("plugin/wakatime.js"))).toBe(false);
    install.run("--install");
    expect(install.read()).toBe(text);
    expect(() => install.run("--install", "--v2")).toThrow();
    expect(install.read()).toBe(text);
    install.run("--uninstall");
    expect(JSON.parse(install.read())).toEqual({ plugin: [] });
    install.run("--uninstall");
  });

  it("preserves JSONC comments, other settings, and trailing commas", () => {
    const install = installation();
    install.write(
      "opencode.jsonc",
      `{
  // Model choice stays here.
  "model": "provider/model",
  "instructions": ["https://example.com/a/*"],
  "plugin": [
    // Keep this plugin.
    "other-plugin",
  ],
}\n`,
    );
    install.run("--install");
    const text = install.read("opencode.jsonc");
    expect(text).toContain("// Model choice stays here.");
    expect(text).toContain("// Keep this plugin.");
    expect(parse(text)).toEqual({
      model: "provider/model",
      instructions: ["https://example.com/a/*"],
      plugin: ["other-plugin", "opencode-wakatime"],
    });
    expect(fs.existsSync(install.file("opencode.json"))).toBe(false);
    install.run("--uninstall");
    expect(parse(install.read("opencode.jsonc")).plugin).toEqual([
      "other-plugin",
    ]);
    expect(install.read("opencode.jsonc")).toContain("// Keep this plugin.");
  });

  it.each([
    { plugin: [["opencode-wakatime@1.3.9", { example: true }]] },
    {
      plugins: [
        { package: "opencode-wakatime@1.3.9", options: { example: true } },
      ],
    },
  ])("preserves existing pins and options: %j", (config) => {
    const install = installation();
    const text = JSON.stringify(config, null, 2);
    install.write("opencode.jsonc", text);
    install.run("--install");
    expect(install.read("opencode.jsonc")).toBe(text);
  });

  it("uses an existing native v2 plugin list rather than adding a second key", () => {
    const install = installation();
    install.write("opencode.json", '{"plugins":["other-plugin"]}');
    install.run("--install");
    expect(JSON.parse(install.read())).toEqual({
      plugins: ["other-plugin", "opencode-wakatime"],
    });
  });

  it("migrates configured legacy bundles while preserving options", () => {
    const install = installation();
    const legacy = install.legacy();
    const plural = install.legacy("plugins");
    install.write("plugin/custom.js", "// unrelated plugin");
    install.write(
      "opencode.json",
      JSON.stringify({ plugin: [[legacy, { example: true }]] }),
    );
    install.run("--install");
    expect(JSON.parse(install.read())).toEqual({
      plugin: [["opencode-wakatime", { example: true }]],
    });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(plural)).toBe(false);
    expect(install.read("plugin/custom.js")).toBe("// unrelated plugin");
  });

  it("keeps one registration across merged global configs and both keys", () => {
    const install = installation();
    install.write(
      "config.json",
      '{"plugin":["opencode-wakatime@1.0.0","other"]}',
    );
    install.write(
      "opencode.json",
      '{"plugin":["opencode-wakatime","opencode-wakatime"]}',
    );
    const native = {
      package: "opencode-wakatime@1.3.9",
      options: { example: true },
    };
    install.write("opencode.jsonc", JSON.stringify({ plugins: [native] }));
    install.run("--install");
    expect(parse(install.read("config.json")).plugin).toEqual(["other"]);
    expect(parse(install.read()).plugin).toEqual([]);
    expect(parse(install.read("opencode.jsonc")).plugins).toEqual([native]);
  });

  it("does not add another registration when a lower-precedence config has one", () => {
    const install = installation();
    install.write("config.json", '{"plugin":["opencode-wakatime@1.3.9"]}');
    install.write("opencode.jsonc", '{"model":"provider/model"}');
    install.run("--install");
    expect(install.read("config.json")).toBe(
      '{"plugin":["opencode-wakatime@1.3.9"]}',
    );
    expect(install.read("opencode.jsonc")).toBe('{"model":"provider/model"}');
  });

  it("uninstalls all global registrations and legacy bundles without touching other plugins", () => {
    const install = installation();
    const legacy = install.legacy();
    install.write(
      "config.json",
      '{"plugin":["opencode-wakatime@1.3.9","opencode-wakatime-extra"]}',
    );
    install.write(
      "opencode.jsonc",
      JSON.stringify({
        plugin: [["opencode-wakatime", { example: true }]],
        plugins: [{ package: "opencode-wakatime" }, "other-plugin"],
        model: "provider/model",
      }),
    );
    install.run("--uninstall");
    expect(fs.existsSync(legacy)).toBe(false);
    expect(parse(install.read("config.json")).plugin).toEqual([
      "opencode-wakatime-extra",
    ]);
    expect(parse(install.read("opencode.jsonc"))).toEqual({
      plugin: [],
      plugins: ["other-plugin"],
      model: "provider/model",
    });
  });

  it.each([
    '{"plugin": [',
    "[]",
    '{"plugin":"wrong"}',
    '{"plugin":[],"plugin":[]}',
  ])("leaves invalid config and old bundles untouched: %s", (text) => {
    const install = installation();
    const legacy = install.legacy();
    install.write("opencode.json", text);
    expect(() => install.run("--install")).toThrow();
    expect(() => install.run("--uninstall")).toThrow();
    expect(install.read()).toBe(text);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("refuses to remove an unrecognized wakatime.js file", () => {
    const install = installation();
    install.write("plugin/wakatime.js", "// my custom plugin");
    expect(() => install.run("--install")).toThrow();
    expect(install.read("plugin/wakatime.js")).toBe("// my custom plugin");
    expect(fs.existsSync(install.file("opencode.json"))).toBe(false);
  });

  it("honors XDG_CONFIG_HOME without editing the default directory", () => {
    const install = installation(true);
    const defaultFile = path.join(
      install.home,
      ".config/opencode/opencode.json",
    );
    fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
    fs.writeFileSync(defaultFile, '{"model":"untouched"}');
    install.run("--install");
    expect(JSON.parse(install.read())).toEqual({
      plugin: ["opencode-wakatime"],
    });
    expect(fs.readFileSync(defaultFile, "utf-8")).toBe('{"model":"untouched"}');
  });

  it("does not create config when uninstalling an absent plugin", () => {
    const install = installation();
    install.run("--uninstall");
    expect(fs.existsSync(install.directory)).toBe(false);
  });
});
