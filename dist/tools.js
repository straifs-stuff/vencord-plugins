import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise as openZip } from "yauzl";
// HandBrake release and provider configuration
const HANDBRAKE_VERSION = "1.11.2";
const HANDBRAKE_DOWNLOAD_PAGE = "https://handbrake.fr/downloads2.php";
const HANDBRAKE_FLATPAK_ID = "fr.handbrake.ghb";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const FLATHUB_REPOSITORY = "https://flathub.org/repo/flathub.flatpakrepo";
const HANDBRAKE_ASSETS = {
    "darwin-arm64": {
        archive: "dmg",
        fileName: `HandBrakeCLI-${HANDBRAKE_VERSION}.dmg`,
        sha256: "14463aa81038aaa3ce421dc6cee65fd6c82fdabda040931541ccca38939299fa",
        url: `https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrakeCLI-${HANDBRAKE_VERSION}.dmg`
    },
    "darwin-x64": {
        archive: "dmg",
        fileName: `HandBrakeCLI-${HANDBRAKE_VERSION}.dmg`,
        sha256: "14463aa81038aaa3ce421dc6cee65fd6c82fdabda040931541ccca38939299fa",
        url: `https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrakeCLI-${HANDBRAKE_VERSION}.dmg`
    },
    "win32-arm64": {
        archive: "zip",
        fileName: `HandBrakeCLI-${HANDBRAKE_VERSION}-win-aarch64.zip`,
        sha256: "708ac040bf1ca41d46dbe5f355b588863d60366a67072a974e6829c314ac060d",
        url: `https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrakeCLI-${HANDBRAKE_VERSION}-win-aarch64.zip`
    },
    "win32-x64": {
        archive: "zip",
        fileName: `HandBrakeCLI-${HANDBRAKE_VERSION}-win-x86_64.zip`,
        sha256: "80bfe8d5f5d11cc3ef76b834add3ed4e82dee6523ffeb435c283f88b1a21f09d",
        url: `https://github.com/HandBrake/HandBrake/releases/download/${HANDBRAKE_VERSION}/HandBrakeCLI-${HANDBRAKE_VERSION}-win-x86_64.zip`
    }
};
// Platform paths and process execution
function defaultToolRoot(env, platform) {
    const home = homedir();
    if (platform === "win32")
        return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "straif-plugins", "tools");
    if (platform === "darwin")
        return join(home, "Library", "Application Support", "straif-plugins", "tools");
    return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "straif-plugins", "tools");
}
export function handBrakeResolutionPath(toolRoot) {
    return join(toolRoot, "handbrake-cli", "resolution.json");
}
export function handBrakeAsset(platform, arch) {
    return HANDBRAKE_ASSETS[`${platform}-${arch}`];
}
function managedExecutablePath(toolRoot, platform, arch) {
    const executable = platform === "win32" ? "HandBrakeCLI.exe" : "HandBrakeCLI";
    return join(toolRoot, "handbrake-cli", HANDBRAKE_VERSION, `${platform}-${arch}`, executable);
}
async function defaultRun(command, args, options = {}) {
    const { promise, resolve, reject } = Promise.withResolvers();
    const child = spawn(command, args, {
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    const timeout = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
    if (!options.inherit) {
        child.stdout?.on("data", chunk => stdout.push(Buffer.from(chunk)));
        child.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk)));
    }
    child.once("error", error => {
        clearTimeout(timeout);
        reject(error);
    });
    child.once("close", code => {
        clearTimeout(timeout);
        resolve({
            code: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8")
        });
    });
    return promise;
}
async function findExecutableOnPath(env, platform, names) {
    for (const directory of (env.PATH || "").split(delimiter)) {
        const cleanDirectory = directory.replace(/^"|"$/g, "");
        if (!cleanDirectory)
            continue;
        for (const name of names) {
            const path = join(cleanDirectory, name);
            try {
                if (!(await stat(path)).isFile())
                    continue;
                return await realpath(path);
            }
            catch { }
        }
    }
    return undefined;
}
// HandBrake discovery and probing
function parseVersion(output) {
    return /(?:HandBrakeCLI|HandBrake)\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)?.[1];
}
async function probeHandBrake(resolution, run) {
    let result;
    try {
        result = await run(resolution.command, [...resolution.argsPrefix, "--version"], { timeoutMs: 15_000 });
    }
    catch {
        return undefined;
    }
    if (result.code !== 0)
        return undefined;
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    return version ? { ...resolution, version } : undefined;
}
// Resolution persistence and download verification
async function writeResolution(toolRoot, resolution) {
    const path = handBrakeResolutionPath(toolRoot);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(resolution, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
}
async function downloadVerified(url, destination, expectedSha256, fetchImpl) {
    const response = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok || !response.body)
        throw new Error(`The HandBrake download failed with HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES)
        throw new Error("The HandBrake download was larger than expected.");
    let byteCount = 0;
    const hash = createHash("sha256");
    const verifier = new Transform({
        transform(chunk, _encoding, callback) {
            byteCount += chunk.length;
            if (byteCount > MAX_DOWNLOAD_BYTES) {
                callback(new Error("The HandBrake download was larger than expected."));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        }
    });
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256)
        throw new Error("The downloaded HandBrake package did not match its trusted SHA-256 checksum.");
}
// Platform archive extraction
async function findNamedFile(directory, expectedName) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isFile() && entry.name === expectedName)
            return path;
        if (entry.isDirectory()) {
            const nested = await findNamedFile(path, expectedName);
            if (nested)
                return nested;
        }
    }
    return undefined;
}
export async function extractWindowsArchive(archive, payload) {
    const zip = await openZip(archive, {
        autoClose: false,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true
    });
    try {
        for await (const entry of zip.eachEntry()) {
            if (entry.fileName !== "HandBrakeCLI.exe")
                continue;
            if (!entry.canDecodeFileData() || entry.isEncrypted())
                throw new Error("The HandBrakeCLI archive entry uses an unsupported ZIP format.");
            if (entry.uncompressedSize > MAX_DOWNLOAD_BYTES)
                throw new Error("The extracted HandBrakeCLI executable was larger than expected.");
            let byteCount = 0;
            const limiter = new Transform({
                transform(chunk, _encoding, callback) {
                    byteCount += chunk.length;
                    if (byteCount > MAX_DOWNLOAD_BYTES) {
                        callback(new Error("The extracted HandBrakeCLI executable was larger than expected."));
                        return;
                    }
                    callback(null, chunk);
                }
            });
            await pipeline(await zip.openReadStreamPromise(entry), limiter, createWriteStream(payload, { flags: "wx", mode: 0o755 }));
            await chmod(payload, 0o755);
            return payload;
        }
    }
    finally {
        zip.close();
    }
    throw new Error("The HandBrake archive did not contain HandBrakeCLI.exe.");
}
async function extractMacArchive(archive, payload, run) {
    const mountPoint = join(dirname(dirname(payload)), "mount");
    await mkdir(mountPoint);
    const attached = await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, archive], {
        timeoutMs: 120_000
    });
    if (attached.code !== 0)
        throw new Error(`The HandBrake disk image could not be mounted: ${attached.stderr.trim() || "hdiutil failed"}`);
    try {
        const executable = await findNamedFile(mountPoint, "HandBrakeCLI");
        if (!executable)
            throw new Error("The HandBrake disk image did not contain HandBrakeCLI.");
        await copyFile(executable, payload);
        await chmod(payload, 0o755);
        return payload;
    }
    finally {
        await run("hdiutil", ["detach", mountPoint], { timeoutMs: 60_000 }).catch(() => undefined);
    }
}
// Portable HandBrake installation
async function installManagedHandBrake({ asset, platform, arch, toolRoot, fetchImpl, run }) {
    const finalExecutable = managedExecutablePath(toolRoot, platform, arch);
    const finalDirectory = dirname(finalExecutable);
    const parent = dirname(finalDirectory);
    await mkdir(parent, { recursive: true });
    const lockPath = join(toolRoot, "handbrake-cli", ".install.lock");
    let lock;
    try {
        lock = await open(lockPath, "wx", 0o600);
    }
    catch (error) {
        if (error.code === "EEXIST")
            throw new Error("Another HandBrake installation is already in progress.");
        throw error;
    }
    const temporaryRoot = await mkdtemp(join(parent, ".handbrake-install-"));
    const archive = join(temporaryRoot, asset.fileName);
    const payloadDirectory = join(temporaryRoot, "payload");
    const payload = join(payloadDirectory, basename(finalExecutable));
    let backup;
    try {
        await mkdir(payloadDirectory);
        await downloadVerified(asset.url, archive, asset.sha256, fetchImpl);
        if (asset.archive === "zip")
            await extractWindowsArchive(archive, payload);
        else
            await extractMacArchive(archive, payload, run);
        const stagedResolution = await probeHandBrake({
            id: "handbrake-cli",
            provider: "managed",
            command: payload,
            argsPrefix: []
        }, run);
        if (!stagedResolution)
            throw new Error("The downloaded HandBrakeCLI executable could not be started.");
        const finalDirectoryExists = await stat(finalDirectory).then(() => true, () => false);
        if (finalDirectoryExists) {
            backup = `${finalDirectory}.backup-${process.pid}`;
            await rename(finalDirectory, backup);
        }
        try {
            await rename(payloadDirectory, finalDirectory);
        }
        catch (error) {
            if (backup)
                await rename(backup, finalDirectory);
            throw error;
        }
        if (backup)
            await rm(backup, { recursive: true, force: true });
        return {
            ...stagedResolution,
            command: finalExecutable
        };
    }
    finally {
        await lock.close();
        await rm(lockPath, { force: true });
        await rm(temporaryRoot, { recursive: true, force: true });
    }
}
// Linux Flatpak integration
async function resolveFlatpak(flatpak, run) {
    const installed = await run(flatpak, ["info", HANDBRAKE_FLATPAK_ID], { timeoutMs: 15_000 });
    if (installed.code !== 0)
        return undefined;
    return probeHandBrake({
        id: "handbrake-cli",
        provider: "flatpak",
        command: flatpak,
        argsPrefix: ["run", "--command=HandBrakeCLI", HANDBRAKE_FLATPAK_ID]
    }, run);
}
// Provider selection
async function ensureHandBrake(options) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const env = options.env ?? process.env;
    const fetchImpl = options.fetchImpl ?? fetch;
    const run = options.run ?? defaultRun;
    const toolRoot = options.toolRoot ?? defaultToolRoot(env, platform);
    const commandName = platform === "win32" ? "HandBrakeCLI.exe" : "HandBrakeCLI";
    const pathCommand = await findExecutableOnPath(env, platform, [commandName]);
    if (pathCommand) {
        const resolution = await probeHandBrake({
            id: "handbrake-cli",
            provider: "path",
            command: pathCommand,
            argsPrefix: []
        }, run);
        if (resolution) {
            await writeResolution(toolRoot, resolution);
            return resolution;
        }
    }
    const managedCommand = managedExecutablePath(toolRoot, platform, arch);
    const managed = await probeHandBrake({
        id: "handbrake-cli",
        provider: "managed",
        command: managedCommand,
        argsPrefix: []
    }, run);
    if (managed) {
        await writeResolution(toolRoot, managed);
        return managed;
    }
    if (platform === "linux") {
        const flatpak = await findExecutableOnPath(env, platform, ["flatpak"]);
        if (!flatpak)
            throw new Error(`HandBrakeCLI was not found. Install Flatpak for your Linux distribution, then run this installer again. ${HANDBRAKE_DOWNLOAD_PAGE}`);
        const existingFlatpak = await resolveFlatpak(flatpak, run);
        if (existingFlatpak) {
            await writeResolution(toolRoot, existingFlatpak);
            return existingFlatpak;
        }
        const accepted = await options.confirmInstall("MediaCompress requires HandBrakeCLI. Add the official Flathub repository and install HandBrake for your user account?");
        if (!accepted)
            return undefined;
        const addRemote = await run(flatpak, ["--user", "remote-add", "--if-not-exists", "flathub", FLATHUB_REPOSITORY], { inherit: true, timeoutMs: 120_000 });
        if (addRemote.code !== 0)
            throw new Error("The official Flathub repository could not be configured for your user account.");
        const install = await run(flatpak, ["--user", "install", "--noninteractive", "flathub", HANDBRAKE_FLATPAK_ID], {
            inherit: true,
            timeoutMs: 1_800_000
        });
        if (install.code !== 0)
            throw new Error(`The HandBrake Flatpak could not be installed. Install it manually from: ${HANDBRAKE_DOWNLOAD_PAGE}`);
        const resolution = await resolveFlatpak(flatpak, run);
        if (!resolution)
            throw new Error("The HandBrake Flatpak was installed but HandBrakeCLI could not be started.");
        await writeResolution(toolRoot, resolution);
        return resolution;
    }
    const asset = handBrakeAsset(platform, arch);
    if (!asset)
        throw new Error(`There is no supported portable HandBrakeCLI package for ${platform}-${arch}. Install HandBrakeCLI manually and place it on PATH: ${HANDBRAKE_DOWNLOAD_PAGE}`);
    const accepted = await options.confirmInstall(`MediaCompress requires HandBrakeCLI. Download the official HandBrakeCLI ${HANDBRAKE_VERSION} package into this private per-user folder? ${toolRoot}`);
    if (!accepted)
        return undefined;
    const resolution = await installManagedHandBrake({ asset, platform, arch, toolRoot, fetchImpl, run });
    await writeResolution(toolRoot, resolution);
    return resolution;
}
// Public tool orchestration API
export async function ensurePluginTools(options) {
    const requestedTools = new Set(options.plugins.flatMap(plugin => plugin.tools));
    for (const tool of requestedTools) {
        if (tool !== "handbrake-cli")
            throw new Error(`The selected plugins require an unsupported native tool: ${tool}`);
    }
    if (!requestedTools.has("handbrake-cli"))
        return { ready: options.plugins, skipped: [] };
    let resolution;
    try {
        resolution = await ensureHandBrake(options);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.output?.write(`HandBrakeCLI could not be prepared: ${message}\n`);
    }
    if (resolution) {
        options.output?.write(`Using HandBrakeCLI ${resolution.version} via ${resolution.provider}.\n`);
        return { ready: options.plugins, skipped: [] };
    }
    const ready = options.plugins.filter(plugin => !plugin.tools.includes("handbrake-cli"));
    const skipped = options.plugins.filter(plugin => plugin.tools.includes("handbrake-cli")).map(plugin => plugin.id);
    for (const plugin of options.plugins) {
        if (plugin.tools.includes("handbrake-cli"))
            options.output?.write(`${plugin.displayName} was skipped because HandBrakeCLI was not installed.\n`);
    }
    return { ready, skipped };
}
export async function readHandBrakeResolution(toolRoot) {
    try {
        const value = JSON.parse(await readFile(handBrakeResolutionPath(toolRoot), "utf8"));
        if (value.id !== "handbrake-cli" ||
            (value.provider !== "path" && value.provider !== "managed" && value.provider !== "flatpak") ||
            typeof value.command !== "string" ||
            !Array.isArray(value.argsPrefix) ||
            value.argsPrefix.some(argument => typeof argument !== "string") ||
            typeof value.version !== "string")
            return undefined;
        return value;
    }
    catch {
        return undefined;
    }
}
