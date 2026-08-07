/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findByCodeLazy } from "@webpack";

import { useEffect, useState } from "@webpack/common";

import "./style.css";
const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");

const MOCK_PROGRESS_INCREMENT = 5;
const MOCK_PROGRESS_INTERVAL_MS = 125;

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
