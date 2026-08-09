/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Card } from "@components/Card";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { classes, sleep } from "@utils/misc";
import { useAwaiter } from "@utils/react";
import definePlugin, { OptionType, type PluginNative, type PluginSettingComponentProps } from "@utils/types";
import type { Channel, CloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform, DraftType } from "@vencord/discord-types/enums";
import {
    filters,
    findByCodeLazy,
    findComponentByCodeLazy,
    findCssClassesLazy,
    findLazy,
    mapMangledModuleLazy
} from "@webpack";
import {
    Button,
    ChannelRouter,
    ChannelStore,
    Clickable,
    Popout,
    ScrollerThin,
    Select,
    showToast,
    Toasts,
    Tooltip,
    UploadAttachmentStore,
    UploadManager,
    useEffect,
    useRef,
    UserStore,
    useState
} from "@webpack/common";
import type { ReactNode } from "react";

import type * as MediaCompressNative from "./native";
import type { CompressionStatus, HandBrakeEncodersResult } from "./native";

const logger = new Logger("MediaCompress");
const CloudUploader = findLazy(module => module.prototype?.trackUploadFinished) as typeof CloudUpload;
const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");
const AttachmentDeleteIcon = findComponentByCodeLazy("2.81h8.36a3");
const DiscordWarningIcon = findComponentByCodeLazy("3.15H3.29c-1.74");
const ExpressionPickerClasses = findCssClassesLazy("contentWrapper", "drawerSizingWrapper", "nav");
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
const AUTO_SEND_SETTING_KEYS = ["autoSend"] satisfies "autoSend"[];
const ACTIVE_NATIVE_JOB_PHASES: Partial<Record<RendererCompressionPhase, true>> = {
    "transferring-input": true,
    scanning: true,
    encoding: true,
    "transferring-output": true
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
            <Card>
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
    },
    autoSend: {
        type: OptionType.BOOLEAN,
        description: "Automatically send each compressed video to its original channel when it is ready.",
        default: true
    }
});

type RendererCompressionPhase =
    "queued" | "transferring-input" | "scanning" | "encoding" | "transferring-output" | "ready" | "sending" | "error";

type CompressionFailureStage = "compression" | "sending";

interface RendererCompressionJob {
    cancelled: boolean;
    channelId: string;
    compressedFile?: File;
    description: string | null;
    error?: string;
    errorStage?: CompressionFailureStage;
    file: File;
    id: string;
    origin?: string;
    outputSize?: number;
    phase: RendererCompressionPhase;
    progress: number;
    sendingUpload?: CloudUpload;
    sensitive: boolean;
    spoiler: boolean;
    targetSize: number;
    token?: string;
}

class CompressionCancelledError extends Error {}

const compressionJobs = new Map<string, RendererCompressionJob>();
const compressionQueueListeners = new Set<() => void>();
let queueProcessing = false;

function emitCompressionQueue() {
    for (const listener of compressionQueueListeners) listener();
}

function isCurrentJob(job: RendererCompressionJob) {
    return compressionJobs.get(job.id) === job;
}

function updateCompressionJob(job: RendererCompressionJob, update: Partial<RendererCompressionJob>) {
    if (!isCurrentJob(job)) return;
    Object.assign(job, update);
    emitCompressionQueue();
}

function useCompressionQueue(): RendererCompressionJob[] {
    const [, forceUpdate] = useState(0);

    useEffect(() => {
        const listener = () => forceUpdate(version => version + 1);
        compressionQueueListeners.add(listener);
        return () => void compressionQueueListeners.delete(listener);
    }, []);

    return Array.from(compressionJobs.values());
}

function throwIfCancelled(job: RendererCompressionJob) {
    if (job.cancelled || !isCurrentJob(job)) throw new CompressionCancelledError();
}

function compressedFileName(fileName: string): string {
    const extensionIndex = fileName.lastIndexOf(".");
    return `${extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName}.mp4`;
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function getChannelDisplayName(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return "Unknown channel";
    if (channel.guild_id) return `#${channel.name}`;
    if (channel.isGroupDM()) return channel.name || "Group DM";

    const recipient = UserStore.getUser(channel.recipients?.[0]);
    return recipient ? `@${recipient.username}` : "Direct Message";
}

function createCloudUpload(job: RendererCompressionJob, file: File): CloudUpload {
    const upload = new CloudUploader(
        {
            file,
            origin: job.origin,
            platform: CloudUploadPlatform.WEB
        },
        job.channelId
    );
    upload.description = job.description;
    upload.sensitive = job.sensitive;
    upload.spoiler = job.spoiler;
    return upload;
}

function cancelSendingUpload(job: RendererCompressionJob) {
    const upload = job.sendingUpload;
    job.sendingUpload = undefined;
    if (!upload) return;

    try {
        upload.cancel();
    } catch (error) {
        logger.warn("Failed to cancel compressed video upload", error);
    }
}

function removeDraftUpload(channelId: string, upload: CloudUpload) {
    const uploads = [...UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)];
    const remainingUploads = uploads.filter(item => item.uniqueId !== upload.uniqueId && item.id !== upload.id);
    if (remainingUploads.length === uploads.length)
        throw new Error("The video is no longer present in the message draft.");

    UploadManager.setUploads({ uploads: remainingUploads, channelId, draftType: DraftType.ChannelMessage });
}

function rendererPhase(status: CompressionStatus): RendererCompressionPhase {
    switch (status.phase) {
        case "receiving":
            return "transferring-input";
        case "complete":
            return "transferring-output";
        case "cancelled":
        case "error":
            return "error";
        default:
            return status.phase;
    }
}

function rendererProgress(status: CompressionStatus): number {
    switch (status.phase) {
        case "receiving":
            return status.progress * 5;
        case "scanning":
            return 5 + status.progress * 5;
        case "encoding":
            return 10 + status.progress * 90;
        case "complete":
            return 100;
        case "cancelled":
        case "error":
            return 0;
    }
}

function hasNativeCompressionHelpers() {
    return (
        typeof Native?.beginCompressionInput === "function" &&
        typeof Native.writeCompressionChunk === "function" &&
        typeof Native.startCompression === "function" &&
        typeof Native.getCompressionStatus === "function" &&
        typeof Native.readCompressionOutputChunk === "function" &&
        typeof Native.releaseCompression === "function"
    );
}
async function releaseCompressionOutput(job: RendererCompressionJob) {
    const { token } = job;
    job.token = undefined;
    if (!token || typeof Native?.releaseCompression !== "function") return;

    const result = await Native.releaseCompression(token).catch(() => undefined);
    if (result && !result.success) logger.warn("Failed to release compressed video output", result.error);
}

async function revealCompressionOutput(job: RendererCompressionJob) {
    if (!job.token) {
        showToast("The compressed output is not ready yet.", Toasts.Type.FAILURE);
        return;
    }
    if (typeof Native?.revealCompressionOutput !== "function") {
        showToast("Restart Discord to load the updated MediaCompress file browser helper.", Toasts.Type.FAILURE);
        return;
    }

    const result = await Native.revealCompressionOutput(job.token).catch(() => undefined);
    if (result?.success) return;

    const message = result?.error || "Could not open the compressed output in the file browser.";
    logger.warn("Failed to reveal compressed video output", message);
    showToast(message, Toasts.Type.FAILURE);
}

async function sendCompressionJob(job: RendererCompressionJob) {
    if (!job.compressedFile || !isCurrentJob(job) || job.phase === "sending") return;

    const upload = createCloudUpload(job, job.compressedFile);
    job.sendingUpload = upload;
    updateCompressionJob(job, { error: undefined, errorStage: undefined, phase: "sending", progress: 100 });
    try {
        await sendMessage(job.channelId, {}, true, {
            attachmentsToUpload: [upload]
        });
        if (!isCurrentJob(job)) return;
        await releaseCompressionOutput(job);
        job.compressedFile = undefined;
        job.sendingUpload = undefined;
        compressionJobs.delete(job.id);
        emitCompressionQueue();
    } catch (error) {
        if (job.sendingUpload === upload) cancelSendingUpload(job);
        if (!isCurrentJob(job)) return;
        const message = error instanceof Error ? error.message : "Sending the compressed video failed.";
        logger.warn("Compressed video send failed", message);
        updateCompressionJob(job, {
            compressedFile: job.compressedFile,
            error: message,
            errorStage: "sending",
            phase: "error"
        });
        showToast(message, Toasts.Type.FAILURE);
    } finally {
        if (job.sendingUpload === upload) job.sendingUpload = undefined;
    }
}

async function runCompression(job: RendererCompressionJob) {
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
        const message = "Restart Discord to load the updated MediaCompress native helper.";
        updateCompressionJob(job, { error: message, errorStage: "compression", phase: "error" });
        showToast(message, Toasts.Type.FAILURE);
        return;
    }

    updateCompressionJob(job, {
        cancelled: false,
        compressedFile: undefined,
        error: undefined,
        errorStage: undefined,
        outputSize: undefined,
        phase: "transferring-input",
        progress: 0
    });

    let token: string | undefined;
    let keepOutput = false;
    try {
        const beginResult = await beginCompressionInput({
            encoder: settings.store.videoEncoder || DEFAULT_VIDEO_ENCODER,
            fileName: job.file.name,
            fileSize: job.file.size,
            targetSize: job.targetSize
        });
        if (!beginResult.success) throw new Error(beginResult.error);
        token = beginResult.token;
        updateCompressionJob(job, { token });
        throwIfCancelled(job);

        for (let offset = 0; offset < job.file.size; offset += IPC_CHUNK_SIZE) {
            throwIfCancelled(job);
            const end = Math.min(offset + IPC_CHUNK_SIZE, job.file.size);
            const data = new Uint8Array(await job.file.slice(offset, end).arrayBuffer());
            const result = await writeCompressionChunk(token, offset, data);
            if (!result.success) throw new Error(result.error);
            updateCompressionJob(job, {
                phase: "transferring-input",
                progress: (end / job.file.size) * 5
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
            if (status.phase === "error") throw new Error(status.error || "Video compression failed.");
            if (status.phase === "cancelled") throw new CompressionCancelledError();

            const measuredProgress = rendererProgress(status);
            updateCompressionJob(job, {
                error: status.error,
                phase: rendererPhase(status),
                progress: Math.max(job.progress, measuredProgress)
            });

            if (status.phase === "complete") {
                outputSize = status.outputSize;
                break;
            }
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
        }

        throwIfCancelled(job);
        const compressedFile = new File(outputParts, compressedFileName(job.file.name), {
            lastModified: Date.now(),
            type: "video/mp4"
        });
        outputParts.length = 0;

        keepOutput = true;
        updateCompressionJob(job, { compressedFile, outputSize, phase: "ready", progress: 100 });
        if (settings.store.autoSend) await sendCompressionJob(job);
    } catch (error) {
        if (error instanceof CompressionCancelledError || job.cancelled || !isCurrentJob(job)) return;

        const message = error instanceof Error ? error.message : "Video compression failed.";
        logger.warn("Compression failed", message);
        updateCompressionJob(job, { error: message, errorStage: "compression", phase: "error" });
        showToast(message, Toasts.Type.FAILURE);
    } finally {
        if (token && !keepOutput) {
            await releaseCompression(token).catch(() => {});
            if (isCurrentJob(job) && job.token === token) job.token = undefined;
        }
    }
}

function findNextQueuedJob(): RendererCompressionJob | undefined {
    for (const job of compressionJobs.values()) {
        if (job.phase === "queued") return job;
    }
}

async function processCompressionQueue() {
    if (queueProcessing) return;
    queueProcessing = true;
    try {
        for (;;) {
            const job = findNextQueuedJob();
            if (!job) break;
            await runCompression(job);
        }
    } finally {
        queueProcessing = false;
        if (findNextQueuedJob()) void processCompressionQueue();
    }
}

function enqueueCompression(channelId: string, upload: CloudUpload, targetSize: number) {
    if (!hasNativeCompressionHelpers()) {
        showToast("Restart Discord to load the updated MediaCompress native helper.", Toasts.Type.FAILURE);
        return;
    }
    if (compressionJobs.has(upload.uniqueId)) return;

    const job: RendererCompressionJob = {
        cancelled: false,
        channelId,
        description: upload.description,
        file: upload.item.file,
        id: upload.uniqueId,
        origin: upload.origin,
        phase: "queued",
        progress: 0,
        sensitive: upload.sensitive,
        spoiler: upload.spoiler,
        targetSize
    };

    try {
        removeDraftUpload(channelId, upload);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Could not remove the video from the message draft.";
        logger.warn("Failed to queue attachment", message);
        showToast(message, Toasts.Type.FAILURE);
        return;
    }

    compressionJobs.set(job.id, job);
    emitCompressionQueue();
    void processCompressionQueue();
}

async function removeCompressionJob(jobId: string) {
    const job = compressionJobs.get(jobId);
    if (!job) return;

    job.cancelled = true;
    const { token } = job;
    job.token = undefined;
    cancelSendingUpload(job);
    job.compressedFile = undefined;
    compressionJobs.delete(job.id);
    emitCompressionQueue();

    if (!token) return;
    const operation = ACTIVE_NATIVE_JOB_PHASES[job.phase]
        ? Native?.cancelCompression?.(token)
        : Native?.releaseCompression?.(token);
    const result = await operation?.catch(() => undefined);
    if (result && !result.success) logger.warn("Failed to discard native compression job", result.error);
}

function retryCompressionJob(job: RendererCompressionJob) {
    if (!isCurrentJob(job) || job.phase !== "error") return;
    if (job.errorStage === "sending" && job.compressedFile) {
        void sendCompressionJob(job);
        return;
    }

    updateCompressionJob(job, {
        cancelled: false,
        compressedFile: undefined,
        error: undefined,
        errorStage: undefined,
        outputSize: undefined,
        phase: "queued",
        progress: 0
    });
    void processCompressionQueue();
}

function CompressionActionIcon() {
    return (
        <svg
            className="vc-media-compress-icon-container"
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 640 640"
            aria-hidden="true"
        >
            <path d="M0 0h640v640H0z" fill="none" />
            <path
                fill="currentColor"
                d="M503.5 71c9.4-9.4 24.6-9.4 33.9 0l32 32c9.4 9.4 9.4 24.6 0 33.9l-87 87 39 39c6.9 6.9 8.9 17.2 5.2 26.2S514.2 304 504.5 304h-144c-13.3 0-24-10.7-24-24V136c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2l39 39zm-367 265h144c13.3 0 24 10.7 24 24v144c0 9.7-5.8 18.5-14.8 22.2s-19.3-1.7-26.2-5.2l-39-39-87 87c-9.4 9.4-24.6 9.4-33.9 0l-32-32c-9.4-9.4-9.4-24.6 0-33.9l87-87-39-39c-6.9-6.9-8.9-17.2-5.2-26.2s12.4-14.9 22.1-14.9"
            />
        </svg>
    );
}

function CompressionQueueIcon() {
    return (
        <svg
            className="vc-media-compress-queue-icon"
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            viewBox="0 0 256 256"
            aria-hidden="true"
        >
            <path d="M0 0h256v256H0z" fill="none" />
            <path
                fill="currentColor"
                d="M208 32H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16M64 72h128a8 8 0 0 1 0 16H64a8 8 0 0 1 0-16m40 112H64a8 8 0 0 1 0-16h40a8 8 0 0 1 0 16m0-48H64a8 8 0 0 1 0-16h40a8 8 0 0 1 0 16m92.44 22.66l-48 32A8 8 0 0 1 144 192a8 8 0 0 1-8-8v-64a8 8 0 0 1 12.44-6.66l48 32a8 8 0 0 1 0 13.32"
            />
        </svg>
    );
}

function FolderIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
                fill="currentColor"
                d="M19.5 21a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-15a3 3 0 0 0-3 3V18a3 3 0 0 0 3 3zm-18-10.854V6a3 3 0 0 1 3-3h5.379a2.25 2.25 0 0 1 1.59.659l2.122 2.121c.14.141.331.22.53.22H19.5a3 3 0 0 1 3 3v1.146A4.48 4.48 0 0 0 19.5 9h-15a4.48 4.48 0 0 0-3 1.146"
            />
        </svg>
    );
}

function SendIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
                fill="currentColor"
                d="M18.815 3.585c.996-.36 1.96.604 1.6 1.6l-5.646 15.61c-.361 1-1.725 1.121-2.257.202l-2.982-5.15a1 1 0 0 0 .177-.139l5-5a1 1 0 0 0-1.414-1.414l-5 5a1 1 0 0 0-.14.176l-5.15-2.982c-.92-.532-.798-1.895.201-2.257z"
            />
        </svg>
    );
}

function ConversationIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
                fill="currentColor"
                fillRule="evenodd"
                d="M4.75 3.005h10a2.755 2.755 0 0 1 2.75 2.75v6.505a2.755 2.755 0 0 1-2.75 2.75H6.56l-2.425 2.425a1.25 1.25 0 0 1-1.365.27A1.25 1.25 0 0 1 2 16.55V5.755a2.755 2.755 0 0 1 2.75-2.75M19 7.505h.245a2.755 2.755 0 0 1 2.75 2.75v10.29a1.24 1.24 0 0 1-1.25 1.25c-.32 0-.64-.125-.88-.365l-1.925-1.925h-6.19A2.755 2.755 0 0 1 9 16.755V16.5h5.75A4.253 4.253 0 0 0 19 12.25z"
                clipRule="evenodd"
            />
        </svg>
    );
}

function QueueThumbnail({ file }: { file: File }) {
    const [source] = useState(() => URL.createObjectURL(file));
    useEffect(() => () => URL.revokeObjectURL(source), [source]);

    return <video className="vc-media-compress-queue-thumbnail" src={source} muted preload="metadata" />;
}

function compressionPhaseLabel(job: RendererCompressionJob): string {
    const progress = Math.round(job.progress);
    switch (job.phase) {
        case "queued":
            return "Queued";
        case "transferring-input":
            return `Preparing (${progress}%)`;
        case "scanning":
            return `Scanning (${progress}%)`;
        case "encoding":
            return `Compressing (${progress}%)`;
        case "transferring-output":
            return "Compressing (100%)";
        case "ready":
            return "Ready to send";
        case "sending":
            return "Sending";
        case "error":
            return "Failed";
    }
}
interface QueueActionButtonProps {
    children: ReactNode;
    dangerous?: boolean;
    disabled?: boolean;
    label: string;
    onClick(): void;
}

function QueueActionButton({ children, dangerous, disabled, label, onClick }: QueueActionButtonProps) {
    const className = classes(
        "vc-media-compress-queue-action",
        dangerous && "vc-media-compress-queue-action-dangerous",
        disabled && "vc-media-compress-queue-action-disabled"
    );

    if (disabled)
        return (
            <Clickable aria-disabled="true" aria-label={label} className={className} role="button" tabIndex={-1}>
                {children}
            </Clickable>
        );

    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <Clickable
                    {...tooltipProps}
                    aria-label={label}
                    className={className}
                    role="button"
                    tabIndex={0}
                    onClick={onClick}
                >
                    {children}
                </Clickable>
            )}
        </Tooltip>
    );
}

interface CompressionQueueRowProps {
    closePopout(): void;
    job: RendererCompressionJob;
    position: number;
}

function CompressionQueueRow({ closePopout, job, position }: CompressionQueueRowProps) {
    const { autoSend } = settings.use(AUTO_SEND_SETTING_KEYS);
    const phaseLabel = compressionPhaseLabel(job);
    const sourceLabel = getChannelDisplayName(job.channelId);
    const canUseOutput = Boolean(job.compressedFile && job.token) && job.phase !== "sending";
    const canSend = Boolean(job.compressedFile) && job.phase !== "sending";
    const canRemove = job.phase !== "sending";
    const compressionRatio = job.file.size / job.targetSize;
    const hasSevereCompressionRatio = compressionRatio > 5;
    const roundedCompressionRatio = Math.round(compressionRatio * 10) / 10;
    const progressState =
        job.phase === "ready" || job.phase === "sending"
            ? "success"
            : job.phase === "error"
              ? "danger"
              : ACTIVE_NATIVE_JOB_PHASES[job.phase]
                ? "active"
                : undefined;

    function openDestination() {
        closePopout();
        ChannelRouter.transitionToChannel(job.channelId);
    }

    return (
        <div className="vc-media-compress-queue-row">
            <QueueThumbnail file={job.file} />
            <div className="vc-media-compress-queue-details">
                <div className="vc-media-compress-queue-filename" title={job.file.name}>
                    {job.file.name}
                    <span className="vc-media-compress-queue-position">#{position}</span>
                </div>
                <div className="vc-media-compress-queue-meta">
                    {hasSevereCompressionRatio ? (
                        <Tooltip
                            text={`This video is ${roundedCompressionRatio}x the file limit. Compression may significantly reduce quality.`}
                        >
                            {tooltipProps => (
                                <span
                                    {...tooltipProps}
                                    className={classes(
                                        "vc-media-compress-queue-size",
                                        "vc-media-compress-queue-size-warning"
                                    )}
                                >
                                    <DiscordWarningIcon
                                        aria-hidden="true"
                                        color="currentColor"
                                        height={14}
                                        width={14}
                                    />
                                    {formatFileSize(job.file.size)}
                                </span>
                            )}
                        </Tooltip>
                    ) : (
                        <span className="vc-media-compress-queue-size">{formatFileSize(job.file.size)}</span>
                    )}
                </div>
                {job.error && <div className="vc-media-compress-queue-error">{job.error}</div>}
                <div className="vc-media-compress-queue-footer">
                    <div className="vc-media-compress-queue-phase">
                        <span>{phaseLabel}</span>
                        <div
                            className="vc-media-compress-queue-progress"
                            role="progressbar"
                            aria-label={phaseLabel}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(job.progress)}
                        >
                            <div
                                className={classes(
                                    "vc-media-compress-queue-progress-fill",
                                    progressState && `vc-media-compress-queue-progress-fill-${progressState}`
                                )}
                                style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }}
                            />
                        </div>
                    </div>
                    <div className="vc-media-compress-queue-actions">
                        {job.phase === "error" && job.errorStage === "compression" && (
                            <Button
                                className="vc-media-compress-queue-retry"
                                color={Button.Colors.BRAND}
                                look={Button.Looks.LINK}
                                size={Button.Sizes.SMALL}
                                onClick={() => retryCompressionJob(job)}
                            >
                                Retry
                            </Button>
                        )}
                        {!autoSend && (
                            <>
                                <QueueActionButton
                                    label="Open in File Browser"
                                    disabled={!canUseOutput}
                                    onClick={() => void revealCompressionOutput(job)}
                                >
                                    <FolderIcon />
                                </QueueActionButton>
                                <QueueActionButton
                                    label={`Send in "${sourceLabel}"`}
                                    disabled={!canSend}
                                    onClick={() => void sendCompressionJob(job)}
                                >
                                    <SendIcon />
                                </QueueActionButton>
                            </>
                        )}
                        {autoSend && job.errorStage === "sending" && (
                            <QueueActionButton
                                label={`Send in "${sourceLabel}"`}
                                onClick={() => void sendCompressionJob(job)}
                            >
                                <SendIcon />
                            </QueueActionButton>
                        )}
                        <QueueActionButton label={`Go to "${sourceLabel}"`} onClick={openDestination}>
                            <ConversationIcon />
                        </QueueActionButton>
                        <QueueActionButton
                            label="Remove from Queue"
                            dangerous
                            disabled={!canRemove}
                            onClick={() => void removeCompressionJob(job.id)}
                        >
                            <AttachmentDeleteIcon width={20} height={20} />
                        </QueueActionButton>
                    </div>
                </div>
            </div>
        </div>
    );
}

function CompressionQueuePopout({ closePopout }: { closePopout(): void }) {
    const jobs = useCompressionQueue();

    return (
        <div
            className={classes(ExpressionPickerClasses.contentWrapper, "vc-media-compress-queue-popout")}
            role="dialog"
            aria-label="Compression Queue"
        >
            <BaseText className="vc-media-compress-queue-header" size="md" weight="semibold">
                Compression Queue
            </BaseText>
            {jobs.length === 0 ? (
                <div className="vc-media-compress-queue-empty">No videos are queued.</div>
            ) : (
                <ScrollerThin className="vc-media-compress-queue-list">
                    {jobs.map((job, index) => (
                        <CompressionQueueRow closePopout={closePopout} job={job} position={index + 1} key={job.id} />
                    ))}
                </ScrollerThin>
            )}
        </div>
    );
}

const CompressionQueueButton: ChatBarButtonFactory = ({ isAnyChat }) => {
    const buttonRef = useRef<HTMLDivElement>(null);
    if (!isAnyChat) return null;

    return (
        <Popout
            position="top"
            align="right"
            targetElementRef={buttonRef}
            renderPopout={({ closePopout }) => <CompressionQueuePopout closePopout={closePopout} />}
        >
            {popoutProps => (
                <div className="vc-media-compress-queue-button-anchor" ref={buttonRef}>
                    <ChatBarButton
                        tooltip="Compression Queue"
                        onClick={popoutProps.onClick}
                        buttonProps={{ "aria-haspopup": "dialog" }}
                    >
                        <CompressionQueueIcon />
                    </ChatBarButton>
                </div>
            )}
        </Popout>
    );
};

interface QueueAttachmentButtonProps {
    channelId: string;
    upload: CloudUpload;
}

function QueueAttachmentButton({ channelId, upload }: QueueAttachmentButtonProps) {
    const channel = ChannelStore.getChannel(channelId);
    if (!upload.isVideo || channel == null || upload.item.file.size <= getUploadFileSizeLimit(channel)) return null;

    return (
        <ActionBarIcon
            tooltip="Send to Compression Queue"
            onClick={() => enqueueCompression(channelId, upload, getUploadFileSizeLimit(channel))}
        >
            <CompressionActionIcon />
        </ActionBarIcon>
    );
}

export default definePlugin({
    name: "MediaCompress",
    description: "Queues oversized videos for compression and sends them separately.",
    authors: [
        {
            name: "StraiF",
            id: 314034398280286208n
        }
    ],
    tags: ["Media", "Utility"],
    settings,

    chatBarButton: {
        icon: CompressionQueueIcon,
        render: CompressionQueueButton
    },

    patches: [
        {
            find: "#{intl::ATTACHMENT_UTILITIES_SPOILER}",
            replacement: {
                match: /(?<=children:\[)(?=.{10,80}tooltip:.{0,100}#{intl::ATTACHMENT_UTILITIES_SPOILER})/,
                replace: "arguments[0].canEdit!==false?$self.QueueAttachmentButton(arguments[0]):null,"
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
        for (const job of compressionJobs.values()) {
            job.cancelled = true;
            cancelSendingUpload(job);
            job.compressedFile = undefined;
        }
        try {
            await Native?.cancelAllCompressions?.();
        } catch (error) {
            logger.warn("Failed to cancel native compression jobs", error);
        }
        compressionJobs.clear();
        emitCompressionQueue();
    },

    QueueAttachmentButton: ErrorBoundary.wrap(QueueAttachmentButton, { noop: true })
});
