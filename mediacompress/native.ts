/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// Runtime dependencies

const exec = promisify(execFile);

// HandBrake runtime model

interface HandBrakeResolution {
    id: "handbrake-cli";
    provider: "path" | "managed" | "flatpak";
    command: string;
    argsPrefix: string[];
    version: string;
}

export interface HandBrakeStatus {
    available: boolean;
    provider?: HandBrakeResolution["provider"];
    version?: string;
}

// Saved resolution discovery

function resolutionPath(): string {
    const home = homedir();
    const toolRoot =
        process.platform === "win32"
            ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "straif-plugins", "tools")
            : process.platform === "darwin"
              ? join(home, "Library", "Application Support", "straif-plugins", "tools")
              : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "straif-plugins", "tools");
    return join(toolRoot, "handbrake-cli", "resolution.json");
}

async function readResolution(): Promise<HandBrakeResolution | undefined> {
    try {
        const value = JSON.parse(await readFile(resolutionPath(), "utf8")) as Partial<HandBrakeResolution>;
        if (
            value.id !== "handbrake-cli" ||
            (value.provider !== "path" && value.provider !== "managed" && value.provider !== "flatpak") ||
            typeof value.command !== "string" ||
            !Array.isArray(value.argsPrefix) ||
            value.argsPrefix.some(argument => typeof argument !== "string") ||
            typeof value.version !== "string"
        )
            return undefined;
        return value as HandBrakeResolution;
    } catch {
        return undefined;
    }
}

async function findOnPath(): Promise<string | undefined> {
    const executable = process.platform === "win32" ? "HandBrakeCLI.exe" : "HandBrakeCLI";
    for (const directory of (process.env.PATH || "").split(delimiter)) {
        const cleanDirectory = directory.replace(/^"|"$/g, "");
        if (!cleanDirectory) continue;
        const path = join(cleanDirectory, executable);
        try {
            if ((await stat(path)).isFile()) return await realpath(path);
        } catch {}
    }
    return undefined;
}

// Executable probing

async function probe(command: string, argsPrefix: string[]): Promise<string | undefined> {
    try {
        const { stdout, stderr } = await exec(command, [...argsPrefix, "--version"], {
            timeout: 15_000,
            windowsHide: true
        });
        return /(?:HandBrakeCLI|HandBrake)\s+(\d+\.\d+(?:\.\d+)?)/i.exec(`${stdout}\n${stderr}`)?.[1];
    } catch {
        return undefined;
    }
}

// Public native API

export async function getHandBrakeStatus(): Promise<HandBrakeStatus> {
    const saved = await readResolution();
    if (saved) {
        const version = await probe(saved.command, saved.argsPrefix);
        if (version) return { available: true, provider: saved.provider, version };
    }

    const command = await findOnPath();
    if (!command) return { available: false };
    const version = await probe(command, []);
    return version ? { available: true, provider: "path", version } : { available: false };
}
