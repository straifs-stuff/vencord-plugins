#!/usr/bin/env node
import { resolve } from "node:path";
import { loadCatalog, prepareCatalogSource } from "./catalog.js";
import { buildTarget, ensureTarget, resolveTarget } from "./checkout.js";
import { loadRegistry, removePlugins, syncPlugins } from "./manager.js";
import { ensurePluginTools } from "./tools.js";
import { createPrompter, locateTarget, pluginLabel, PromptCancelledError } from "./ui.js";
// Plugin selection
async function selectPlugins(command, catalog, registry, prompter) {
    if (command === "remove") {
        const ids = Object.keys(registry.plugins);
        return prompter.selectMany("Choose plugins to remove", ids.map(id => {
            const record = registry.plugins[id];
            const commit = record.sourceCommit?.slice(0, 7);
            return {
                value: id,
                label: record.displayName ?? id,
                hint: record.mode === "link"
                    ? "Linked development copy"
                    : commit
                        ? `Installed · ${commit}`
                        : "Installed"
            };
        }));
    }
    const values = await prompter.selectMany("Choose plugins to add or update", catalog.map(plugin => ({
        value: plugin.id,
        label: pluginLabel(plugin, registry.plugins[plugin.id])
    })));
    const selected = new Set(values);
    return catalog.filter(plugin => selected.has(plugin.id));
}
// Main installer workflow
async function main() {
    const prompter = createPrompter();
    let cleanupCatalog = async () => { };
    try {
        prompter.note("This installer needs the folder where you downloaded and built\nEquicord or Vencord. It cannot add plugins to a copy installed\nwith the normal installer.\n\nIf you have not built your client on this computer yet, follow\nits guide through the `pnpm inject` step, then return here.\n\nEquicord  https://docs.equicord.org/building-from-source\nVencord   https://docs.vencord.dev/installing/", "A locally built copy of Equicord or Vencord is required");
        const target = await locateTarget(prompter);
        const catalogSource = await prepareCatalogSource();
        cleanupCatalog = catalogSource.cleanup;
        const catalog = await loadCatalog(catalogSource.root);
        const userpluginsDir = await ensureTarget(await resolveTarget(target));
        const targetRoot = resolve(userpluginsDir, "../..");
        const registry = await loadRegistry(userpluginsDir);
        const command = await prompter.choose("What would you like to do?", [
            { label: "Add or update plugins", value: "install", hint: "Install missing plugins and update older ones" },
            { label: "Remove plugins", value: "remove", hint: "Remove plugins added by this installer" }
        ]);
        if (command === "remove" && Object.keys(registry.plugins).length === 0) {
            prompter.finish("There are no installed plugins to remove.");
            return;
        }
        if (command === "install" && catalog.length === 0) {
            prompter.finish("There are no plugins available to install.");
            return;
        }
        const selected = await selectPlugins(command, catalog, registry, prompter);
        if (selected.length === 0) {
            prompter.finish(command === "remove"
                ? "No plugins were selected, so nothing was removed."
                : "No plugins were selected, so nothing was installed.");
            return;
        }
        const operationOutput = prompter.writer();
        const build = () => buildTarget(targetRoot, operationOutput);
        if (command === "install") {
            const toolResult = await ensurePluginTools({
                plugins: selected,
                confirmInstall: message => prompter.confirm(message),
                output: operationOutput
            });
            if (toolResult.ready.length === 0) {
                prompter.finish("No plugins were installed because their required native tools are unavailable.");
                return;
            }
            const result = await syncPlugins({
                userpluginsDir,
                registry,
                plugins: toolResult.ready,
                confirmDependencies: plugin => prompter.confirm(`${plugin.displayName} also needs these packages: ${plugin.dependencies.join(", ")}. Install them now?`),
                build,
                output: operationOutput
            });
            const changed = result.installed.length + result.updated.length > 0;
            prompter.finish(changed
                ? "Plugins are ready. Restart Discord to load the changes."
                : "No plugins were installed or updated.");
        }
        else {
            const result = await removePlugins({
                userpluginsDir,
                registry,
                ids: selected,
                build,
                output: operationOutput
            });
            prompter.finish(result.removed.length > 0
                ? "The selected plugins were removed. Restart Discord to finish applying the change."
                : "No plugins were removed.");
        }
    }
    finally {
        await cleanupCatalog();
        prompter.close();
    }
}
// Process boundary
main().catch((error) => {
    if (error instanceof PromptCancelledError)
        return;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not continue: ${message}\n`);
    process.exitCode = 1;
});
