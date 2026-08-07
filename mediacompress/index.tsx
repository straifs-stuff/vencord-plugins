/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 StraiF
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findByCodeLazy } from "@webpack";

const ActionBarIcon = findByCodeLazy("Children.map", "isValidElement", "dangerous:");

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

    CompressAttachmentButton: ErrorBoundary.wrap(
        () => (
            <ActionBarIcon tooltip="Compress Attachment" onClick={() => {}}>
                <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 640 640">
                    <path d="M0 0h640v640H0z" fill="none" />
                    <path
                        fill="currentColor"
                        d="M503.5 71c9.4-9.4 24.6-9.4 33.9 0l32 32c9.4 9.4 9.4 24.6 0 33.9l-87 87l39 39c6.9 6.9 8.9 17.2 5.2 26.2S514.2 304 504.5 304h-144c-13.3 0-24-10.7-24-24V136c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2l39 39zm-367 265h144c13.3 0 24 10.7 24 24v144c0 9.7-5.8 18.5-14.8 22.2s-19.3 1.7-26.2-5.2l-39-39l-87 87c-9.4 9.4-24.6 9.4-33.9 0l-32-32c-9.4-9.4-9.4-24.6 0-33.9l87-87l-39-39c-6.9-6.9-8.9-17.2-5.2-26.2s12.4-14.9 22.1-14.9"
                    />
                </svg>
            </ActionBarIcon>
        ),
        { noop: true }
    )
});
