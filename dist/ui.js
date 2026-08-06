import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Prompt } from "@clack/core";
import { autocomplete, cancel, confirm, intro, isCancel, log, multiselect, note as clackNote, outro, select } from "@clack/prompts";
import pc from "picocolors";
import { discoverTargets, validateCheckout } from "./checkout.js";
export async function locateTarget(prompter, root = homedir(), discover = discoverTargets) {
    const method = await prompter.choose("How would you like to find your Equicord or Vencord folder?", [
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
    if (method === "manual")
        return prompter.browseTarget(root);
    prompter.info("Searching for local installations...");
    const discovered = await discover({ root });
    const foundMessage = `Found ${discovered.length} local installation${discovered.length === 1 ? "" : "s"}.`;
    if (discovered.length === 0)
        prompter.warn(foundMessage);
    else
        prompter.success(foundMessage);
    if (discovered.length === 0)
        prompter.note("Choose the main folder where you downloaded and built Equicord or Vencord. It should contain a src folder and a package.json file.", "Choose the local build folder");
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
export class PromptCancelledError extends Error {
    constructor() {
        super("Installer closed.");
        this.name = "PromptCancelledError";
    }
}
class DirectoryBrowserPrompt extends Prompt {
    currentDirectory;
    entries = [];
    browserCursor = 0;
    submitSelected = false;
    constructor(message, root, input, output) {
        super({
            input,
            output,
            render() {
                const prompt = this;
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
                const start = Math.max(0, Math.min(prompt.browserCursor - Math.floor(maxItems / 2), Math.max(0, prompt.entries.length - maxItems)));
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
            if (this.entries.length === 0)
                return;
            if (key === "up")
                this.browserCursor = (this.browserCursor - 1 + this.entries.length) % this.entries.length;
            else if (key === "down")
                this.browserCursor = (this.browserCursor + 1) % this.entries.length;
            else if (key === "left")
                this.navigate(dirname(this.currentDirectory));
            else if (key === "right")
                this.openSelected();
        });
        this.on("key", (_char, key) => {
            if (key.name === "return" || key.name === "enter")
                this.activateSelected();
        });
    }
    _shouldSubmit(_char, _key) {
        return this.submitSelected;
    }
    reload() {
        const entries = [];
        const currentTarget = validateCheckout(this.currentDirectory).target;
        if (currentTarget)
            entries.push({ kind: "current", name: "Use this folder", path: this.currentDirectory, target: currentTarget });
        const parent = dirname(this.currentDirectory);
        if (parent !== this.currentDirectory)
            entries.push({ kind: "parent", name: "..", path: parent });
        try {
            const directories = readdirSync(this.currentDirectory, { withFileTypes: true })
                .filter(entry => {
                if (entry.isDirectory())
                    return true;
                if (!entry.isSymbolicLink())
                    return false;
                try {
                    return statSync(join(this.currentDirectory, entry.name)).isDirectory();
                }
                catch {
                    return false;
                }
            })
                .map(entry => {
                const path = join(this.currentDirectory, entry.name);
                return {
                    kind: "directory",
                    name: entry.name,
                    path,
                    target: validateCheckout(path).target
                };
            })
                .sort((left, right) => {
                if (left.target && !right.target)
                    return -1;
                if (!left.target && right.target)
                    return 1;
                if (left.name.startsWith(".") !== right.name.startsWith("."))
                    return left.name.startsWith(".") ? 1 : -1;
                return left.name.localeCompare(right.name);
            });
            entries.push(...directories);
        }
        catch { }
        this.entries = entries;
        this.browserCursor = Math.min(this.browserCursor, Math.max(0, entries.length - 1));
    }
    navigate(path) {
        try {
            this.currentDirectory = realpathSync(path);
            this.browserCursor = 0;
            this.reload();
        }
        catch { }
    }
    openSelected() {
        const selected = this.entries[this.browserCursor];
        if (selected?.kind !== "current")
            this.navigate(selected.path);
    }
    activateSelected() {
        const selected = this.entries[this.browserCursor];
        if (!selected)
            return;
        if (selected.target) {
            this._setValue(selected.target.root);
            this.submitSelected = true;
        }
        else {
            this.navigate(selected.path);
        }
    }
}
export function pluginLabel(plugin, record, colors = pc) {
    const name = plugin.displayName;
    if (!record)
        return `${name} — ${colors.blue("Not installed")}`;
    if (record.mode === "link")
        return `${name} — ${colors.cyan("Linked development copy")}`;
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
function unwrap(value, promptOptions) {
    if (value !== undefined && !isCancel(value))
        return value;
    cancel("Closed — no files were changed.", promptOptions);
    throw new PromptCancelledError();
}
export function createPrompter(input = process.stdin, output = process.stdout) {
    if (!input.isTTY || !output.isTTY)
        throw new Error("This installer needs an interactive terminal. Run it directly in a terminal window.");
    const promptOptions = { input, output };
    let finished = false;
    intro("StraiF Plugins", promptOptions);
    return {
        async choose(message, options) {
            return unwrap(await select({ message, options, ...promptOptions }), promptOptions);
        },
        async chooseTarget(targets) {
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
        async browseTarget(root) {
            const prompt = new DirectoryBrowserPrompt("Choose your Equicord or Vencord folder", root, input, output);
            return unwrap(await prompt.prompt(), promptOptions);
        },
        async selectMany(message, options) {
            if (options.length === 0)
                return [];
            return unwrap(await multiselect({
                message,
                options,
                required: false,
                ...promptOptions
            }), promptOptions);
        },
        async confirm(message, defaultValue = false) {
            return unwrap(await confirm({
                message,
                initialValue: defaultValue,
                ...promptOptions
            }), promptOptions);
        },
        info(message) {
            log.info(message, { output });
        },
        success(message) {
            log.success(message, { output });
        },
        warn(message) {
            log.warn(message, { output });
        },
        error(message) {
            log.error(message, { output });
        },
        note(message, title) {
            clackNote(message, title, { output });
        },
        writer() {
            return {
                write(message) {
                    const rendered = message.trim();
                    if (rendered)
                        log.message(rendered, { output });
                }
            };
        },
        finish(message = "Done.") {
            if (finished)
                return;
            finished = true;
            outro(message, promptOptions);
        },
        close() { }
    };
}
