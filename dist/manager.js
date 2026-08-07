import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { spawnPnpm } from "./pnpm.js";
// Registry configuration
const REGISTRY_FILENAME = ".straif-plugins.json";
const REGISTRY_VERSION = 2;
const EXCLUDED_NAMES = { ".git": true, node_modules: true };
// Filesystem, registry, and integrity helpers
function pathExists(path) {
    return lstat(path).then(() => true, () => false);
}
function registryPath(userpluginsDir) {
    return join(userpluginsDir, REGISTRY_FILENAME);
}
async function writeRegistry(userpluginsDir, registry) {
    const path = registryPath(userpluginsDir);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
}
async function restoreRegistry(userpluginsDir, registry, existed) {
    if (existed)
        await writeRegistry(userpluginsDir, registry);
    else
        await rm(registryPath(userpluginsDir), { force: true });
}
async function addDirectoryToHash(hash, root, directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (EXCLUDED_NAMES[entry.name])
            continue;
        const path = join(directory, entry.name);
        const key = relative(root, path).replaceAll("\\", "/");
        hash.update(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${key}\0`);
        if (entry.isDirectory())
            await addDirectoryToHash(hash, root, path);
        else if (entry.isSymbolicLink())
            hash.update(await readlink(path));
        else
            hash.update(await readFile(path));
    }
}
async function hashDirectory(path) {
    const hash = createHash("sha256");
    await addDirectoryToHash(hash, path, path);
    return `sha256:${hash.digest("hex")}`;
}
// Package dependency installation
async function runPnpmInstall(directory) {
    const hasLockfile = await pathExists(join(directory, "pnpm-lock.yaml"));
    const args = [
        "install",
        "--prod",
        "--ignore-workspace",
        hasLockfile ? "--frozen-lockfile" : "--no-frozen-lockfile"
    ];
    const { promise, resolve: resolveInstall, reject } = Promise.withResolvers();
    const child = spawnPnpm(args, { cwd: directory, stdio: "inherit" });
    child.once("error", error => reject(error.code === "ENOENT"
        ? new Error("pnpm was not found. Install pnpm, then try again.")
        : error));
    child.once("close", code => code === 0
        ? resolveInstall()
        : reject(new Error(`Required package installation failed because pnpm stopped with code ${code}.`)));
    return promise;
}
async function acceptDependencies(plugins, yes, confirmDependencies, output) {
    const accepted = [];
    const skipped = [];
    for (const plugin of plugins) {
        if (plugin.dependencies.length === 0 || yes) {
            accepted.push(plugin);
            continue;
        }
        if (await confirmDependencies(plugin))
            accepted.push(plugin);
        else {
            skipped.push(plugin.id);
            output.write(`${plugin.displayName} was skipped because its extra packages were not installed.\n`);
        }
    }
    return { accepted, skipped };
}
// Transaction recovery
async function rebuildRestoredFiles(build, output, message) {
    if (!build)
        return;
    output.write(`${message}\n`);
    try {
        await build();
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        output.write(`The restored files could not be applied: ${detail}\n`);
    }
}
// Plugin replacement transaction
async function applyReplacements({ userpluginsDir, registry, replacements, build, output }) {
    const originalRegistry = structuredClone(registry);
    const hadRegistry = await pathExists(registryPath(userpluginsDir));
    const transactionDir = await mkdtemp(join(userpluginsDir, ".straif-transaction-"));
    const applied = [];
    let buildAttempted = false;
    try {
        for (let index = 0; index < replacements.length; index++) {
            const { plugin, mode, action } = replacements[index];
            const destination = join(userpluginsDir, plugin.installFolder);
            const backup = join(transactionDir, String(index));
            const existed = await pathExists(destination);
            if (existed)
                await rename(destination, backup);
            applied.push({ destination, backup, existed });
            if (mode === "link") {
                await symlink(plugin.sourceDir, destination, process.platform === "win32" ? "junction" : "dir");
            }
            else {
                await cp(plugin.sourceDir, destination, {
                    recursive: true,
                    errorOnExist: true,
                    filter: path => !EXCLUDED_NAMES[basename(path)]
                });
            }
            if (plugin.dependencies.length > 0)
                await runPnpmInstall(mode === "link" ? plugin.sourceDir : destination);
            const sourceHash = await hashDirectory(plugin.sourceDir);
            const installedHash = mode === "link" ? sourceHash : await hashDirectory(destination);
            registry.plugins[plugin.id] = {
                displayName: plugin.displayName,
                installFolder: plugin.installFolder,
                mode,
                sourceHash,
                installedHash,
                linkedSource: mode === "link" ? plugin.sourceDir : undefined,
                sourceCommit: plugin.sourceCommit
            };
            const commit = plugin.sourceCommit?.slice(0, 7);
            const message = action === "update"
                ? `Updated ${plugin.displayName} · ${commit}`
                : mode === "link"
                    ? `Linked ${plugin.displayName} · ${commit}`
                    : `Installed ${plugin.displayName} · ${commit}`;
            output.write(`${message}\n`);
        }
        await writeRegistry(userpluginsDir, registry);
        if (build) {
            buildAttempted = true;
            await build();
        }
    }
    catch (error) {
        for (const item of applied.reverse()) {
            await rm(item.destination, { recursive: true, force: true });
            if (item.existed)
                await rename(item.backup, item.destination);
        }
        await restoreRegistry(userpluginsDir, originalRegistry, hadRegistry);
        if (buildAttempted)
            await rebuildRestoredFiles(build, output, "The build failed, so the previous plugin files were restored. Trying again...");
        throw error;
    }
    finally {
        await rm(transactionDir, { recursive: true, force: true });
    }
}
// Installed state validation
async function assertUnmodified(userpluginsDir, id, record, force) {
    const destination = join(userpluginsDir, record.installFolder);
    if (!(await pathExists(destination)))
        throw new Error(`The files for ${record.displayName ?? id} are missing. They may have been moved or deleted: ${destination}`);
    if (record.mode === "link") {
        const stats = await lstat(destination);
        if (!stats.isSymbolicLink() && !force)
            throw new Error(`${record.displayName ?? id} is no longer linked to its original folder. Restore the link or remove the plugin folder, then try again.`);
        return;
    }
    const currentHash = await hashDirectory(destination);
    if (currentHash !== record.installedHash && !force)
        throw new Error(`${record.displayName ?? id} contains changes that were not made by this installer. Back them up or restore the plugin folder, then try again.`);
}
// Public plugin management API
export async function loadRegistry(userpluginsDir) {
    const path = registryPath(userpluginsDir);
    if (!(await pathExists(path)))
        return { schemaVersion: REGISTRY_VERSION, plugins: {} };
    let registry;
    try {
        registry = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`The saved plugin information could not be read: ${message}`);
    }
    if ((registry.schemaVersion !== 1 && registry.schemaVersion !== REGISTRY_VERSION) ||
        !registry.plugins ||
        typeof registry.plugins !== "object")
        throw new Error("The saved plugin information was created by a newer or incompatible version of this installer.");
    let migrated = registry.schemaVersion !== REGISTRY_VERSION;
    for (const record of Object.values(registry.plugins)) {
        if ("version" in record) {
            delete record.version;
            migrated = true;
        }
    }
    if (migrated) {
        registry.schemaVersion = REGISTRY_VERSION;
        await writeRegistry(userpluginsDir, registry);
    }
    return registry;
}
export async function syncPlugins({ userpluginsDir, registry, plugins, link = false, force = false, yes = false, confirmDependencies, build, output = process.stdout }) {
    const changes = [];
    const skipped = [];
    const seenFolders = new Set();
    for (const plugin of plugins) {
        if (seenFolders.has(plugin.installFolder))
            throw new Error(`Two selected plugins would use the same folder: ${plugin.installFolder}`);
        seenFolders.add(plugin.installFolder);
        if (!plugin.sourceCommit)
            throw new Error(`The commit for ${plugin.displayName} could not be identified. Run this installer from its downloaded Git folder.`);
        if (plugin.latestCommit && plugin.sourceCommit !== plugin.latestCommit)
            throw new Error(`A newer commit is available for ${plugin.displayName}. Update this installer folder from main, then try again.`);
        const record = registry.plugins[plugin.id];
        if (!record) {
            const owner = Object.entries(registry.plugins).find(([, installed]) => installed.installFolder === plugin.installFolder)?.[0];
            if (owner)
                throw new Error(`The folder ${plugin.installFolder} is already used by ${owner}.`);
            const destination = join(userpluginsDir, plugin.installFolder);
            if ((await pathExists(destination)) && !force)
                throw new Error(`A folder already exists at ${destination}. Move or remove it, then try again.`);
            changes.push({ plugin, mode: link ? "link" : "copy", action: "install" });
            continue;
        }
        if (record.installFolder !== plugin.installFolder)
            throw new Error(`${plugin.displayName} now uses a different folder. Remove it first, then add it again.`);
        if (record.mode === "link") {
            output.write(`${plugin.displayName} is linked to a development folder, so it was left unchanged.\n`);
            skipped.push(plugin.id);
            continue;
        }
        await assertUnmodified(userpluginsDir, plugin.id, record, force);
        const sourceHash = await hashDirectory(plugin.sourceDir);
        if (record.sourceCommit === plugin.sourceCommit) {
            if (sourceHash === record.sourceHash) {
                output.write(`${plugin.displayName} is up to date.\n`);
                skipped.push(plugin.id);
                continue;
            }
            if (!force)
                throw new Error(`${plugin.displayName}'s files changed without a new commit. Commit the changes before trying again.`);
        }
        changes.push({ plugin, mode: "copy", action: "update" });
    }
    const dependencyResult = await acceptDependencies(changes.map(change => change.plugin), yes, confirmDependencies, output);
    skipped.push(...dependencyResult.skipped);
    const acceptedIds = new Set(dependencyResult.accepted.map(plugin => plugin.id));
    const replacements = changes.filter(change => acceptedIds.has(change.plugin.id));
    if (replacements.length > 0)
        await applyReplacements({ userpluginsDir, registry, replacements, build, output });
    return {
        installed: replacements.filter(change => change.action === "install").map(change => change.plugin.id),
        updated: replacements.filter(change => change.action === "update").map(change => change.plugin.id),
        skipped
    };
}
export async function removePlugins({ userpluginsDir, registry, ids, force = false, build, output = process.stdout }) {
    const originalRegistry = structuredClone(registry);
    const hadRegistry = await pathExists(registryPath(userpluginsDir));
    const transactionDir = await mkdtemp(join(userpluginsDir, ".straif-transaction-"));
    const removed = [];
    let buildAttempted = false;
    try {
        for (let index = 0; index < ids.length; index++) {
            const id = ids[index];
            const record = registry.plugins[id];
            if (!record)
                throw new Error(`Plugin is not installed: ${id}`);
            await assertUnmodified(userpluginsDir, id, record, force);
            const destination = join(userpluginsDir, record.installFolder);
            const backup = join(transactionDir, String(index));
            await rename(destination, backup);
            removed.push({ id, destination, backup, displayName: record.displayName ?? id });
            delete registry.plugins[id];
        }
        await writeRegistry(userpluginsDir, registry);
        if (build) {
            buildAttempted = true;
            await build();
        }
    }
    catch (error) {
        for (const item of removed.reverse())
            await rename(item.backup, item.destination);
        await restoreRegistry(userpluginsDir, originalRegistry, hadRegistry);
        if (buildAttempted)
            await rebuildRestoredFiles(build, output, "The build failed, so the removed plugins were restored. Trying again...");
        throw error;
    }
    finally {
        await rm(transactionDir, { recursive: true, force: true });
    }
    removed.forEach(item => output.write(`Uninstalled ${item.displayName}\n`));
    return { removed: removed.map(item => item.id) };
}
