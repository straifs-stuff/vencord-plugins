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
export interface HandBrakeEncodersResult {
    available: boolean;
    encoders: string[];
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
async function resolveHandBrake(): Promise<HandBrakeResolution | undefined> {
    const saved = await readResolution();
    if (saved) {
        const version = await probe(saved.command, saved.argsPrefix);
        if (version) return { ...saved, version };
    }

    const command = await findOnPath();
    if (!command) return undefined;
    const version = await probe(command, []);
    return version ? { id: "handbrake-cli", provider: "path", command, argsPrefix: [], version } : undefined;
}

function parseHandBrakeEncoders(output: string): string[] {
    const encoderSection =
        /(?:^|\r?\n)\s+-e,\s+--encoder <string>\s+Select video encoder:\s*\r?\n([\s\S]*?)(?=\r?\n\s+--encoder-preset)/.exec(
            output
        )?.[1];
    if (!encoderSection) return [];

    return encoderSection
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[A-Za-z0-9_]+$/.test(line));
}

// Public native API

export async function getHandBrakeStatus(): Promise<HandBrakeStatus> {
    const resolution = await resolveHandBrake();
    return resolution
        ? { available: true, provider: resolution.provider, version: resolution.version }
        : { available: false };
}

export async function getHandBrakeEncoders(): Promise<HandBrakeEncodersResult> {
    const resolution = await resolveHandBrake();
    if (!resolution) return { available: false, encoders: [] };

    try {
        const { stdout, stderr } = await exec(resolution.command, [...resolution.argsPrefix, "--help"], {
            timeout: 15_000,
            windowsHide: true,
            maxBuffer: 1024 * 1024
        });
        return { available: true, encoders: parseHandBrakeEncoders(`${stdout}\n${stderr}`) };
    } catch {
        return { available: true, encoders: [] };
    }
}
