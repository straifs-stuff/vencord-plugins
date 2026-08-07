/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import ErrorBoundary from "@components/ErrorBoundary";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { Paragraph } from "@components/Paragraph";
import { useAwaiter } from "@utils/react";
import type { PluginNative, PluginSettingComponentProps } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import { findByCodeLazy } from "@webpack";

import { Select, useEffect, useState } from "@webpack/common";

import type { HandBrakeEncodersResult } from "./native";
import type * as MediaCompressNative from "./native";

import "./style.css";
const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");
const Native = VencordNative.pluginHelpers.MediaCompress as
    Partial<PluginNative<typeof MediaCompressNative>> | undefined;

const MOCK_PROGRESS_INCREMENT = 5;
const MOCK_PROGRESS_INTERVAL_MS = 125;
const DEFAULT_VIDEO_ENCODER = "x264";
const VIDEO_ENCODER_SETTING_KEYS = ["videoEncoder"] satisfies "videoEncoder"[];
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
    ffv1: "FFV1",
    x264: "H.264 (x264)",
    x264_10bit: "H.264 10-bit (x264)",
    qsv_h264: "H.264 (Intel QSV)",
    vce_h264: "H.264 (AMD VCE)",
    nvenc_h264: "H.264 (NVEnc)",
    mf_h264: "H.264 (MediaFoundation)",
    vt_h264: "H.264 (VideoToolbox)",
    x265: "H.265 (x265)",
    x265_10bit: "H.265 10-bit (x265)",
    x265_12bit: "H.265 12-bit (x265)",
    x265_16bit: "H.265 16-bit (x265)",
    qsv_h265: "H.265 (Intel QSV)",
    qsv_h265_10bit: "H.265 10-bit (Intel QSV)",
    vce_h265: "H.265 (AMD VCE)",
    vce_h265_10bit: "H.265 10-bit (AMD VCE)",
    nvenc_h265: "H.265 (NVEnc)",
    nvenc_h265_10bit: "H.265 10-bit (NVEnc)",
    mf_h265: "H.265 (MediaFoundation)",
    vt_h265: "H.265 (VideoToolbox)",
    vt_h265_10bit: "H.265 10-bit (VideoToolbox)",
    mpeg4: "MPEG-4",
    mpeg2: "MPEG-2",
    VP8: "VP8",
    VP9: "VP9",
    VP9_10bit: "VP9 10-bit",
    dnxhr: "DNxHR",
    dnxhr_10bit: "DNxHR 10-bit",
    ff_prores: "ProRes",
    vt_prores: "ProRes (VideoToolbox)",
    theora: "Theora"
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
    const fallbackEncoder = result.encoders.includes(videoEncoder)
        ? undefined
        : result.encoders.includes(DEFAULT_VIDEO_ENCODER)
          ? DEFAULT_VIDEO_ENCODER
          : result.encoders[0];

    useEffect(() => {
        setSelectedEncoder(videoEncoder);
    }, [videoEncoder]);

    useEffect(() => {
        if (!isPending && fallbackEncoder) {
            setSelectedEncoder(fallbackEncoder);
            setValue(fallbackEncoder);
        }
    }, [fallbackEncoder, isPending, setValue]);

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
              ? "HandBrakeCLI did not report any usable video encoders."
              : "Only encoders reported by this HandBrakeCLI installation are shown.";

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
                    <Paragraph>Use a 10-bit encoder only for HDR or 10-bit sources.</Paragraph>
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

function CompressIcon() {
    return (
        <g className="vc-media-compress-icon vc-media-compress-icon-compress">
            <path d="M0 0h640v640H0z" fill="none" />
            <path
                fill="currentColor"
                d="M503.5 71c9.4-9.4 24.6-9.4 33.9 0l32 32c9.4 9.4 9.4 24.6 0 33.9l-87 87 39 39c6.9 6.9 8.9 17.2 5.2 26.2S514.2 304 504.5 304h-144c-13.3 0-24-10.7-24-24V136c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2l39 39zm-367 265h144c13.3 0 24 10.7 24 24v144c0 9.7-5.8 18.5-14.8 22.2s-19.3 1.7-26.2-5.2l-39-39-87 87c-9.4 9.4-24.6 9.4-33.9 0l-32-32c-9.4-9.4-9.4-24.6 0-33.9l87-87-39-39c-6.9-6.9-8.9-17.2-5.2-26.2s12.4-14.9 22.1-14.9"
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

function CompressAttachmentButton() {
    const [isCompressing, setIsCompressing] = useState(false);
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (!isCompressing || progress === 100) return;

        const timer = setTimeout(() => {
            setProgress(current => Math.min(current + MOCK_PROGRESS_INCREMENT, 100));
        }, MOCK_PROGRESS_INTERVAL_MS);

        return () => clearTimeout(timer);
    }, [isCompressing, progress]);

    function startMockCompression() {
        if (isCompressing) return;

        setProgress(0);
        setIsCompressing(true);
    }

    const isComplete = progress === 100;

    const tooltip = isCompressing
        ? isComplete
            ? "Compression Complete!"
            : `Compressing Attachment (${progress}%)`
        : "Compress Attachment";

    return (
        <ActionBarIcon tooltip={tooltip} onClick={startMockCompression}>
            <svg
                className={
                    isCompressing
                        ? isComplete
                            ? "vc-media-compress-icon-container vc-media-compress-is-compressing vc-media-compress-is-complete"
                            : "vc-media-compress-icon-container vc-media-compress-is-compressing"
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
                replace: "arguments[0].canEdit!==false?$self.CompressAttachmentButton():null,"
            }
        }
    ],

    CompressAttachmentButton: ErrorBoundary.wrap(CompressAttachmentButton, { noop: true })
});
