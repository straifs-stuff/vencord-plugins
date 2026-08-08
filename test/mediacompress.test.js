import assert from "node:assert/strict";
import test from "node:test";

import { chooseOpusBitrate, chooseVideoPlan } from "../mediacompress/planning.ts";

const EASY_FULL_HD_30 = {
    frameRate: 30,
    height: 1080,
    videoBitrateKbps: 1200,
    videoCodec: "h264",
    width: 1920
};

test("video planning retains more resolution for easy-to-encode sources", () => {
    assert.deepEqual(chooseVideoPlan(EASY_FULL_HD_30, "x264", 1200), {
        frameRate: 30,
        height: 1034,
        width: 1838
    });
    assert.deepEqual(chooseVideoPlan({ ...EASY_FULL_HD_30, videoBitrateKbps: 5000 }, "x264", 1200), {
        frameRate: 30,
        height: 574,
        width: 1022
    });
});

test("video planning accounts for the selected codec efficiency", () => {
    const source = { ...EASY_FULL_HD_30, videoBitrateKbps: 5000 };

    assert.deepEqual(chooseVideoPlan(source, "x265", 1200), {
        frameRate: 30,
        height: 674,
        width: 1198
    });
});

test("video planning keeps framerate when a complex screen recording still has sufficient bitrate", () => {
    assert.deepEqual(
        chooseVideoPlan(
            {
                frameRate: 60,
                height: 1600,
                videoBitrateKbps: 5986,
                videoCodec: "h264",
                width: 2560
            },
            "x264",
            1802
        ),
        {
            frameRate: 60,
            height: 786,
            width: 1258
        }
    );
});

test("video planning lowers framerate at extreme size constraints instead of starving every frame", () => {
    assert.deepEqual(
        chooseVideoPlan(
            {
                frameRate: 24,
                height: 1080,
                videoBitrateKbps: 1342,
                videoCodec: "h264",
                width: 1920
            },
            "x264",
            41
        ),
        {
            frameRate: 15,
            height: 240,
            width: 426
        }
    );
});

test("Opus allocation scales from 48 to 128 kbps with the total bitrate budget", () => {
    assert.equal(chooseOpusBitrate(95), 48);
    assert.equal(chooseOpusBitrate(800), 64);
    assert.equal(chooseOpusBitrate(1200), 96);
    assert.equal(chooseOpusBitrate(1946), 128);
    assert.equal(chooseOpusBitrate(5000), 128);
});
