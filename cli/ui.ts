import type { Key } from "node:readline";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { dirname, join } from "node:path";

import { Prompt } from "@clack/core";
import type { Option } from "@clack/prompts";
import {
    autocomplete,
    cancel,
    confirm,
    intro,
    isCancel,
    log,
    multiselect,
    note as clackNote,
    outro,
    select
} from "@clack/prompts";
import pc from "picocolors";

import type { Plugin } from "./catalog.ts";
import {
    discoverTargets,
    validateCheckout,
    type CheckoutTarget,
    type DiscoveryOptions
} from "./checkout.ts";
import type { PluginRecord } from "./manager.ts";

export type Command = "install" | "remove";


export type PromptOption<Value extends string = string> = Option<Value>;

export interface Output {
    write(message: string): unknown;
}


export interface Prompter {
    choose<Value extends string>(message: string, options: PromptOption<Value>[]): Promise<Value>;
    chooseTarget(targets: CheckoutTarget[]): Promise<string | null>;
    browseTarget(root: string): Promise<string>;
    selectMany<Value extends string>(message: string, options: PromptOption<Value>[]): Promise<Value[]>;
    confirm(message: string, defaultValue?: boolean): Promise<boolean>;
    info(message: string): void;
    success(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    note(message: string, title: string): void;
    writer(): Output;
    finish(message?: string): void;
    close(): void;
}

type TargetDiscovery = (options?: DiscoveryOptions) => Promise<CheckoutTarget[]>;

export async function locateTarget(
    prompter: Prompter,
    root = homedir(),
    discover: TargetDiscovery = discoverTargets
): Promise<string> {
    const method = await prompter.choose<"auto" | "manual">(
        "How would you like to find your Equicord or Vencord folder?",
        [
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
        ]
    );

    if (method === "manual") return prompter.browseTarget(root);

    prompter.info("Searching for local installations...");
    const discovered = await discover({ root });
    const foundMessage = `Found ${discovered.length} local installation${discovered.length === 1 ? "" : "s"}.`;
    if (discovered.length === 0) prompter.warn(foundMessage);
    else prompter.success(foundMessage);

    if (discovered.length === 0)
        prompter.note(
            "Choose the main folder where you downloaded and built Equicord or Vencord. It should contain a src folder and a package.json file.",
            "Choose the local build folder"
        );

    const selectedTarget = discovered.length > 0
        ? await prompter.chooseTarget(discovered)
        : null;
    return selectedTarget ?? prompter.browseTarget(root);
}

const BROWSE_VALUE = "\0browse";
const theme = {
    accent: pc.cyan,
    border: pc.gray,
    danger: pc.red,
    info: pc.blue,
    muted: pc.dim,
    success: pc.green
};


type LabelColors = Pick<typeof pc, "blue" | "yellow" | "cyan" | "dim" | "green">;
type PromptInput = Readable & { isTTY?: boolean };
type PromptOutput = Writable & { isTTY?: boolean; rows?: number };
type BrowserEntryKind = "current" | "parent" | "directory";

interface BrowserEntry {
    kind: BrowserEntryKind;
    name: string;
    path: string;
    target?: CheckoutTarget;
}

export class PromptCancelledError extends Error {
    constructor() {
        super("Installer closed.");
        this.name = "PromptCancelledError";
    }
}

class DirectoryBrowserPrompt extends Prompt<string> {
    currentDirectory: string;
    entries: BrowserEntry[] = [];
    browserCursor = 0;
    private submitSelected = false;

    constructor(message: string, root: string, input: Readable, output: Writable) {
        super({
            input,
            output,
            render() {
                const prompt = this as unknown as DirectoryBrowserPrompt;
                const titleSymbol = prompt.state === "submit"
                    ? theme.success("◇")
                    : prompt.state === "cancel"
                        ? theme.danger("■")
                        : theme.accent("◆");
                const header = `${theme.border("│")}\n${titleSymbol}  ${message}\n${theme.border("│")}  ${theme.muted(prompt.currentDirectory)}`;

                if (prompt.state === "submit")
                    return `${header}\n${theme.border("└")}  ${theme.success(prompt.value ?? prompt.currentDirectory)}`;
                if (prompt.state === "cancel")
                    return `${header}\n${theme.border("└")}  ${pc.strikethrough(theme.muted("Cancelled"))}`;

                const rows = "rows" in output && typeof output.rows === "number" ? output.rows : 20;
                const maxItems = Math.max(5, Math.min(12, rows - 8));
                const start = Math.max(0, Math.min(
                    prompt.browserCursor - Math.floor(maxItems / 2),
                    Math.max(0, prompt.entries.length - maxItems)
                ));
                const visible = prompt.entries.slice(start, start + maxItems);
                const renderedEntries = visible.map((entry, index) => {
                    const active = start + index === prompt.browserCursor;
                    const pointer = active ? theme.accent("›") : " ";
                    const directoryName = entry.kind === "current"
                        ? "Use this folder"
                        : entry.kind === "parent"
                            ? "../"
                            : `${entry.name}/`;
                    const name = active ? theme.accent(directoryName) : directoryName;
                    const targetHint = entry.target
                        ? theme.info(`${entry.target.client === "equicord" ? "Equicord" : "Vencord"} local build${entry.target.version ? ` · ${entry.target.version}` : ""}`)
                        : "";
                    return `${theme.border("│")}  ${pointer} ${name}${targetHint ? `  ${targetHint}` : ""}`;
                });

                if (renderedEntries.length === 0)
                    renderedEntries.push(`${theme.border("│")}    ${theme.muted("No folders can be opened here")}`);

                return `${header}\n${renderedEntries.join("\n")}\n${theme.border("└")}  ${theme.muted("↑↓ move · → open · ← back · enter choose/open · esc cancel")}`;
            }
        }, false);

        this.currentDirectory = realpathSync(root);
        this.reload();
        this.on("cursor", key => {
            if (this.entries.length === 0) return;
            if (key === "up") this.browserCursor = (this.browserCursor - 1 + this.entries.length) % this.entries.length;
            else if (key === "down") this.browserCursor = (this.browserCursor + 1) % this.entries.length;
            else if (key === "left") this.navigate(dirname(this.currentDirectory));
            else if (key === "right") this.openSelected();
        });
        this.on("key", (_char, key) => {
            if (key.name === "return" || key.name === "enter") this.activateSelected();
        });
    }

    protected override _shouldSubmit(_char: string | undefined, _key: Key): boolean {
        return this.submitSelected;
    }

    private reload(): void {
        const entries: BrowserEntry[] = [];
        const currentTarget = validateCheckout(this.currentDirectory).target;
        if (currentTarget)
            entries.push({ kind: "current", name: "Use this folder", path: this.currentDirectory, target: currentTarget });

        const parent = dirname(this.currentDirectory);
        if (parent !== this.currentDirectory)
            entries.push({ kind: "parent", name: "..", path: parent });

        try {
            const directories = readdirSync(this.currentDirectory, { withFileTypes: true })
                .filter(entry => {
                    if (entry.isDirectory()) return true;
                    if (!entry.isSymbolicLink()) return false;
                    try {
                        return statSync(join(this.currentDirectory, entry.name)).isDirectory();
                    } catch {
                        return false;
                    }
                })
                .map(entry => {
                    const path = join(this.currentDirectory, entry.name);
                    return {
                        kind: "directory" as const,
                        name: entry.name,
                        path,
                        target: validateCheckout(path).target
                    };
                })
                .sort((left, right) => {
                    if (left.target && !right.target) return -1;
                    if (!left.target && right.target) return 1;
                    if (left.name.startsWith(".") !== right.name.startsWith(".")) return left.name.startsWith(".") ? 1 : -1;
                    return left.name.localeCompare(right.name);
                });
            entries.push(...directories);
        } catch {}

        this.entries = entries;
        this.browserCursor = Math.min(this.browserCursor, Math.max(0, entries.length - 1));
    }

    private navigate(path: string): void {
        try {
            this.currentDirectory = realpathSync(path);
            this.browserCursor = 0;
            this.reload();
        } catch {}
    }

    private openSelected(): void {
        const selected = this.entries[this.browserCursor];
        if (selected?.kind !== "current") this.navigate(selected.path);
    }

    private activateSelected(): void {
        const selected = this.entries[this.browserCursor];
        if (!selected) return;
        if (selected.target) {
            this._setValue(selected.target.root);
            this.submitSelected = true;
        } else {
            this.navigate(selected.path);
        }
    }
}


export function pluginLabel(plugin: Plugin, record?: PluginRecord, colors: LabelColors = pc): string {
    const name = plugin.displayName;
    if (!record) return `${name} — ${colors.blue("Not installed")}`;
    if (record.mode === "link") return `${name} — ${colors.cyan("Linked development copy")}`;

    const latestCommit = plugin.latestCommit ?? plugin.sourceCommit;
    const shortInstalledCommit = record.sourceCommit?.slice(0, 7);
    const shortLatestCommit = latestCommit?.slice(0, 7);
    if (!record.sourceCommit && latestCommit)
        return `${name} — ${colors.yellow("Update check needed")} · ${colors.blue(shortLatestCommit)}`;
    if (record.sourceCommit && latestCommit && record.sourceCommit !== latestCommit) {
        if (plugin.sourceCommit && plugin.sourceCommit !== latestCommit)
            return `${name} — ${colors.yellow("Newer commit on main")} · ${colors.blue(shortLatestCommit)} · ${colors.dim("update this folder first")}`;
        return `${name} — ${colors.yellow("Update available")} · ${colors.dim(shortInstalledCommit)} ${colors.dim("→")} ${colors.green(shortLatestCommit)}`;
    }

    return shortInstalledCommit
        ? `${name} — ${colors.green("Installed")} · ${colors.dim(shortInstalledCommit)}`
        : `${name} — ${colors.green("Installed")}`;
}

function unwrap<Value>(value: Value | symbol | undefined, promptOptions: { input: Readable; output: Writable }): Value {
    if (value !== undefined && !isCancel(value)) return value as Value;
    cancel("Closed — no files were changed.", promptOptions);
    throw new PromptCancelledError();
}

export function createPrompter(input: PromptInput = process.stdin, output: PromptOutput = process.stdout): Prompter {
    if (!input.isTTY || !output.isTTY)
        throw new Error("This installer needs an interactive terminal. Run it directly in a terminal window.");

    const promptOptions = { input, output };
    let finished = false;
    intro("StraiF Plugins", promptOptions);

    return {
        async choose<Value extends string>(message: string, options: PromptOption<Value>[]): Promise<Value> {
            return unwrap(await select({ message, options, ...promptOptions }), promptOptions);
        },

        async chooseTarget(targets: CheckoutTarget[]): Promise<string | null> {
            const value = unwrap(await autocomplete({
                message: "Choose your Equicord or Vencord folder",
                options: [
                    ...targets.map(target => ({
                        value: target.root,
                        label: `${target.client === "equicord" ? "Equicord" : "Vencord"}${target.version ? ` · ${target.version}` : ""}`,
                        hint: target.root
                    })),
                    {
                        value: BROWSE_VALUE,
                        label: "Choose a different folder",
                        hint: "Open the folder picker"
                    }
                ],
                ...promptOptions
            }), promptOptions);
            return value === BROWSE_VALUE ? null : value;
        },

        async browseTarget(root: string): Promise<string> {
            const prompt = new DirectoryBrowserPrompt(
                "Choose your Equicord or Vencord folder",
                root,
                input,
                output
            );
            return unwrap(await prompt.prompt(), promptOptions);
        },

        async selectMany<Value extends string>(message: string, options: PromptOption<Value>[]): Promise<Value[]> {
            if (options.length === 0) return [];
            return unwrap(await multiselect({
                message,
                options,
                required: false,
                ...promptOptions
            }), promptOptions);
        },

        async confirm(message: string, defaultValue = false): Promise<boolean> {
            return unwrap(await confirm({
                message,
                initialValue: defaultValue,
                ...promptOptions
            }), promptOptions);
        },

        info(message: string): void {
            log.info(message, { output });
        },

        success(message: string): void {
            log.success(message, { output });
        },

        warn(message: string): void {
            log.warn(message, { output });
        },

        error(message: string): void {
            log.error(message, { output });
        },

        note(message: string, title: string): void {
            clackNote(message, title, { output });
        },

        writer(): Output {
            return {
                write(message: string): void {
                    const rendered = message.trim();
                    if (rendered) log.message(rendered, { output });
                }
            };
        },

        finish(message = "Done."): void {
            if (finished) return;
            finished = true;
            outro(message, promptOptions);
        },

        close(): void {}
    };
}
