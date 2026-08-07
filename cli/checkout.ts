import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";

// Checkout model

interface Output {
    write(message: string): unknown;
}

interface ClientManifest {
    name?: unknown;
    version?: unknown;
    scripts?: {
        build?: unknown;
        inject?: unknown;
    };
}

export type CheckoutClient = "equicord" | "vencord";

export interface CheckoutTarget {
    client: CheckoutClient;
    root: string;
    version?: string;
}

export interface DiscoveryOptions {
    root?: string;
    timeoutMs?: number;
    maxDepth?: number;
}

interface CheckoutValidation {
    target?: CheckoutTarget;
    error?: string;
}

// Discovery configuration

const DISCOVERY_SKIP_NAMES: Record<string, true> = {
    ".git": true,
    ".cache": true,
    ".pnpm": true,
    ".venv": true,
    __pycache__: true,
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

// Path expansion and validation

function expandHome(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
    return path;
}

export function validateCheckout(path: string): CheckoutValidation {
    const absolute = resolve(expandHome(path));
    let root: string;
    let manifest: ClientManifest;

    try {
        root = realpathSync(absolute);
        manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as ClientManifest;
    } catch {
        return { error: `I couldn't read package.json in this folder: ${absolute}` };
    }

    if (manifest.name !== "equicord" && manifest.name !== "vencord")
        return { error: `That isn't the folder where Equicord or Vencord was downloaded and built: ${root}` };

    try {
        if (!statSync(join(root, "src")).isDirectory())
            return {
                error: `That folder is missing src. Make sure you chose the main Equicord or Vencord folder: ${root}`
            };
    } catch {
        return {
            error: `That folder is missing src. Make sure you chose the main Equicord or Vencord folder: ${root}`
        };
    }

    if (typeof manifest.scripts?.build !== "string" || typeof manifest.scripts.inject !== "string")
        return {
            error: `That doesn't look like a complete local Equicord or Vencord build. Make sure you selected its main folder: ${root}`
        };

    return {
        target: {
            client: manifest.name,
            root,
            version: typeof manifest.version === "string" ? manifest.version : undefined
        }
    };
}

// Automatic checkout discovery

async function discoverWithRipgrep(searchRoot: string, timeoutMs: number, maxDepth: number): Promise<CheckoutTarget[]> {
    const args = [
        "--no-config",
        "--files",
        "--hidden",
        "--no-ignore",
        "--no-messages",
        "--null",
        "--glob",
        "package.json"
    ];
    for (const name of Object.keys(DISCOVERY_SKIP_NAMES)) args.push("--glob", `!**/${name}/**`);
    for (const prefix of DISCOVERY_SKIP_PREFIXES) args.push("--glob", `!${prefix}/**`);
    if (Number.isFinite(maxDepth)) args.push("--max-depth", String(Math.max(0, Math.ceil(maxDepth)) + 1));

    const targets = new Map<string, CheckoutTarget>();
    let timedOut = false;

    try {
        await new Promise<void>((resolveSearch, reject) => {
            const child = spawn(rgPath, args, {
                cwd: searchRoot,
                stdio: ["ignore", "pipe", "ignore"]
            });
            let pending = "";

            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                const paths = `${pending}${chunk}`.split("\0");
                pending = paths.pop() ?? "";
                for (const path of paths) {
                    const validation = validateCheckout(dirname(resolve(searchRoot, path)));
                    if (validation.target) targets.set(validation.target.root, validation.target);
                }
            });

            const timer = Number.isFinite(timeoutMs)
                ? setTimeout(
                      () => {
                          timedOut = true;
                          child.kill();
                      },
                      Math.max(0, timeoutMs)
                  )
                : undefined;
            child.once("error", error => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("close", () => {
                clearTimeout(timer);
                resolveSearch();
            });
        });
    } catch {
        return [];
    }

    return timedOut ? [] : [...targets.values()];
}

// Public checkout operations

export async function discoverTargets({
    root = homedir(),
    timeoutMs = 10_000,
    maxDepth = Number.POSITIVE_INFINITY
}: DiscoveryOptions = {}): Promise<CheckoutTarget[]> {
    const searchRoot = resolve(root);
    const targets = await discoverWithRipgrep(searchRoot, timeoutMs, maxDepth);
    return targets.sort(
        (left, right) => left.client.localeCompare(right.client) || left.root.localeCompare(right.root)
    );
}

export async function resolveTarget(target: string): Promise<string> {
    if (!target) throw new Error("Choose the folder where Equicord or Vencord was downloaded and built.");
    const validation = validateCheckout(target);
    if (!validation.target)
        throw new Error(validation.error ?? "That isn't a valid local Equicord or Vencord build folder.");
    return join(validation.target.root, "src", "userplugins");
}

export async function ensureTarget(userpluginsDir: string): Promise<string> {
    await mkdir(userpluginsDir, { recursive: true });
    return realpath(userpluginsDir);
}

export async function buildTarget(targetRoot: string, output: Output = process.stdout): Promise<void> {
    const executable = process.env.STRAIF_PNPM || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    output.write("Applying the plugin changes...\n");

    await new Promise<void>((resolveBuild, reject) => {
        const child = spawn(executable, ["build"], {
            cwd: targetRoot,
            stdio: "inherit"
        });
        child.once("error", error =>
            reject(
                (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? new Error("pnpm was not found. Finish setting up Equicord or Vencord, then try again.")
                    : error
            )
        );
        child.once("close", code =>
            code === 0
                ? resolveBuild()
                : reject(
                      new Error(
                          `Equicord or Vencord could not apply the changes. The build tool stopped with code ${code}.`
                      )
                  )
        );
    });

    output.write("Plugin changes applied.\n");
}
