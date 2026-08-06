import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_ROOT = resolve(process.env.STRAIF_PLUGINS_SOURCE || PACKAGE_ROOT);
const RESERVED_DIRECTORIES = {
    cli: true,
    cloned: true,
    node_modules: true,
    test: true
};
const ENTRY_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
const INSTALL_FOLDER_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.(?:desktop|web|dev|discordDesktop|vesktop|equibop))?$/;
const PLUGIN_NAME_PATTERN = /export\s+default\s+definePlugin\s*\(\s*\{[\s\S]*?\bname\s*:\s*(["'`])([^"'`\r\n]+)\1/;
const REPOSITORY_URL = "https://github.com/straifs-stuff/plugins.git";
function gitOutput(args, cwd) {
    const { promise, resolve: resolveResult } = Promise.withResolvers();
    execFile("git", args, { cwd, encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
        resolveResult(error ? undefined : stdout.trim() || undefined);
    });
    return promise;
}
async function findEntry(sourceDir) {
    for (const entry of ENTRY_FILES) {
        if (await access(join(sourceDir, entry)).then(() => true, () => false))
            return entry;
    }
    return null;
}
function readPluginName(id, source) {
    const name = PLUGIN_NAME_PATTERN.exec(source)?.[2];
    if (!name)
        throw new Error(`${id} must export definePlugin with a plain text name in index.ts or index.tsx.`);
    return name;
}
export async function loadCatalog(sourceRoot = SOURCE_ROOT) {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const plugins = [];
    const localCommit = await gitOutput(["rev-parse", "HEAD"], sourceRoot);
    const originMain = await gitOutput(["ls-remote", "origin", "refs/heads/main"], sourceRoot);
    const officialMain = originMain || resolve(sourceRoot) !== PACKAGE_ROOT
        ? undefined
        : await gitOutput(["ls-remote", REPOSITORY_URL, "refs/heads/main"], sourceRoot);
    const latestCommit = (originMain ?? officialMain)?.split(/\s+/)[0] ?? localCommit;
    const sourceCommit = localCommit ?? latestCommit;
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_") || RESERVED_DIRECTORIES[entry.name])
            continue;
        if (!INSTALL_FOLDER_PATTERN.test(entry.name))
            throw new Error(`${entry.name} is not a valid Vencord or Equicord plugin folder name.`);
        const sourceDir = join(sourceRoot, entry.name);
        const packagePath = join(sourceDir, "package.json");
        if (!await access(packagePath).then(() => true, () => false))
            continue;
        let packageJson;
        try {
            packageJson = JSON.parse(await readFile(packagePath, "utf8"));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not read ${entry.name}/package.json: ${message}`);
        }
        const entryFile = await findEntry(sourceDir);
        if (!entryFile)
            throw new Error(`${entry.name} must contain index.ts or index.tsx.`);
        const source = await readFile(join(sourceDir, entryFile), "utf8");
        const dependencies = typeof packageJson.dependencies === "object" && packageJson.dependencies !== null && !Array.isArray(packageJson.dependencies)
            ? Object.keys(packageJson.dependencies).sort()
            : [];
        plugins.push({
            id: entry.name,
            sourceDir,
            displayName: readPluginName(entry.name, source),
            installFolder: entry.name,
            dependencies,
            sourceCommit,
            latestCommit
        });
    }
    return plugins.sort((left, right) => left.displayName.localeCompare(right.displayName));
}
