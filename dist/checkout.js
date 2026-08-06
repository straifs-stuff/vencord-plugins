import { spawn } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { FileFinder } from "@ff-labs/fff-node";
const DISCOVERY_SKIP_NAMES = {
    ".git": true,
    ".cache": true,
    ".pnpm": true,
    ".venv": true,
    "__pycache__": true,
    dist: true,
    node_modules: true,
    out: true,
    target: true,
    venv: true
};
const DISCOVERY_SKIP_PREFIXES = [
    ".local/share/Trash",
    "AppData/Local",
    "AppData/Roaming",
    "Library/Application Support",
    "Library/Caches",
    "Library/Containers",
    "Library/Group Containers"
];
function expandHome(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/") || path.startsWith("~\\"))
        return join(homedir(), path.slice(2));
    return path;
}
export function validateCheckout(path) {
    const absolute = resolve(expandHome(path));
    let root;
    let manifest;
    try {
        root = realpathSync(absolute);
        manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    }
    catch {
        return { error: `I couldn't read package.json in this folder: ${absolute}` };
    }
    if (manifest.name !== "equicord" && manifest.name !== "vencord")
        return { error: `That isn't the folder where Equicord or Vencord was downloaded and built: ${root}` };
    try {
        if (!statSync(join(root, "src")).isDirectory())
            return { error: `That folder is missing src. Make sure you chose the main Equicord or Vencord folder: ${root}` };
    }
    catch {
        return { error: `That folder is missing src. Make sure you chose the main Equicord or Vencord folder: ${root}` };
    }
    if (typeof manifest.scripts?.build !== "string" || typeof manifest.scripts.inject !== "string")
        return { error: `That doesn't look like a complete local Equicord or Vencord build. Make sure you selected its main folder: ${root}` };
    return {
        target: {
            client: manifest.name,
            root,
            version: typeof manifest.version === "string" ? manifest.version : undefined
        }
    };
}
async function discoverWithFff(searchRoot, timeoutMs) {
    let finder;
    try {
        const created = FileFinder.create({
            basePath: searchRoot,
            enableHomeDirScanning: searchRoot === resolve(homedir()),
            disableContentIndexing: true,
            disableMmapCache: true,
            disableWatch: true
        });
        if (!created.ok)
            return [];
        finder = created.value;
        const ready = await finder.waitForScan(timeoutMs);
        if (!ready.ok || !ready.value)
            return [];
        const targets = new Map();
        const pageSize = 500;
        for (let pageIndex = 0;; pageIndex++) {
            const result = finder.glob("**/package.json", { pageIndex, pageSize });
            if (!result.ok)
                return [];
            for (const item of result.value.items) {
                const validation = validateCheckout(dirname(resolve(searchRoot, item.relativePath)));
                if (validation.target)
                    targets.set(validation.target.root, validation.target);
            }
            if ((pageIndex + 1) * pageSize >= result.value.totalMatched || result.value.items.length === 0)
                break;
        }
        return [...targets.values()];
    }
    catch {
        return [];
    }
    finally {
        finder?.destroy();
    }
}
async function discoverIgnoredTargets(searchRoot, maxDepth) {
    const targets = new Map();
    const queue = [{ directory: searchRoot, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current)
            break;
        const validation = validateCheckout(current.directory);
        if (validation.target) {
            targets.set(validation.target.root, validation.target);
            continue;
        }
        if (current.depth >= maxDepth)
            continue;
        try {
            const entries = await readdir(current.directory, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || DISCOVERY_SKIP_NAMES[entry.name])
                    continue;
                const directory = join(current.directory, entry.name);
                const relativePath = relative(searchRoot, directory).replaceAll("\\", "/");
                if (DISCOVERY_SKIP_PREFIXES.some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`)))
                    continue;
                queue.push({ directory, depth: current.depth + 1 });
            }
        }
        catch { }
    }
    return [...targets.values()];
}
export async function discoverTargets({ root = homedir(), timeoutMs = 10_000, maxDepth = Number.POSITIVE_INFINITY } = {}) {
    const searchRoot = resolve(root);
    const discovered = await Promise.all([
        discoverWithFff(searchRoot, timeoutMs),
        discoverIgnoredTargets(searchRoot, maxDepth)
    ]);
    const targets = new Map(discovered.flat().map(target => [target.root, target]));
    return [...targets.values()].sort((left, right) => left.client.localeCompare(right.client) || left.root.localeCompare(right.root));
}
export async function resolveTarget(target) {
    if (!target)
        throw new Error("Choose the folder where Equicord or Vencord was downloaded and built.");
    const validation = validateCheckout(target);
    if (!validation.target)
        throw new Error(validation.error ?? "That isn't a valid local Equicord or Vencord build folder.");
    return join(validation.target.root, "src", "userplugins");
}
export async function ensureTarget(userpluginsDir) {
    await mkdir(userpluginsDir, { recursive: true });
    return realpath(userpluginsDir);
}
export async function buildTarget(targetRoot, output = process.stdout) {
    const executable = process.env.STRAIF_PNPM || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    output.write("Applying the plugin changes...\n");
    await new Promise((resolveBuild, reject) => {
        const child = spawn(executable, ["build"], {
            cwd: targetRoot,
            stdio: "inherit"
        });
        child.once("error", error => reject(error.code === "ENOENT"
            ? new Error("pnpm was not found. Finish setting up Equicord or Vencord, then try again.")
            : error));
        child.once("close", code => code === 0
            ? resolveBuild()
            : reject(new Error(`Equicord or Vencord could not apply the changes. The build tool stopped with code ${code}.`)));
    });
    output.write("Plugin changes applied.\n");
}
