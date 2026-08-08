/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import type { PluginNative, PluginSettingComponentProps } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform, DraftType } from "@vencord/discord-types/enums";
import { filters, findByCodeLazy, mapMangledModuleLazy } from "@webpack";
import {
    ChannelStore,
    CloudUploader,
    Select,
    showToast,
    Toasts,
    UploadAttachmentStore,
    UploadManager,
    useEffect,
    useState
} from "@webpack/common";

import type { CompressionPhase, CompressionStatus, HandBrakeEncodersResult } from "./native";
import type * as MediaCompressNative from "./native";

import "./style.css";

const logger = new Logger("MediaCompress");
const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");
const Native = VencordNative.pluginHelpers.MediaCompress as
    Partial<PluginNative<typeof MediaCompressNative>> | undefined;

interface UploadLimitExperimentConfig {
    enabled: boolean;
    threshold: number;
    isGA: boolean;
}

interface UploadLimitExperimentModule {
    getConfig(options: { location: string }): UploadLimitExperimentConfig;
    getEffectiveLimit(config: UploadLimitExperimentConfig, baseLimit: number): number;
}

const getBaseUploadFileSizeLimit = findByCodeLazy("getGuildMaxFileSize") as (guildId?: string | null) => number;
const UploadLimitExperiment = mapMangledModuleLazy(["2026-04-kestrel", "2026-08-kestrel-ga"], {
    getConfig: filters.byCode(".getConfig({location:", "threshold:20,isGA:!0"),
    getEffectiveLimit: filters.byCode("Math.max(1048576*", ".threshold")
}) as UploadLimitExperimentModule;

const UPLOAD_LIMIT_LOCATION = "web.filesExceedUploadLimits";

export function getUploadFileSizeLimit(channel: Channel): number {
    const baseLimit = getBaseUploadFileSizeLimit(channel.guild_id);
    const experimentConfig = UploadLimitExperiment.getConfig({ location: UPLOAD_LIMIT_LOCATION });

    return UploadLimitExperiment.getEffectiveLimit(experimentConfig, baseLimit);
}

const DEFAULT_VIDEO_ENCODER = "x264";
const IPC_CHUNK_SIZE = 4 * 1024 * 1024;
const STATUS_POLL_INTERVAL_MS = 250;
const VIDEO_ENCODER_SETTING_KEYS = ["videoEncoder"] satisfies "videoEncoder"[];
const ACTIVE_JOB_PHASES: Record<RendererCompressionPhase, boolean> = {
    "transferring-input": true,
    scanning: true,
    encoding: true,
    "transferring-output": true,
    complete: false,
    cancelled: false,
    error: false
};
const ENCODER_LABELS: Record<string, string> = {
    svt_av1: "AV1 (SVT)",
    svt_av1_10bit: "AV1 10-bit (SVT)",
    qsv_av1: "AV1 (Intel QSV)",
    qsv_av1_10bit: "AV1 10-bit (Intel QSV)",
    nvenc_av1: "AV1 (NVEnc)",
    nvenc_av1_10bit: "AV1 10-bit (NVEnc)",
    vce_av1: "AV1 (AMD VCE)",
    vce_av1_10bit: "AV1 10-bit (AMD VCE)",
    mf_av1: "AV1 (MediaFoundation)",
    x264: "H.264 (x264)",
    qsv_h264: "H.264 (Intel QSV)",
    vce_h264: "H.264 (AMD VCE)",
    nvenc_h264: "H.264 (NVEnc)",
    mf_h264: "H.264 (MediaFoundation)",
    vt_h264: "H.264 (VideoToolbox)",
    x265: "H.265 (x265)",
    x265_10bit: "H.265 10-bit (x265)",
    qsv_h265: "H.265 (Intel QSV)",
    qsv_h265_10bit: "H.265 10-bit (Intel QSV)",
    vce_h265: "H.265 (AMD VCE)",
    vce_h265_10bit: "H.265 10-bit (AMD VCE)",
    nvenc_h265: "H.265 (NVEnc)",
    nvenc_h265_10bit: "H.265 10-bit (NVEnc)",
    mf_h265: "H.265 (MediaFoundation)",
    vt_h265: "H.265 (VideoToolbox)",
    vt_h265_10bit: "H.265 10-bit (VideoToolbox)"
};

interface EncoderDiscoveryResult extends HandBrakeEncodersResult {
    restartRequired?: boolean;
}

const EMPTY_ENCODER_RESULT: EncoderDiscoveryResult = { available: false, encoders: [] };

async function discoverAvailableEncoders(): Promise<EncoderDiscoveryResult> {
    const getHandBrakeEncoders = Native?.getHandBrakeEncoders;
    if (typeof getHandBrakeEncoders !== "function") return { available: false, encoders: [], restartRequired: true };

    try {
        return await getHandBrakeEncoders();
    } catch {
        return { available: false, encoders: [], restartRequired: true };
    }
}

function VideoEncoderSetting({ setValue }: PluginSettingComponentProps) {
    const { videoEncoder } = settings.use(VIDEO_ENCODER_SETTING_KEYS);
    const [selectedEncoder, setSelectedEncoder] = useState(videoEncoder);
    const [result, , isPending] = useAwaiter(discoverAvailableEncoders, {
        fallbackValue: EMPTY_ENCODER_RESULT
    });
    const options = result.encoders.map(value => ({
        label: ENCODER_LABELS[value] ?? value,
        value
    }));
    const selectedEncoderUnavailable = !isPending && result.available && !result.encoders.includes(videoEncoder);

    useEffect(() => {
        setSelectedEncoder(videoEncoder);
    }, [videoEncoder]);

    function handleChange(newValue: string) {
        setSelectedEncoder(newValue);
        setValue(newValue);
    }

    const status = isPending
        ? "Checking which encoders are available..."
        : result.restartRequired
          ? "Restart Discord to load the updated MediaCompress native helper."
          : !result.available
            ? "HandBrakeCLI is unavailable."
            : options.length === 0
              ? "HandBrakeCLI did not report any Discord-compatible video encoders."
              : selectedEncoderUnavailable
                ? "The selected encoder is unavailable. Choose another encoder before compressing."
                : "Only Discord-compatible encoders reported by this HandBrakeCLI installation are shown.";

    return (
        <SettingsSection name="Video Encoder" id="videoEncoder" description={status}>
            <Select
                placeholder="Select a video encoder"
                maxVisibleItems={8}
                options={options}
                select={handleChange}
                isSelected={value => value === selectedEncoder}
                serialize={String}
                isDisabled={isPending || options.length === 0}
                closeOnSelect
            />
            <Card variant="primary">
                <Flex flexDirection="column" gap="4px">
                    <Paragraph size="md" weight="semibold">
                        Which encoder to pick?
                    </Paragraph>
                    <Paragraph>
                        <strong>Modern GPUs with AV1:</strong> use <code>AV1 (NVEnc)</code> on NVIDIA RTX 40-series or
                        newer, <code>AV1 (Intel QSV)</code> on Intel Arc or Core Ultra, and <code>AV1 (AMD VCE)</code>{" "}
                        on AMD RX 7000-series or newer.
                    </Paragraph>
                    <Paragraph>
                        <strong>Older GPUs:</strong> use the matching H.265 hardware encoder. Choose H.264 instead when
                        playback compatibility matters most.
                    </Paragraph>
                    <Paragraph>
                        <strong>Apple Silicon:</strong> use <code>H.265 (VideoToolbox)</code>, or its H.264 option for
                        maximum compatibility.
                    </Paragraph>
                    <Paragraph>
                        <strong>CPU encoding:</strong> use <code>H.264 (x264)</code> as the safe default. Choose{" "}
                        <code>AV1 (SVT)</code> or <code>H.265 (x265)</code> for smaller files when speed is less
                        important.
                    </Paragraph>
                    <Paragraph>Use a 10-bit encoder for HDR sources when you want to preserve HDR.</Paragraph>
                </Flex>
            </Card>
        </SettingsSection>
    );
}

const settings = definePluginSettings({
    videoEncoder: {
        type: OptionType.COMPONENT,
        default: DEFAULT_VIDEO_ENCODER,
        component: ErrorBoundary.wrap(VideoEncoderSetting, { noop: true })
    }
});

type RendererCompressionPhase =
    "transferring-input" | "scanning" | "encoding" | "transferring-output" | "complete" | "cancelled" | "error";

interface RendererCompressionJob {
    cancelled: boolean;
    error?: string;
    phase: RendererCompressionPhase;
    progress: number;
    token?: string;
}

class CompressionCancelledError extends Error {}

const compressionJobs = new Map<string, RendererCompressionJob>();
const compressionJobListeners = new Map<string, Set<() => void>>();

function emitCompressionJob(uploadId: string) {
    for (const listener of compressionJobListeners.get(uploadId) ?? []) listener();
}

function updateCompressionJob(uploadId: string, update: Partial<RendererCompressionJob>) {
    const job = compressionJobs.get(uploadId);
    if (!job) return;
    Object.assign(job, update);
    emitCompressionJob(uploadId);
}

function useCompressionJob(uploadId: string): RendererCompressionJob | undefined {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        let listeners = compressionJobListeners.get(uploadId);
        if (!listeners) compressionJobListeners.set(uploadId, (listeners = new Set()));
        const listener = () => forceUpdate(version => version + 1);
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) compressionJobListeners.delete(uploadId);
        };
    }, [uploadId]);

    return compressionJobs.get(uploadId);
}

function throwIfCancelled(job: RendererCompressionJob) {
    if (job.cancelled) throw new CompressionCancelledError();
}

function compressedFileName(fileName: string): string {
    const extensionIndex = fileName.lastIndexOf(".");
    return `${extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName}.mp4`;
}

function replaceDraftUpload(channelId: string, original: CloudUpload, file: File) {
    const uploads = [...UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)];
    const uploadIndex = uploads.findIndex(upload => upload.uniqueId === original.uniqueId || upload.id === original.id);
    if (uploadIndex === -1) throw new Error("The original attachment is no longer in the message draft.");

    const replacement = new CloudUploader(
        {
            file,
            origin: original.origin,
            platform: CloudUploadPlatform.WEB
        },
        channelId
    );
    replacement.description = original.description;
    replacement.sensitive = original.sensitive;
    replacement.spoiler = original.spoiler;
    uploads[uploadIndex] = replacement;
    UploadManager.setUploads({ uploads, channelId, draftType: DraftType.ChannelMessage });
}

function rendererPhase(status: CompressionStatus): RendererCompressionPhase {
    if (status.phase === "receiving") return "transferring-input";
    if (status.phase === "complete") return "transferring-output";
    return status.phase;
}

function rendererProgress(status: CompressionStatus): number {
    switch (status.phase) {
        case "receiving":
            return status.progress * 5;
        case "scanning":
            return 5 + status.progress * 5;
        case "encoding":
            return 10 + status.progress * 80;
        case "complete":
            return 90;
        case "cancelled":
        case "error":
            return 0;
    }
}

async function runCompression(channelId: string, upload: CloudUpload, targetSize: number) {
    const uploadId = upload.uniqueId;
    const file = upload.item.file;
    const job: RendererCompressionJob = {
        cancelled: false,
        phase: "transferring-input",
        progress: 0
    };
    compressionJobs.set(uploadId, job);
    emitCompressionJob(uploadId);

    const beginCompressionInput = Native?.beginCompressionInput;
    const writeCompressionChunk = Native?.writeCompressionChunk;
    const startCompression = Native?.startCompression;
    const getCompressionStatus = Native?.getCompressionStatus;
    const readCompressionOutputChunk = Native?.readCompressionOutputChunk;
    const releaseCompression = Native?.releaseCompression;

    if (
        typeof beginCompressionInput !== "function" ||
        typeof writeCompressionChunk !== "function" ||
        typeof startCompression !== "function" ||
        typeof getCompressionStatus !== "function" ||
        typeof readCompressionOutputChunk !== "function" ||
        typeof releaseCompression !== "function"
    ) {
        updateCompressionJob(uploadId, {
            error: "Restart Discord to load the updated MediaCompress native helper.",
            phase: "error"
        });
        showToast("Restart Discord to load the updated MediaCompress native helper.", Toasts.Type.FAILURE);
        return;
    }

    let token: string | undefined;
    try {
        const beginResult = await beginCompressionInput({
            encoder: settings.store.videoEncoder || DEFAULT_VIDEO_ENCODER,
            fileName: file.name,
            fileSize: file.size,
            targetSize
        });
        if (!beginResult.success) throw new Error(beginResult.error);
        token = beginResult.token;
        job.token = token;
        throwIfCancelled(job);

        for (let offset = 0; offset < file.size; offset += IPC_CHUNK_SIZE) {
            throwIfCancelled(job);
            const end = Math.min(offset + IPC_CHUNK_SIZE, file.size);
            const data = new Uint8Array(await file.slice(offset, end).arrayBuffer());
            const result = await writeCompressionChunk(token, offset, data);
            if (!result.success) throw new Error(result.error);
            updateCompressionJob(uploadId, {
                phase: "transferring-input",
                progress: (end / file.size) * 5
            });
        }

        throwIfCancelled(job);
        const startResult = await startCompression(token);
        if (!startResult.success) throw new Error(startResult.error);

        let outputSize: number | undefined;
        for (;;) {
            throwIfCancelled(job);
            const result = await getCompressionStatus(token);
            if (!result.success) throw new Error(result.error);
            const { status } = result;
            const measuredProgress = rendererProgress(status);
            updateCompressionJob(uploadId, {
                error: status.error,
                phase: rendererPhase(status),
                progress:
                    status.phase === "cancelled" || status.phase === "error"
                        ? job.progress
                        : Math.max(job.progress, measuredProgress)
            });

            if (status.phase === "complete") {
                outputSize = status.outputSize;
                break;
            }
            if (status.phase === "error") throw new Error(status.error || "Video compression failed.");
            if (status.phase === "cancelled") throw new CompressionCancelledError();
            await sleep(STATUS_POLL_INTERVAL_MS);
        }

        if (outputSize === undefined || outputSize <= 0) throw new Error("The compressed output is unavailable.");
        const outputParts: BlobPart[] = [];
        for (let offset = 0; offset < outputSize; offset += IPC_CHUNK_SIZE) {
            throwIfCancelled(job);
            const length = Math.min(IPC_CHUNK_SIZE, outputSize - offset);
            const result = await readCompressionOutputChunk(token, offset, length);
            if (!result.success) throw new Error(result.error);
            outputParts.push(new Uint8Array(result.data));
            updateCompressionJob(uploadId, {
                phase: "transferring-output",
                progress: Math.max(job.progress, 90 + ((offset + length) / outputSize) * 9)
            });
        }

        throwIfCancelled(job);
        const compressedFile = new File(outputParts, compressedFileName(file.name), {
            lastModified: Date.now(),
            type: "video/mp4"
        });
        replaceDraftUpload(channelId, upload, compressedFile);
        updateCompressionJob(uploadId, { phase: "complete", progress: 100 });
        showToast("Attachment compressed successfully.", Toasts.Type.SUCCESS);
    } catch (error) {
        if (error instanceof CompressionCancelledError || job.cancelled) {
            updateCompressionJob(uploadId, { phase: "cancelled" });
        } else {
            const message = error instanceof Error ? error.message : "Video compression failed.";
            logger.warn("Compression failed", message);
            updateCompressionJob(uploadId, { error: message, phase: "error" });
            showToast(message, Toasts.Type.FAILURE);
        }
    } finally {
        if (token) await releaseCompression(token).catch(() => {});
        if (!ACTIVE_JOB_PHASES[job.phase]) {
            setTimeout(() => {
                if (compressionJobs.get(uploadId) === job) {
                    compressionJobs.delete(uploadId);
                    emitCompressionJob(uploadId);
                }
            }, 2_000);
        }
    }
}

async function cancelCompressionJob(uploadId: string) {
    const job = compressionJobs.get(uploadId);
    if (!job || !ACTIVE_JOB_PHASES[job.phase]) return;
    job.cancelled = true;
    updateCompressionJob(uploadId, { phase: "cancelled" });

    if (job.token && typeof Native?.cancelCompression === "function")
        await Native.cancelCompression(job.token).catch(() => {});
}

function CompressIcon() {
    return (
        <g className="vc-media-compress-icon vc-media-compress-icon-compress">
            <path d="M0 0h640v640H0z" fill="none" />
            <path
                fill="currentColor"
                d="M503.5 71c9.4-9.4 24.6-9.4 33.9 0l32 32c9.4 9.4 9.4 24.6 0 33.9l-87 87 39 39c6.9 6.9 8.9 17.2 5.2 26.2S514.2 304 504.5 304h-144c-13.3 0-24-10.7-24-24V136c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2l39 39zm-367 265h144c13.3 0 24 10.7 24 24v144c0 9.7-5.8 18.5-14.8 22.2s-19.3-1.7-26.2-5.2l-39-39-87 87c-9.4 9.4-24.6 9.4-33.9 0l-32-32c-9.4-9.4-9.4-24.6 0-33.9l87-87-39-39c-6.9-6.9-8.9-17.2-5.2-26.2s12.4-14.9 22.1-14.9"
            />
        </g>
    );
}

function CompressionProgressIcon({ progress }: { progress: number }) {
    return (
        <g className="vc-media-compress-icon vc-media-compress-icon-progress">
            <circle cx="320" cy="320" r="253" fill="none" stroke="currentColor" strokeWidth="80" opacity=".25" />
            <g className="vc-media-compress-spinner">
                <circle
                    cx="320"
                    cy="320"
                    r="253"
                    fill="none"
                    pathLength="100"
                    stroke="currentColor"
                    strokeDasharray={`${progress} 100`}
                    strokeLinecap={progress === 100 ? "butt" : "round"}
                    strokeWidth="80"
                    transform="rotate(-90 320 320)"
                />
            </g>
        </g>
    );
}

function CompressionCompleteIcon() {
    return (
        <g className="vc-media-compress-icon vc-media-compress-icon-complete">
            <g transform="scale(53.333333)">
                <path d="M0 0h12v12H0z" fill="none" />
                <path
                    fill="currentColor"
                    d="M9.765 3.205a.75.75 0 0 1 .03 1.06l-4.25 4.5a.75.75 0 0 1-1.075.015L2.22 6.53a.75.75 0 0 1 1.06-1.06l1.705 1.704 3.72-3.939a.75.75 0 0 1 1.06-.03"
                />
            </g>
        </g>
    );
}

interface CompressAttachmentButtonProps {
    channelId: string;
    upload: CloudUpload;
}

function CompressAttachmentButton({ channelId, upload }: CompressAttachmentButtonProps) {
    const job = useCompressionJob(upload.uniqueId);
    const channel = ChannelStore.getChannel(channelId);
    if (!upload.isVideo || channel == null || upload.item.file.size <= getUploadFileSizeLimit(channel)) return null;

    const isActive = job ? ACTIVE_JOB_PHASES[job.phase] : false;
    const isComplete = job?.phase === "complete";
    const progress = Math.round(job?.progress ?? 0);
    const tooltip = (() => {
        switch (job?.phase) {
            case "transferring-input":
                return `Preparing Attachment (${progress}%)`;
            case "scanning":
                return `Scanning Attachment (${progress}%)`;
            case "encoding":
                return `Compressing Attachment (${progress}%)`;
            case "transferring-output":
                return `Finalizing Attachment (${progress}%)`;
            case "complete":
                return "Compression Complete (100%)";
            case "cancelled":
                return `Compression Cancelled (${progress}%)`;
            case "error":
                return `Compression Failed (${progress}%)`;
            default:
                return "Compress Attachment";
        }
    })();

    function handleClick() {
        if (isActive) void cancelCompressionJob(upload.uniqueId);
        else void runCompression(channelId, upload, getUploadFileSizeLimit(channel));
    }

    return (
        <ActionBarIcon tooltip={tooltip} onClick={handleClick}>
            <svg
                className={
                    isActive
                        ? "vc-media-compress-icon-container vc-media-compress-is-compressing"
                        : isComplete
                          ? "vc-media-compress-icon-container vc-media-compress-is-compressing vc-media-compress-is-complete"
                          : "vc-media-compress-icon-container"
                }
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 640 640"
                aria-hidden="true"
            >
                <CompressIcon />
                <CompressionProgressIcon progress={progress} />
                <CompressionCompleteIcon />
            </svg>
        </ActionBarIcon>
    );
}

export default definePlugin({
    name: "MediaCompress",
    description: "Compresses media before it is uploaded to Discord.",
    authors: [
        {
            name: "StraiF",
            id: 314034398280286208n
        }
    ],
    tags: ["Media", "Utility"],
    settings,

    patches: [
        {
            find: "#{intl::ATTACHMENT_UTILITIES_SPOILER}",
            replacement: {
                match: /(?<=children:\[)(?=.{10,80}tooltip:.{0,100}#{intl::ATTACHMENT_UTILITIES_SPOILER})/,
                replace: "arguments[0].canEdit!==false?$self.CompressAttachmentButton(arguments[0]):null,"
            }
        },
        // Bypass Nitro's per-file gate while preserving Discord's absolute aggregate-size guard.
        {
            find: '"web.filesExceedUploadLimits"',
            group: true,
            replacement: [
                {
                    match: /(?<=location:"web\.filesExceedUploadLimits"\}\);if\(\i\.enabled\)\{.{0,120}?return )Array\.from\(\i\)\.some\(\i=>\i\.size>\i\)/,
                    replace: "false"
                },
                {
                    match: /(?<=\|\|\i\.\i\(\i\)\}return )\i\.\i\(\i,\i\)(?=\|\|\i\.\i\(\i\)\})/,
                    replace: "false"
                }
            ]
        }
    ],

    async stop() {
        try {
            await Native?.cancelAllCompressions?.();
        } catch (error) {
            logger.warn("Failed to cancel native compression jobs", error);
        }
        const uploadIds = [...compressionJobs.keys()];
        compressionJobs.clear();
        for (const uploadId of uploadIds) emitCompressionJob(uploadId);
    },

    CompressAttachmentButton: ErrorBoundary.wrap(CompressAttachmentButton, { noop: true })
});
