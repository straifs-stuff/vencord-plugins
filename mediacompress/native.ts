/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, readFile, realpath, rm, stat, statfs, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, join } from "node:path";
import { promisify } from "node:util";

import type { IpcMainInvokeEvent } from "electron";

import {
    chooseOpusBitrate,
    chooseVideoPlan,
    isHardwareEncoder,
    type OutputVideoPlan,
    type VideoSourceMetadata
} from "./planning";

const exec = promisify(execFile);

const IPC_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_INPUT_SIZE = 8 * 1024 * 1024 * 1024;
const MAX_TARGET_SIZE = 2 * 1024 * 1024 * 1024;
const MIN_TARGET_SIZE = 1024 * 1024;
const MAX_ENCODING_ATTEMPTS = 4;
const HARDWARE_BITRATE_RESERVE_KBPS = 8;
const MP4_BYTES_PER_PACKET_RESERVE = 16;
const AUDIO_PACKETS_PER_SECOND_RESERVE = 50;
const PROCESS_ERROR_TAIL_LENGTH = 16 * 1024;
const SCAN_OUTPUT_LIMIT = 4 * 1024 * 1024;
const TOOL_OUTPUT_LIMIT = 1024 * 1024;

const DISCORD_FRIENDLY_ENCODERS: Record<string, true> = {
    svt_av1: true,
    svt_av1_10bit: true,
    qsv_av1: true,
    qsv_av1_10bit: true,
    nvenc_av1: true,
    nvenc_av1_10bit: true,
    vce_av1: true,
    vce_av1_10bit: true,
    mf_av1: true,
    x264: true,
    qsv_h264: true,
    vce_h264: true,
    nvenc_h264: true,
    mf_h264: true,
    vt_h264: true,
    x265: true,
    x265_10bit: true,
    qsv_h265: true,
    qsv_h265_10bit: true,
    vce_h265: true,
    vce_h265_10bit: true,
    nvenc_h265: true,
    nvenc_h265_10bit: true,
    mf_h265: true,
    vt_h265: true,
    vt_h265_10bit: true
};

const MULTI_PASS_ENCODERS: Record<string, true> = {
    x264: true,
    x265: true,
    x265_10bit: true
};
const TEN_BIT_ENCODERS: Record<string, true> = {
    svt_av1_10bit: true,
    qsv_av1_10bit: true,
    nvenc_av1_10bit: true,
    vce_av1_10bit: true,
    x265_10bit: true,
    qsv_h265_10bit: true,
    vce_h265_10bit: true,
    nvenc_h265_10bit: true,
    vt_h265_10bit: true
};

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

export interface BeginCompressionOptions {
    fileName: string;
    fileSize: number;
    targetSize: number;
    encoder?: string;
}

export type CompressionPhase = "receiving" | "scanning" | "encoding" | "complete" | "cancelled" | "error";

export interface CompressionStatus {
    phase: CompressionPhase;
    progress: number;
    outputSize?: number;
    error?: string;
}

export type CompressionOperationResult = { success: true } | { success: false; error: string };
export type BeginCompressionResult = { success: true; token: string } | { success: false; error: string };
export type CompressionStatusResult = { success: true; status: CompressionStatus } | { success: false; error: string };
export type CompressionChunkResult = { success: true; data: Uint8Array } | { success: false; error: string };

interface HandBrakeDuration {
    Hours: number;
    Minutes: number;
    Seconds: number;
    Ticks: number;
}

interface HandBrakeAudioTrack {
    BitRate?: number;
    ChannelCount?: number;
}

interface HandBrakeTitle {
    AudioList: HandBrakeAudioTrack[];
    Color?: {
        BitDepth?: number;
        Transfer?: number;
    };
    Duration: HandBrakeDuration;
    FrameRate: {
        Den: number;
        Num: number;
    };
    Geometry: {
        Height: number;
        Width: number;
    };
    VideoCodec?: string;
}

interface HandBrakeTitleSet {
    TitleList: HandBrakeTitle[];
}

interface SourceMetadata extends VideoSourceMetadata {
    audio?: {
        bitrateKbps: number;
        channels: number;
    };
    durationSeconds: number;
    frameRate: number;
    hdr: boolean;
    height: number;
    width: number;
}

type AudioPlan = { bitrate: number; mixdown: "mono" | "stereo"; mode: "opus" };

interface ProcessResult {
    code: number;
    stderr: string;
    stdout: string;
}

interface CompressionJob {
    cancelled: boolean;
    child?: ChildProcess;
    cleanupTimer?: ReturnType<typeof setTimeout>;
    dir: string;
    encoder: string;
    error?: string;
    expectedSize: number;
    inputHandle?: FileHandle;
    inputPath: string;
    killTimer?: ReturnType<typeof setTimeout>;
    outputHandle?: FileHandle;
    outputPath: string;
    outputSize?: number;
    ownerId: number;
    phase: CompressionPhase;
    progress: number;
    progressBuffer: string;
    receivedSize: number;
    targetSize: number;
    token: string;
}

class CompressionError extends Error {}

const jobs = new Map<string, CompressionJob>();
const ownerJobs = new Map<number, Set<string>>();
const registeredOwners = new Set<number>();

function toolRoot(): string {
    const home = homedir();
    return process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "straif-plugins", "tools")
        : process.platform === "darwin"
          ? join(home, "Library", "Application Support", "straif-plugins", "tools")
          : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "straif-plugins", "tools");
}

function resolutionPath(): string {
    return join(toolRoot(), "handbrake-cli", "resolution.json");
}

function compressionCacheRoot(): string {
    const home = homedir();
    return process.platform === "win32"
        ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "straif-plugins", "cache", "media-compress")
        : process.platform === "darwin"
          ? join(home, "Library", "Caches", "straif-plugins", "media-compress")
          : join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "straif-plugins", "media-compress");
}

const interruptedJobCleanup = rm(compressionCacheRoot(), { force: true, recursive: true }).then(
    () => true,
    () => false
);

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
        .filter(encoder => Object.hasOwn(DISCORD_FRIENDLY_ENCODERS, encoder));
}

function parseEncoderPresets(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[A-Za-z0-9_-]+$/.test(line));
}

function appendLimited(current: string, value: string, limit: number): string {
    const combined = current + value;
    return combined.length <= limit ? combined : combined.slice(-limit);
}

function findJsonEnd(source: string, start: number): number | undefined {
    let depth = 0;
    let escaped = false;
    let inString = false;

    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }

        if (character === '"') inString = true;
        else if (character === "{") depth++;
        else if (character === "}" && --depth === 0) return index + 1;
    }

    return undefined;
}

function extractMarkedJson<T>(source: string, marker: string): { end: number; value: T } | undefined {
    const markerIndex = source.indexOf(marker);
    if (markerIndex === -1) return undefined;
    const start = source.indexOf("{", markerIndex + marker.length);
    if (start === -1) return undefined;
    const end = findJsonEnd(source, start);
    if (end === undefined) return undefined;

    try {
        return { end, value: JSON.parse(source.slice(start, end)) as T };
    } catch {
        return undefined;
    }
}

function updateProgress(job: CompressionJob, text: string) {
    job.progressBuffer = appendLimited(job.progressBuffer, text, 256 * 1024);

    for (;;) {
        const result = extractMarkedJson<{
            Scanning?: {
                Progress?: number;
            };
            State?: string;
            Working?: {
                Pass?: number;
                PassCount?: number;
                Progress?: number;
            };
        }>(job.progressBuffer, "Progress:");
        if (!result) break;

        job.progressBuffer = job.progressBuffer.slice(result.end);
        const scanning = result.value.Scanning;
        if (job.phase === "scanning" && result.value.State === "SCANNING" && typeof scanning?.Progress === "number") {
            job.progress = Math.min(1, Math.max(0, scanning.Progress));
            continue;
        }

        const working = result.value.Working;
        if (
            job.phase !== "encoding" ||
            result.value.State !== "WORKING" ||
            !working ||
            typeof working.Progress !== "number"
        )
            continue;

        const pass = Math.max(1, working.Pass ?? 1);
        const passCount = Math.max(1, working.PassCount ?? 1);
        job.progress = Math.min(1, Math.max(0, (pass - 1 + working.Progress) / passCount));
    }
}

function terminateProcess(job: CompressionJob) {
    const { child } = job;
    if (!child?.pid || child.exitCode !== null) return;

    try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
    } catch {}

    if (job.killTimer === undefined) {
        job.killTimer = setTimeout(() => {
            job.killTimer = undefined;
            if (!child.pid || child.exitCode !== null) return;
            try {
                if (process.platform === "win32") child.kill("SIGKILL");
                else process.kill(-child.pid, "SIGKILL");
            } catch {}
        }, 2_000);
    }
}

async function runHandBrake(
    job: CompressionJob,
    resolution: HandBrakeResolution,
    args: string[],
    captureLimit: number,
    timeoutMs?: number
): Promise<ProcessResult> {
    const { promise, resolve } = Promise.withResolvers<ProcessResult>();
    const child = spawn(resolution.command, [...resolution.argsPrefix, ...args], {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
    job.child = child;

    let stdout = "";
    let stderr = "";
    const timeout = timeoutMs ? setTimeout(() => terminateProcess(job), timeoutMs) : undefined;
    let settled = false;

    function finish(code: number) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(job.killTimer);
        job.killTimer = undefined;
        if (job.child === child) job.child = undefined;
        resolve({ code, stderr, stdout });
    }

    child.stdout?.on("data", chunk => {
        const text = String(chunk);
        stdout = appendLimited(stdout, text, captureLimit);
        if (job.phase === "scanning" || job.phase === "encoding") updateProgress(job, text);
    });
    child.stderr?.on("data", chunk => {
        const text = String(chunk);
        stderr = appendLimited(stderr, text, captureLimit);
        if (job.phase === "scanning" || job.phase === "encoding") updateProgress(job, text);
    });
    child.once("error", () => finish(1));
    child.once("close", code => finish(code ?? 1));
    return promise;
}

function durationInSeconds(duration: HandBrakeDuration): number {
    if (Number.isFinite(duration.Ticks) && duration.Ticks > 0) return duration.Ticks / 90_000;
    return duration.Hours * 3600 + duration.Minutes * 60 + duration.Seconds;
}

function parseSourceMetadata(output: string, fileSize: number): SourceMetadata | undefined {
    const titleSet = extractMarkedJson<HandBrakeTitleSet>(output, "JSON Title Set:")?.value;
    const title = titleSet?.TitleList?.[0];
    if (!title) return undefined;

    const durationSeconds = durationInSeconds(title.Duration);
    const frameRate = title.FrameRate.Den > 0 ? title.FrameRate.Num / title.FrameRate.Den : 30;
    const bitDepth = title.Color?.BitDepth ?? 8;
    const transfer = title.Color?.Transfer;
    const firstAudio = title.AudioList[0];
    const audioBitrateKbps = firstAudio ? Math.max(1, Math.ceil((firstAudio.BitRate ?? 0) / 1000)) : 0;
    const totalBitrateKbps = (fileSize * 8) / (durationSeconds * 1000);
    const videoBitrateKbps = Math.max(1, totalBitrateKbps - audioBitrateKbps);

    if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        !Number.isFinite(frameRate) ||
        frameRate <= 0 ||
        !Number.isFinite(title.Geometry.Width) ||
        !Number.isFinite(title.Geometry.Height) ||
        title.Geometry.Width <= 0 ||
        title.Geometry.Height <= 0
    )
        return undefined;

    return {
        audio: firstAudio
            ? {
                  bitrateKbps: audioBitrateKbps,
                  channels: Math.max(1, firstAudio.ChannelCount ?? 2)
              }
            : undefined,
        durationSeconds,
        frameRate,
        hdr: bitDepth > 8 && (transfer === 16 || transfer === 18),
        height: title.Geometry.Height,
        videoBitrateKbps,
        videoCodec: title.VideoCodec ?? "unknown",
        width: title.Geometry.Width
    };
}

function chooseAudioPlan(source: SourceMetadata, totalKbps: number): AudioPlan | undefined {
    const { audio } = source;
    if (!audio) return undefined;

    const bitrate = chooseOpusBitrate(totalKbps);
    if (Math.ceil(bitrate * 1.12) >= totalKbps)
        throw new CompressionError("The minimum audio bitrate leaves no room for video at this upload limit.");

    return {
        bitrate,
        mixdown: audio.channels === 1 ? "mono" : "stereo",
        mode: "opus"
    };
}

function audioBudgetKbps(audioPlan: AudioPlan | undefined): number {
    return audioPlan ? Math.ceil(audioPlan.bitrate * 1.12) : 0;
}
function muxReserveBytes(source: SourceMetadata, videoFrameRate = source.frameRate): number {
    const packetsPerSecond = videoFrameRate + (source.audio ? AUDIO_PACKETS_PER_SECOND_RESERVE : 0);
    return Math.max(64 * 1024, Math.ceil(source.durationSeconds * packetsPerSecond * MP4_BYTES_PER_PACKET_RESERVE));
}

function chooseEncoderPreset(encoder: string, presets: string[]): string | undefined {
    const preferred = encoder.startsWith("svt_av1") ? ["4", "5", "6"] : ["slow", "quality", "balanced", "medium"];
    return preferred.find(preset => presets.includes(preset));
}

function makeOutputFileName(fileName: string): string {
    const extension = extname(fileName);
    return `${extension ? fileName.slice(0, -extension.length) : fileName}.mp4`;
}

function makeEncodeArgs(
    job: CompressionJob,
    source: SourceMetadata,
    preset: string | undefined,
    videoKbps: number,
    audioPlan: AudioPlan | undefined,
    videoPlan: OutputVideoPlan
): string[] {
    const args = [
        "--json",
        "-i",
        job.inputPath,
        "-o",
        job.outputPath,
        "-f",
        "av_mp4",
        "--no-markers",
        "--no-metadata",
        "--optimize",
        "-e",
        job.encoder,
        "-b",
        String(videoKbps),
        "--crop-mode",
        "none",
        "--no-comb-detect",
        "--no-decomb",
        "--no-deinterlace",
        "--no-bwdif",
        "--no-detelecine",
        "-s",
        "none"
    ];

    if (preset) args.push("--encoder-preset", preset);
    if (videoPlan.width !== source.width || videoPlan.height !== source.height)
        args.push("-w", String(videoPlan.width), "-l", String(videoPlan.height));
    if (videoPlan.frameRate < source.frameRate) args.push("-r", String(videoPlan.frameRate), "--pfr");
    else args.push("--vfr");
    if (source.hdr && !Object.hasOwn(TEN_BIT_ENCODERS, job.encoder)) args.push("--colorspace", "bt709");

    if (!audioPlan) args.push("-a", "none");
    else args.push("-a", "1", "-E", "opus", "-B", String(audioPlan.bitrate), "-6", audioPlan.mixdown);

    if (Object.hasOwn(MULTI_PASS_ENCODERS, job.encoder)) args.push("--multi-pass", "--turbo");
    return args;
}

async function closeJobHandles(job: CompressionJob) {
    const handles = [job.inputHandle, job.outputHandle];
    job.inputHandle = undefined;
    job.outputHandle = undefined;
    await Promise.all(handles.map(handle => handle?.close().catch(() => {})));
}

function removeOwnerJob(job: CompressionJob) {
    const tokens = ownerJobs.get(job.ownerId);
    tokens?.delete(job.token);
    if (tokens?.size === 0) ownerJobs.delete(job.ownerId);
}

async function removeJobFiles(job: CompressionJob) {
    await closeJobHandles(job);
    await rm(job.dir, { force: true, recursive: true }).catch(() => {});
}

async function releaseJob(job: CompressionJob) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = undefined;
    jobs.delete(job.token);
    removeOwnerJob(job);
    await removeJobFiles(job);
}

function scheduleJobCleanup(job: CompressionJob) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = setTimeout(() => void releaseJob(job), 10 * 60_000);
}

async function failJob(job: CompressionJob, message: string) {
    job.phase = "error";
    job.error = message;
    job.progress = 0;
    await removeJobFiles(job);
    scheduleJobCleanup(job);
}

async function waitForProcessExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("close", finish);
        resolve();
    };
    const timeout = setTimeout(finish, 3_000);
    child.once("close", finish);
    await promise;
}

async function cancelJob(job: CompressionJob) {
    if (job.phase === "cancelled") return;
    job.cancelled = true;
    job.phase = "cancelled";
    job.progress = 0;
    const { child } = job;
    terminateProcess(job);
    if (child) await waitForProcessExit(child);
    await releaseJob(job);
}

function registerOwner(event: IpcMainInvokeEvent, token: string) {
    const ownerId = event.sender.id;
    let tokens = ownerJobs.get(ownerId);
    if (!tokens) ownerJobs.set(ownerId, (tokens = new Set()));
    tokens.add(token);

    if (registeredOwners.has(ownerId)) return;
    registeredOwners.add(ownerId);
    event.sender.once("destroyed", () => {
        registeredOwners.delete(ownerId);
        const ownedTokens = [...(ownerJobs.get(ownerId) ?? [])];
        for (const ownedToken of ownedTokens) {
            const job = jobs.get(ownedToken);
            if (job) void cancelJob(job);
        }
    });
}

function getOwnedJob(event: IpcMainInvokeEvent, token: string): CompressionJob | undefined {
    const job = jobs.get(token);
    return job?.ownerId === event.sender.id ? job : undefined;
}

function operationError(error: string): CompressionOperationResult {
    return { success: false, error };
}

async function ensureDiskSpace(root: string, inputSize: number, targetSize: number): Promise<boolean> {
    try {
        const info = await statfs(root, { bigint: true });
        const available = info.bavail * info.bsize;
        const required = BigInt(inputSize) + BigInt(targetSize) * 2n + 64n * 1024n * 1024n;
        return available >= required;
    } catch {
        return true;
    }
}

async function runCompression(job: CompressionJob) {
    try {
        const resolution = await resolveHandBrake();
        if (!resolution) throw new CompressionError("HandBrakeCLI is unavailable.");

        const encoderResult = await runHandBrake(job, resolution, ["--help"], TOOL_OUTPUT_LIMIT, 15_000);
        if (job.cancelled) return;
        const encoders = parseHandBrakeEncoders(`${encoderResult.stdout}\n${encoderResult.stderr}`);
        if (encoderResult.code !== 0 || !encoders.includes(job.encoder))
            throw new CompressionError(`The selected encoder (${job.encoder}) is unavailable.`);

        job.phase = "scanning";
        job.progress = 0;
        const scanResult = await runHandBrake(
            job,
            resolution,
            ["--scan", "--json", "-i", job.inputPath],
            SCAN_OUTPUT_LIMIT,
            60_000
        );
        if (job.cancelled) return;
        if (scanResult.code !== 0) throw new CompressionError("HandBrakeCLI could not read this video.");

        const source = parseSourceMetadata(`${scanResult.stdout}\n${scanResult.stderr}`, job.expectedSize);
        if (!source) throw new CompressionError("HandBrakeCLI did not find a usable video title.");

        const presetResult = await runHandBrake(
            job,
            resolution,
            ["--encoder-preset-list", job.encoder],
            TOOL_OUTPUT_LIMIT,
            15_000
        );
        if (job.cancelled) return;
        const preset =
            presetResult.code === 0
                ? chooseEncoderPreset(
                      job.encoder,
                      parseEncoderPresets(`${presetResult.stdout}\n${presetResult.stderr}`)
                  )
                : undefined;

        const targetBytes = Math.min(job.targetSize - 64 * 1024, Math.floor(job.targetSize * 0.995));
        let muxReserve = muxReserveBytes(source);
        let totalKbps!: number;
        let audioPlan!: AudioPlan | undefined;
        let videoKbps!: number;
        let videoPlan!: OutputVideoPlan;

        for (let refinement = 0; refinement < 2; refinement++) {
            totalKbps = Math.max(1, Math.floor(((targetBytes - muxReserve) * 8) / (source.durationSeconds * 1000)));
            audioPlan = chooseAudioPlan(source, totalKbps);
            videoKbps = Math.max(
                1,
                totalKbps -
                    audioBudgetKbps(audioPlan) -
                    (isHardwareEncoder(job.encoder) ? HARDWARE_BITRATE_RESERVE_KBPS : 0)
            );
            videoPlan = chooseVideoPlan(source, job.encoder, videoKbps);

            const refinedMuxReserve = muxReserveBytes(source, videoPlan.frameRate);
            if (refinedMuxReserve === muxReserve) break;
            muxReserve = refinedMuxReserve;
        }

        for (let attempt = 1; attempt <= MAX_ENCODING_ATTEMPTS; attempt++) {
            job.phase = "encoding";
            job.progress = 0;
            job.progressBuffer = "";

            await unlink(job.outputPath).catch(() => {});
            const result = await runHandBrake(
                job,
                resolution,
                makeEncodeArgs(job, source, preset, videoKbps, audioPlan, videoPlan),
                PROCESS_ERROR_TAIL_LENGTH
            );
            if (job.cancelled) return;
            if (result.code !== 0)
                throw new CompressionError(`HandBrakeCLI could not encode this video with ${job.encoder}.`);

            const output = await stat(job.outputPath).catch(() => undefined);
            if (!output?.isFile() || output.size === 0)
                throw new CompressionError("HandBrakeCLI did not create a usable output file.");

            if (output.size <= job.targetSize) {
                job.outputSize = output.size;
                job.outputHandle = await open(job.outputPath, "r");
                job.phase = "complete";
                job.progress = 1;
                await unlink(job.inputPath).catch(() => {});
                scheduleJobCleanup(job);
                return;
            }

            if (attempt === MAX_ENCODING_ATTEMPTS)
                throw new CompressionError("Could not compress this video below the upload limit.");

            const correction = Math.min(0.995, (targetBytes / output.size) * 0.997);
            const correctedTotalKbps = Math.max(1, Math.floor(totalKbps * correction));
            totalKbps = correctedTotalKbps < totalKbps ? correctedTotalKbps : totalKbps - 1;
            if (totalKbps <= 0) throw new CompressionError("The upload limit is too small for this video.");
            audioPlan = chooseAudioPlan(source, totalKbps);
            videoKbps = Math.max(
                1,
                totalKbps -
                    audioBudgetKbps(audioPlan) -
                    (isHardwareEncoder(job.encoder) ? HARDWARE_BITRATE_RESERVE_KBPS : 0)
            );
            videoPlan = chooseVideoPlan(source, job.encoder, videoKbps);
        }
    } catch (error) {
        if (job.cancelled) return;
        const message = error instanceof CompressionError ? error.message : "Video compression failed unexpectedly.";
        await failJob(job, message);
    }
}

export async function getHandBrakeStatus(_event: IpcMainInvokeEvent): Promise<HandBrakeStatus> {
    const resolution = await resolveHandBrake();
    return resolution
        ? { available: true, provider: resolution.provider, version: resolution.version }
        : { available: false };
}

export async function getHandBrakeEncoders(_event: IpcMainInvokeEvent): Promise<HandBrakeEncodersResult> {
    const resolution = await resolveHandBrake();
    if (!resolution) return { available: false, encoders: [] };

    try {
        const { stdout, stderr } = await exec(resolution.command, [...resolution.argsPrefix, "--help"], {
            timeout: 15_000,
            windowsHide: true,
            maxBuffer: TOOL_OUTPUT_LIMIT
        });
        return { available: true, encoders: parseHandBrakeEncoders(`${stdout}\n${stderr}`) };
    } catch {
        return { available: true, encoders: [] };
    }
}

export async function beginCompressionInput(
    event: IpcMainInvokeEvent,
    options: BeginCompressionOptions
): Promise<BeginCompressionResult> {
    if (
        typeof options !== "object" ||
        options === null ||
        typeof options.fileName !== "string" ||
        basename(options.fileName) !== options.fileName ||
        options.fileName.length === 0 ||
        options.fileName.length > 255 ||
        !Number.isSafeInteger(options.fileSize) ||
        options.fileSize <= 0 ||
        options.fileSize > MAX_INPUT_SIZE ||
        !Number.isSafeInteger(options.targetSize) ||
        options.targetSize < MIN_TARGET_SIZE ||
        options.targetSize > MAX_TARGET_SIZE
    )
        return { success: false, error: "Invalid compression input." };

    const encoder = options.encoder || "x264";
    if (!Object.hasOwn(DISCORD_FRIENDLY_ENCODERS, encoder))
        return { success: false, error: "The selected video encoder is not supported." };

    const root = compressionCacheRoot();
    if (!(await interruptedJobCleanup))
        return { success: false, error: "Could not remove interrupted compression jobs." };
    await mkdir(root, { recursive: true });
    if (!(await ensureDiskSpace(root, options.fileSize, options.targetSize)))
        return { success: false, error: "There is not enough free disk space to compress this video." };

    const token = randomUUID();
    let dir: string | undefined;
    try {
        dir = await mkdtemp(join(root, "job-"));
        const sourceExtension = /^[.][A-Za-z0-9]{1,12}$/.test(extname(options.fileName))
            ? extname(options.fileName)
            : ".video";
        const inputPath = join(dir, `input${sourceExtension}`);
        const outputPath = join(dir, makeOutputFileName(options.fileName));
        const inputHandle = await open(inputPath, "wx", 0o600);
        const job: CompressionJob = {
            cancelled: false,
            dir,
            encoder,
            expectedSize: options.fileSize,
            inputHandle,
            inputPath,
            outputPath,
            ownerId: event.sender.id,
            phase: "receiving",
            progress: 0,
            progressBuffer: "",
            receivedSize: 0,
            targetSize: options.targetSize,
            token
        };
        jobs.set(token, job);
        registerOwner(event, token);
        return { success: true, token };
    } catch {
        if (dir) await rm(dir, { force: true, recursive: true }).catch(() => {});
        return { success: false, error: "Could not prepare temporary storage for compression." };
    }
}

export async function writeCompressionChunk(
    event: IpcMainInvokeEvent,
    token: string,
    offset: number,
    data: Uint8Array
): Promise<CompressionOperationResult> {
    const job = getOwnedJob(event, token);
    if (!job || job.phase !== "receiving" || !job.inputHandle)
        return operationError("The compression job is unavailable.");
    if (
        !Number.isSafeInteger(offset) ||
        offset !== job.receivedSize ||
        !(data instanceof Uint8Array) ||
        data.byteLength === 0 ||
        data.byteLength > IPC_CHUNK_SIZE ||
        offset + data.byteLength > job.expectedSize
    )
        return operationError("Invalid compression input chunk.");

    try {
        const { bytesWritten } = await job.inputHandle.write(data, 0, data.byteLength, offset);
        if (bytesWritten !== data.byteLength) return operationError("Could not write the complete input chunk.");
        job.receivedSize += bytesWritten;
        job.progress = job.receivedSize / job.expectedSize;
        return { success: true };
    } catch {
        return operationError("Could not write the compression input.");
    }
}

export async function startCompression(event: IpcMainInvokeEvent, token: string): Promise<CompressionOperationResult> {
    const job = getOwnedJob(event, token);
    if (!job || job.phase !== "receiving" || !job.inputHandle)
        return operationError("The compression job is unavailable.");
    if (job.receivedSize !== job.expectedSize) return operationError("The video input is incomplete.");

    await job.inputHandle.close().catch(() => {});
    job.inputHandle = undefined;
    job.phase = "scanning";
    job.progress = 0;
    void runCompression(job);
    return { success: true };
}

export function getCompressionStatus(event: IpcMainInvokeEvent, token: string): CompressionStatusResult {
    const job = getOwnedJob(event, token);
    if (!job) return { success: false, error: "The compression job is unavailable." };
    return {
        success: true,
        status: {
            error: job.error,
            outputSize: job.outputSize,
            phase: job.phase,
            progress: job.progress
        }
    };
}

export async function readCompressionOutputChunk(
    event: IpcMainInvokeEvent,
    token: string,
    offset: number,
    length: number
): Promise<CompressionChunkResult> {
    const job = getOwnedJob(event, token);
    if (!job || job.phase !== "complete" || !job.outputHandle || job.outputSize === undefined)
        return { success: false, error: "The compressed output is unavailable." };
    if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > IPC_CHUNK_SIZE ||
        offset + length > job.outputSize
    )
        return { success: false, error: "Invalid compressed output range." };

    try {
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await job.outputHandle.read(buffer, 0, length, offset);
        if (bytesRead !== length) return { success: false, error: "Could not read the complete compressed output." };
        return { success: true, data: Uint8Array.from(buffer) };
    } catch {
        return { success: false, error: "Could not read the compressed output." };
    }
}

export async function cancelCompression(event: IpcMainInvokeEvent, token: string): Promise<CompressionOperationResult> {
    const job = getOwnedJob(event, token);
    if (!job) return operationError("The compression job is unavailable.");
    await cancelJob(job);
    return { success: true };
}

export async function releaseCompression(
    event: IpcMainInvokeEvent,
    token: string
): Promise<CompressionOperationResult> {
    const job = getOwnedJob(event, token);
    if (!job) return operationError("The compression job is unavailable.");
    if (job.phase !== "complete" && job.phase !== "error")
        return operationError("The compression job is still running.");
    await releaseJob(job);
    return { success: true };
}

export async function cancelAllCompressions(event: IpcMainInvokeEvent): Promise<void> {
    const tokens = [...(ownerJobs.get(event.sender.id) ?? [])];
    await Promise.all(
        tokens.map(async token => {
            const job = jobs.get(token);
            if (job) await cancelJob(job);
        })
    );
}
