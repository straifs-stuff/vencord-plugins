/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const MIN_OUTPUT_FRAME_RATE = 15;
const MIN_OUTPUT_SHORT_EDGE = 240;
const OUTPUT_FRAME_RATES = [120, 100, 90, 75, 72, 60, 59.94, 50, 48, 30, 29.97, 25, 24, 20, 18, 15];
const SPATIAL_RATE_EXPONENT = 0.9;
const TEMPORAL_RATE_EXPONENT = 0.63;
const REENCODE_QUALITY_HEADROOM = 1.08;
const HARDWARE_RATE_PENALTY = 1.15;
const MIN_OPUS_BITRATE = 48;
const MAX_OPUS_BITRATE = 128;
const OPUS_BITRATE_STEP = 8;

export interface VideoSourceMetadata {
    frameRate: number;
    height: number;
    videoBitrateKbps: number;
    videoCodec: string;
    width: number;
}

export interface OutputVideoPlan {
    frameRate: number;
    height: number;
    width: number;
}
export function chooseOpusBitrate(totalKbps: number): number {
    const preferredBitrate = Math.floor((totalKbps * 0.08) / OPUS_BITRATE_STEP) * OPUS_BITRATE_STEP;
    return Math.min(MAX_OPUS_BITRATE, Math.max(MIN_OPUS_BITRATE, preferredBitrate));
}

export function isHardwareEncoder(encoder: string): boolean {
    return /^(?:mf|nvenc|qsv|vce|vt)_/.test(encoder);
}

function codecRateFactor(codec: string): number {
    const normalized = codec.toLowerCase();
    if (normalized.includes("av1")) return 0.65;
    if (normalized.includes("h265") || normalized.includes("hevc") || normalized.includes("x265")) return 0.75;
    return 1;
}

function bitsPerPixelRange(encoder: string): readonly [minimum: number, maximum: number] {
    const factor = codecRateFactor(encoder);
    if (factor === 0.65) return [0.012, 0.038];
    if (factor === 0.75) return [0.014, 0.045];
    return [0.018, 0.06];
}

function scaledDimensions(width: number, height: number, shortEdge: number): { width: number; height: number } {
    const scale = Math.min(1, shortEdge / Math.min(width, height));
    return {
        height: Math.max(2, Math.floor((height * scale) / 2) * 2),
        width: Math.max(2, Math.floor((width * scale) / 2) * 2)
    };
}

export function chooseVideoPlan(source: VideoSourceMetadata, encoder: string, videoKbps: number): OutputVideoPlan {
    const sourcePixels = source.width * source.height;
    const shortEdge = Math.min(source.width, source.height);
    const minimumShortEdge = Math.min(shortEdge, MIN_OUTPUT_SHORT_EDGE);
    const minimumFrameRate = Math.min(source.frameRate, MIN_OUTPUT_FRAME_RATE);
    const frameRates = [source.frameRate, ...OUTPUT_FRAME_RATES].filter(
        (frameRate, index, values) =>
            frameRate <= source.frameRate && frameRate >= minimumFrameRate && values.indexOf(frameRate) === index
    );
    const hardwarePenalty = isHardwareEncoder(encoder) ? HARDWARE_RATE_PENALTY : 1;
    const [baseMinimumBitsPerPixel, baseMaximumBitsPerPixel] = bitsPerPixelRange(encoder);
    const minimumBitsPerPixel = baseMinimumBitsPerPixel * hardwarePenalty;
    const maximumBitsPerPixel = baseMaximumBitsPerPixel * hardwarePenalty;
    const sourceBitsPerPixel = (Math.max(1, source.videoBitrateKbps) * 1000) / (sourcePixels * source.frameRate);
    const estimatedBitsPerPixel =
        (sourceBitsPerPixel / codecRateFactor(source.videoCodec)) *
        codecRateFactor(encoder) *
        REENCODE_QUALITY_HEADROOM *
        hardwarePenalty;
    const referenceBitsPerPixel = Math.min(maximumBitsPerPixel, Math.max(minimumBitsPerPixel, estimatedBitsPerPixel));
    const referenceKbps = (referenceBitsPerPixel * sourcePixels * source.frameRate) / 1000;

    for (const frameRate of frameRates) {
        const temporalRateRatio = Math.pow(frameRate / source.frameRate, TEMPORAL_RATE_EXPONENT);
        const maximumAreaRatio = Math.min(
            1,
            Math.max(0, Math.pow(videoKbps / (referenceKbps * temporalRateRatio), 1 / SPATIAL_RATE_EXPONENT))
        );
        const dimensions = scaledDimensions(
            source.width,
            source.height,
            Math.max(minimumShortEdge, shortEdge * Math.sqrt(maximumAreaRatio))
        );
        const areaRatio = (dimensions.width * dimensions.height) / sourcePixels;
        const predictedKbps =
            referenceKbps *
            Math.pow(areaRatio, SPATIAL_RATE_EXPONENT) *
            Math.pow(frameRate / source.frameRate, TEMPORAL_RATE_EXPONENT);
        if (predictedKbps <= videoKbps * 1.001) return { ...dimensions, frameRate };
    }

    return {
        ...scaledDimensions(source.width, source.height, minimumShortEdge),
        frameRate: frameRates.at(-1)!
    };
}
