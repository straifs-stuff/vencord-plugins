import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCatalog, prepareCatalogSource } from "../cli/catalog.ts";
import { buildTarget, discoverTargets, ensureTarget, resolveTarget, validateCheckout } from "../cli/checkout.ts";
import { loadRegistry, removePlugins, syncPlugins } from "../cli/manager.ts";
import { pnpmSpawnSpec } from "../cli/pnpm.ts";
import { ensurePluginTools, extractWindowsArchive, handBrakeAsset, readHandBrakeResolution } from "../cli/tools.ts";
import { locateTarget, pluginLabel } from "../cli/ui.ts";
import pc from "picocolors";

// Fixture builders

function pluginSource(value) {
    return `export default definePlugin({
    name: "DemoPlugin",
    description: "Exercises the plugin manager.",
    marker: ${JSON.stringify(value)}
});
`;
}

async function createSource(root, marker = "one", dependencies = {}, straifPlugin) {
    const pluginDir = join(root, "demoPlugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
        join(pluginDir, "package.json"),
        `${JSON.stringify(
            {
                name: "@fixture/demo-plugin",
                private: true,
                dependencies,
                straifPlugin
            },
            null,
            2
        )}\n`
    );
    await writeFile(join(pluginDir, "index.ts"), pluginSource(marker));
    const pnpmPath = join(root, "pnpm-test.mjs");
    await writeFile(
        pnpmPath,
        `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
if (process.argv[2] === "install") {
    await writeFile(join(process.cwd(), "pnpm-install-args.txt"), JSON.stringify(process.argv.slice(2)));
} else {
    const result = spawnSync(process.execPath, [join(process.cwd(), "build.mjs")], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
}
`
    );
    await chmod(pnpmPath, 0o755);
}

async function createTarget(root, { failFirstBuild = false, client = "equicord", version = "1.0.0" } = {}) {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
        join(root, "build.mjs"),
        `import { access, readFile, rm, writeFile } from "node:fs/promises";
const countPath = new URL("./build-count.txt", import.meta.url);
let count = 0;
try { count = Number(await readFile(countPath, "utf8")); } catch {}
await writeFile(countPath, String(count + 1));
const failPath = new URL("./fail-build", import.meta.url);
try { await access(failPath); await rm(failPath); process.exitCode = 1; } catch {}
`
    );
    if (failFirstBuild) await writeFile(join(root, "fail-build"), "");
    await writeFile(
        join(root, "package.json"),
        `${JSON.stringify(
            {
                name: client,
                private: true,
                version,
                scripts: {
                    build: "node build.mjs",
                    inject: "node inject.mjs"
                }
            },
            null,
            2
        )}\n`
    );
}

function captureOutput() {
    let text = "";
    return {
        output: {
            write(message) {
                text += message;
            }
        },
        read() {
            return text;
        }
    };
}

function runGit(cwd, args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

// Target selection

test("manual target selection opens the terminal browser without auto-detection", async () => {
    let prompt;
    let discoveryCalls = 0;
    const selected = await locateTarget(
        {
            async choose(message, options) {
                prompt = { message, options };
                return "manual";
            },
            async browseTarget(root) {
                assert.equal(root, "/starting-folder");
                return "/chosen-folder";
            }
        },
        "/starting-folder",
        async () => {
            discoveryCalls++;
            return [];
        }
    );

    assert.equal(selected, "/chosen-folder");
    assert.equal(discoveryCalls, 0);
    assert.match(prompt.message, /How would you like to find/);
    assert.deepEqual(prompt.options, [
        {
            value: "auto",
            label: "Detect automatically",
            hint: "Recommended, may take some time on slower hardware"
        },
        {
            value: "manual",
            label: "Locate manually",
            hint: "Use the terminal folder browser"
        }
    ]);
});

test("automatic target selection runs discovery and offers detected builds", async () => {
    const targets = [{ client: "vencord", root: "/detected-folder", version: "1.15.0" }];
    const messages = [];
    const selected = await locateTarget(
        {
            async choose() {
                return "auto";
            },
            async chooseTarget(discovered) {
                assert.deepEqual(discovered, targets);
                return discovered[0].root;
            },
            async browseTarget() {
                assert.fail("The folder browser should not open when a detected build is selected");
            },
            info(message) {
                messages.push(message);
            },
            success(message) {
                messages.push(message);
            }
        },
        "/starting-folder",
        async options => {
            assert.deepEqual(options, { root: "/starting-folder" });
            return targets;
        }
    );

    assert.equal(selected, "/detected-folder");
    assert.deepEqual(messages, ["Searching for local installations...", "Found 1 local installation."]);
});

// Plugin status labels

test("plugin statuses clearly explain their state", () => {
    const plugin = { displayName: "DemoPlugin" };
    assert.equal(pluginLabel(plugin), "DemoPlugin — Not installed");
    assert.equal(pluginLabel(plugin, { mode: "copy" }), "DemoPlugin — Installed");
    assert.equal(pluginLabel(plugin, { mode: "link" }), "DemoPlugin — Linked development copy");
    assert.equal(
        pluginLabel(
            { ...plugin, sourceCommit: "bbbbbbb222", latestCommit: "bbbbbbb222" },
            { mode: "copy", sourceCommit: "aaaaaaa111" }
        ),
        "DemoPlugin — Update available · aaaaaaa → bbbbbbb"
    );
    assert.equal(
        pluginLabel(
            { ...plugin, sourceCommit: "aaaaaaa111", latestCommit: "bbbbbbb222" },
            { mode: "copy", sourceCommit: "aaaaaaa111" }
        ),
        "DemoPlugin — Newer commit on main · bbbbbbb · update this folder first"
    );
    assert.equal(
        pluginLabel(
            { ...plugin, sourceCommit: "bbbbbbb222", latestCommit: "bbbbbbb222" },
            { mode: "copy", sourceCommit: "bbbbbbb222" }
        ),
        "DemoPlugin — Installed · bbbbbbb"
    );
});

test("commit updates use a warm warning color and a green destination", () => {
    const colors = pc.createColors(true);
    const label = pluginLabel(
        { displayName: "DemoPlugin", sourceCommit: "bbbbbbb222", latestCommit: "bbbbbbb222" },
        { mode: "copy", sourceCommit: "aaaaaaa111" },
        colors
    );

    assert.match(label, /\u001b\[33mUpdate available\u001b\[39m/);
    assert.match(label, /\u001b\[32mbbbbbbb\u001b\[39m/);
});

// Checkout validation and discovery

test("local build folder validation gives clear guidance", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-validation-"));
    const validRoot = join(fixture, "Vencord");
    const lookalikeRoot = join(fixture, "lookalike");
    await createTarget(validRoot, { client: "vencord", version: "1.15.0" });
    await mkdir(join(lookalikeRoot, "src"), { recursive: true });
    await writeFile(join(lookalikeRoot, "package.json"), JSON.stringify({ name: "vencord" }));

    assert.deepEqual(validateCheckout(validRoot).target, {
        client: "vencord",
        root: await realpath(validRoot),
        version: "1.15.0"
    });
    assert.match(validateCheckout(lookalikeRoot).error, /complete local Equicord or Vencord build/);
});

test("local build discovery finds clients hidden by a parent gitignore", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-discovery-"));
    const equicordRoot = join(fixture, "clients", "Equicord");
    const vencordRoot = join(fixture, "clients", "Vencord");
    await createTarget(equicordRoot, { client: "equicord", version: "1.15.0.2" });
    await createTarget(vencordRoot, { client: "vencord", version: "1.15.0" });
    await writeFile(join(fixture, ".gitignore"), "clients/\n");

    const targets = await discoverTargets({ root: fixture, timeoutMs: 10_000 });
    assert.deepEqual(
        targets.map(target => [target.client, target.version]),
        [
            ["equicord", "1.15.0.2"],
            ["vencord", "1.15.0"]
        ]
    );
});

test("Windows pnpm batch shims run through cmd.exe", () => {
    assert.deepEqual(
        pnpmSpawnSpec(["build"], "win32", {
            ComSpec: "C:\\Windows\\System32\\cmd.exe"
        }),
        {
            command: "C:\\Windows\\System32\\cmd.exe",
            args: ["/d", "/s", "/c", "pnpm.cmd", "build"]
        }
    );
});

// Catalog and registry behavior

test("saved plugin records remove legacy semantic versions", async () => {
    const userpluginsDir = await mkdtemp(join(tmpdir(), "straif-plugins-registry-migration-"));
    const registryPath = join(userpluginsDir, ".straif-plugins.json");
    await writeFile(
        registryPath,
        JSON.stringify({
            schemaVersion: 1,
            plugins: {
                demoPlugin: {
                    displayName: "DemoPlugin",
                    installFolder: "demoPlugin",
                    version: "1.2.3",
                    mode: "copy",
                    sourceHash: "sha256:source",
                    installedHash: "sha256:installed",
                    sourceCommit: "aaaaaaa111"
                }
            }
        })
    );

    const registry = await loadRegistry(userpluginsDir);
    assert.equal(registry.schemaVersion, 2);
    assert.equal("version" in registry.plugins.demoPlugin, false);
    const saved = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal("version" in saved.plugins.demoPlugin, false);
});

test("catalog tracks the current and latest main commits", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-commits-"));
    const sourceRoot = join(fixture, "source");
    const remoteRoot = join(fixture, "origin.git");
    await mkdir(sourceRoot);
    await createSource(sourceRoot);

    runGit(sourceRoot, ["init", "--initial-branch=main"]);
    runGit(sourceRoot, ["config", "user.name", "Test User"]);
    runGit(sourceRoot, ["config", "user.email", "test@example.com"]);
    runGit(sourceRoot, ["add", "."]);
    runGit(sourceRoot, ["commit", "-m", "Initial plugin"]);
    runGit(fixture, ["init", "--bare", remoteRoot]);
    runGit(sourceRoot, ["remote", "add", "origin", remoteRoot]);
    runGit(sourceRoot, ["push", "-u", "origin", "main"]);
    const firstCommit = runGit(sourceRoot, ["rev-parse", "HEAD"]);

    await writeFile(join(sourceRoot, "release-note.txt"), "new release\n");
    runGit(sourceRoot, ["add", "."]);
    runGit(sourceRoot, ["commit", "-m", "Next release"]);
    runGit(sourceRoot, ["push", "origin", "main"]);
    const latestCommit = runGit(sourceRoot, ["rev-parse", "HEAD"]);
    const [plugin] = await loadCatalog(sourceRoot);

    assert.equal(plugin.sourceCommit, latestCommit);
    assert.equal(plugin.latestCommit, latestCommit);
    assert.equal(
        pluginLabel(plugin, {
            mode: "copy",
            sourceCommit: firstCommit
        }),
        `DemoPlugin — Update available · ${firstCommit.slice(0, 7)} → ${latestCommit.slice(0, 7)}`
    );
});

test("packaged installer refreshes plugin files from remote main", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-packaged-source-"));
    const packagedRoot = join(fixture, "package");
    const sourceRoot = join(fixture, "source");
    const remoteRoot = join(fixture, "origin.git");
    await mkdir(packagedRoot);
    await mkdir(sourceRoot);
    await createSource(packagedRoot, "stale");
    await createSource(sourceRoot, "current");

    runGit(sourceRoot, ["init", "--initial-branch=main"]);
    runGit(sourceRoot, ["config", "user.name", "Test User"]);
    runGit(sourceRoot, ["config", "user.email", "test@example.com"]);
    runGit(sourceRoot, ["add", "."]);
    runGit(sourceRoot, ["commit", "-m", "Current plugin"]);
    runGit(fixture, ["init", "--bare", remoteRoot]);
    runGit(sourceRoot, ["remote", "add", "origin", remoteRoot]);
    runGit(sourceRoot, ["push", "-u", "origin", "main"]);
    const currentCommit = runGit(sourceRoot, ["rev-parse", "HEAD"]);

    const prepared = await prepareCatalogSource({
        sourceRoot: packagedRoot,
        packageRoot: packagedRoot,
        repositoryUrl: remoteRoot
    });
    const checkoutRoot = prepared.root;
    try {
        assert.match(await readFile(join(checkoutRoot, "demoPlugin", "index.ts"), "utf8"), /marker: "current"/);
        const [plugin] = await loadCatalog(checkoutRoot);
        assert.equal(plugin.sourceCommit, currentCommit);
    } finally {
        await prepared.cleanup();
    }
    await assert.rejects(readFile(join(checkoutRoot, "demoPlugin", "index.ts"), "utf8"));
});

test("plugin manager updates an installed commit pin even when files are unchanged", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-commit-pin-"));
    const sourceRoot = join(fixture, "source");
    const targetRoot = join(fixture, "Equicord");
    await mkdir(sourceRoot);
    await createSource(sourceRoot);
    await createTarget(targetRoot);

    const userpluginsDir = await ensureTarget(await resolveTarget(targetRoot));
    let registry = await loadRegistry(userpluginsDir);
    let catalog = await loadCatalog(sourceRoot);
    catalog[0].sourceCommit = "aaaaaaa111";
    catalog[0].latestCommit = "aaaaaaa111";
    await syncPlugins({
        userpluginsDir,
        registry,
        plugins: catalog,
        confirmDependencies: async () => true
    });

    registry = await loadRegistry(userpluginsDir);
    assert.equal(registry.plugins.demoPlugin.sourceCommit, "aaaaaaa111");
    catalog = await loadCatalog(sourceRoot);
    catalog[0].sourceCommit = "bbbbbbb222";
    catalog[0].latestCommit = "bbbbbbb222";
    const update = await syncPlugins({
        userpluginsDir,
        registry,
        plugins: catalog,
        confirmDependencies: async () => true
    });

    assert.deepEqual(update.updated, ["demoPlugin"]);
    assert.equal((await loadRegistry(userpluginsDir)).plugins.demoPlugin.sourceCommit, "bbbbbbb222");
});

// Native tool provisioning

test("catalog exposes native tool requirements", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-tool-catalog-"));
    await createSource(fixture, "one", {}, { tools: ["handbrake-cli", "handbrake-cli"] });

    const catalog = await loadCatalog(fixture);
    assert.deepEqual(catalog[0].tools, ["handbrake-cli"]);
});

test("native tool preparation reuses HandBrakeCLI from PATH", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-handbrake-path-"));
    const sourceRoot = join(fixture, "source");
    const binDir = join(fixture, "bin");
    const toolRoot = join(fixture, "tools");
    await mkdir(sourceRoot);
    await mkdir(binDir);
    await createSource(sourceRoot, "one", {}, { tools: ["handbrake-cli"] });
    const executable = join(binDir, "HandBrakeCLI");
    await writeFile(executable, "fixture");

    let prompted = false;
    const result = await ensurePluginTools({
        plugins: await loadCatalog(sourceRoot),
        toolRoot,
        platform: "linux",
        arch: "x64",
        env: { PATH: binDir },
        confirmInstall: async () => {
            prompted = true;
            return false;
        },
        run: async (command, args) => {
            assert.equal(command, await realpath(executable));
            assert.deepEqual(args, ["--version"]);
            return { code: 0, stdout: "HandBrake 1.11.2\n", stderr: "" };
        }
    });

    assert.equal(prompted, false);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.ready.length, 1);
    assert.deepEqual(await readHandBrakeResolution(toolRoot), {
        id: "handbrake-cli",
        provider: "path",
        command: await realpath(executable),
        argsPrefix: [],
        version: "1.11.2"
    });
});

test("native tool preparation installs and records the Linux Flatpak", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-handbrake-flatpak-"));
    const sourceRoot = join(fixture, "source");
    const binDir = join(fixture, "bin");
    const toolRoot = join(fixture, "tools");
    await mkdir(sourceRoot);
    await mkdir(binDir);
    await createSource(sourceRoot, "one", {}, { tools: ["handbrake-cli"] });
    const flatpak = join(binDir, "flatpak");
    await writeFile(flatpak, "fixture");

    let remoteAdded = false;
    let installed = false;
    let prompts = 0;
    const result = await ensurePluginTools({
        plugins: await loadCatalog(sourceRoot),
        toolRoot,
        platform: "linux",
        arch: "x64",
        env: { PATH: binDir },
        confirmInstall: async () => {
            prompts++;
            return true;
        },
        run: async (command, args, options) => {
            if (command !== (await realpath(flatpak))) return { code: 1, stdout: "", stderr: "" };
            if (args[0] === "info") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
            if (args[0] === "--user" && args[1] === "remote-add") {
                assert.deepEqual(args, [
                    "--user",
                    "remote-add",
                    "--if-not-exists",
                    "flathub",
                    "https://flathub.org/repo/flathub.flatpakrepo"
                ]);
                assert.equal(options.inherit, true);
                remoteAdded = true;
                return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "--user" && args[1] === "install") {
                assert.equal(remoteAdded, true);
                assert.deepEqual(args, ["--user", "install", "--noninteractive", "flathub", "fr.handbrake.ghb"]);
                assert.equal(options.inherit, true);
                installed = true;
                return { code: 0, stdout: "", stderr: "" };
            }
            assert.deepEqual(args, ["run", "--command=HandBrakeCLI", "fr.handbrake.ghb", "--version"]);
            return { code: 0, stdout: "HandBrake 1.11.2\n", stderr: "" };
        }
    });

    assert.equal(prompts, 1);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(await readHandBrakeResolution(toolRoot), {
        id: "handbrake-cli",
        provider: "flatpak",
        command: await realpath(flatpak),
        argsPrefix: ["run", "--command=HandBrakeCLI", "fr.handbrake.ghb"],
        version: "1.11.2"
    });
});

test("portable HandBrake assets are pinned for supported desktop platforms", () => {
    assert.equal(handBrakeAsset("win32", "x64")?.fileName, "HandBrakeCLI-1.11.2-win-x86_64.zip");
    assert.equal(handBrakeAsset("win32", "arm64")?.fileName, "HandBrakeCLI-1.11.2-win-aarch64.zip");
    assert.equal(handBrakeAsset("darwin", "x64")?.fileName, "HandBrakeCLI-1.11.2.dmg");
    assert.equal(
        handBrakeAsset("darwin", "arm64")?.sha256,
        "14463aa81038aaa3ce421dc6cee65fd6c82fdabda040931541ccca38939299fa"
    );
    assert.equal(handBrakeAsset("linux", "x64"), undefined);
});

test("Windows HandBrake extraction streams only the CLI executable with yauzl", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-handbrake-yauzl-"));
    const archive = join(fixture, "handbrake.zip");
    const executable = join(fixture, "HandBrakeCLI.exe");
    await writeFile(
        archive,
        Buffer.from(
            "UEsDBBQAAAAAAAAAAACK6Y5UEQAAABEAAAAQAAAASGFuZEJyYWtlQ0xJLmV4ZWZpeHR1cmUtaGFuZGJyYWtlUEsBAhQAFAAAAAAAAAAAAIrpjlQRAAAAEQAAABAAAAAAAAAAAAAAAAAAAAAAAEhhbmRCcmFrZUNMSS5leGVQSwUGAAAAAAEAAQA+AAAAPwAAAAAA",
            "base64"
        )
    );

    await extractWindowsArchive(archive, executable);

    assert.equal(await readFile(executable, "utf8"), "fixture-handbrake");
    assert.deepEqual((await readdir(fixture)).sort(), ["HandBrakeCLI.exe", "handbrake.zip"]);
});

// Plugin installation and lifecycle

test("plugin dependencies are installed with pnpm", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-pnpm-dependencies-"));
    const sourceRoot = join(fixture, "source");
    const targetRoot = join(fixture, "Equicord");
    await mkdir(sourceRoot);
    await createSource(sourceRoot, "one", { "demo-dependency": "1.0.0" });
    await createTarget(targetRoot);

    const previousPnpm = process.env.STRAIF_PNPM;
    process.env.STRAIF_PNPM = join(sourceRoot, "pnpm-test.mjs");
    try {
        const userpluginsDir = await ensureTarget(await resolveTarget(targetRoot));
        const registry = await loadRegistry(userpluginsDir);
        const catalog = await loadCatalog(sourceRoot);
        catalog[0].sourceCommit = "aaaaaaa111";
        catalog[0].latestCommit = "aaaaaaa111";
        await syncPlugins({
            userpluginsDir,
            registry,
            plugins: catalog,
            confirmDependencies: async () => true
        });

        const args = JSON.parse(await readFile(join(userpluginsDir, "demoPlugin", "pnpm-install-args.txt"), "utf8"));
        assert.deepEqual(args, ["install", "--prod", "--ignore-workspace", "--no-frozen-lockfile"]);
    } finally {
        if (previousPnpm === undefined) delete process.env.STRAIF_PNPM;
        else process.env.STRAIF_PNPM = previousPnpm;
    }
});

test("plugin manager installs, updates, protects local changes, and removes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-manager-"));
    const sourceRoot = join(fixture, "source");
    const targetRoot = join(fixture, "Equicord");
    await mkdir(sourceRoot);
    await createSource(sourceRoot);
    await createTarget(targetRoot);

    const previousPnpm = process.env.STRAIF_PNPM;
    process.env.STRAIF_PNPM = join(sourceRoot, "pnpm-test.mjs");
    const messages = captureOutput();
    try {
        const userpluginsDir = await ensureTarget(await resolveTarget(targetRoot));
        let registry = await loadRegistry(userpluginsDir);
        let catalog = await loadCatalog(sourceRoot);
        catalog[0].sourceCommit = "aaaaaaa111";
        catalog[0].latestCommit = "aaaaaaa111";
        const build = () => buildTarget(targetRoot, messages.output);

        const install = await syncPlugins({
            userpluginsDir,
            registry,
            plugins: catalog,
            confirmDependencies: async () => true,
            build,
            output: messages.output
        });
        assert.deepEqual(install.installed, ["demoPlugin"]);
        assert.equal(await readFile(join(userpluginsDir, "demoPlugin", "index.ts"), "utf8"), pluginSource("one"));
        assert.equal(await readFile(join(targetRoot, "build-count.txt"), "utf8"), "1");

        await createSource(sourceRoot, "two");
        registry = await loadRegistry(userpluginsDir);
        catalog = await loadCatalog(sourceRoot);
        catalog[0].sourceCommit = "bbbbbbb222";
        catalog[0].latestCommit = "bbbbbbb222";
        const update = await syncPlugins({
            userpluginsDir,
            registry,
            plugins: catalog,
            confirmDependencies: async () => true,
            build,
            output: messages.output
        });
        assert.deepEqual(update.updated, ["demoPlugin"]);
        assert.equal(await readFile(join(userpluginsDir, "demoPlugin", "index.ts"), "utf8"), pluginSource("two"));
        assert.equal(await readFile(join(targetRoot, "build-count.txt"), "utf8"), "2");

        await writeFile(join(userpluginsDir, "demoPlugin", "index.ts"), "local edit\n");
        await createSource(sourceRoot, "three");
        registry = await loadRegistry(userpluginsDir);
        catalog = await loadCatalog(sourceRoot);
        catalog[0].sourceCommit = "ccccccc333";
        catalog[0].latestCommit = "ccccccc333";
        await assert.rejects(
            syncPlugins({
                userpluginsDir,
                registry,
                plugins: catalog,
                confirmDependencies: async () => true,
                build,
                output: messages.output
            }),
            /changes that were not made by this installer/
        );
        assert.equal(await readFile(join(targetRoot, "build-count.txt"), "utf8"), "2");

        await writeFile(join(userpluginsDir, "demoPlugin", "index.ts"), pluginSource("two"));
        registry = await loadRegistry(userpluginsDir);
        const remove = await removePlugins({
            userpluginsDir,
            registry,
            ids: ["demoPlugin"],
            build,
            output: messages.output
        });
        assert.deepEqual(remove.removed, ["demoPlugin"]);
        assert.equal(await readFile(join(targetRoot, "build-count.txt"), "utf8"), "3");
    } finally {
        if (previousPnpm === undefined) delete process.env.STRAIF_PNPM;
        else process.env.STRAIF_PNPM = previousPnpm;
    }
});

test("a failed build restores the previous plugin state", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "straif-plugins-build-failure-"));
    const sourceRoot = join(fixture, "source");
    const targetRoot = join(fixture, "Equicord");
    await mkdir(sourceRoot);
    await createSource(sourceRoot);
    await createTarget(targetRoot, { failFirstBuild: true });

    const previousPnpm = process.env.STRAIF_PNPM;
    process.env.STRAIF_PNPM = join(sourceRoot, "pnpm-test.mjs");
    const messages = captureOutput();
    try {
        const userpluginsDir = await ensureTarget(await resolveTarget(targetRoot));
        const registry = await loadRegistry(userpluginsDir);
        const catalog = await loadCatalog(sourceRoot);
        catalog[0].sourceCommit = "aaaaaaa111";
        catalog[0].latestCommit = "aaaaaaa111";
        await assert.rejects(
            syncPlugins({
                userpluginsDir,
                registry,
                plugins: catalog,
                confirmDependencies: async () => true,
                build: () => buildTarget(targetRoot, messages.output),
                output: messages.output
            }),
            /could not apply the changes/i
        );

        await assert.rejects(readFile(join(userpluginsDir, "demoPlugin", "index.ts")));
        await assert.rejects(readFile(join(userpluginsDir, ".straif-plugins.json")));
        assert.equal(await readFile(join(targetRoot, "build-count.txt"), "utf8"), "2");
        assert.match(messages.read(), /previous plugin files were restored/);
    } finally {
        if (previousPnpm === undefined) delete process.env.STRAIF_PNPM;
        else process.env.STRAIF_PNPM = previousPnpm;
    }
});
