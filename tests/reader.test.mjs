import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {fetchMotionPhotoVideo} from "../src/motion-photo/reader.ts";

const requestURL = "http://siyuan.test/assets/motion%20%282%29.jpg?style=thumb&box=notebook";

const rangedResponse = (file, start, end) => new Response(file.subarray(start, end + 1), {
    status: 206,
    headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(Math.min(end, file.length - 1) - start + 1),
        "Content-Range": `bytes ${start}-${Math.min(end, file.length - 1)}/${file.length}`,
    },
});

const withBrowserGlobals = async (fetchMock, task) => {
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {location: {href: "http://siyuan.test/", origin: "http://siyuan.test"}},
    });
    globalThis.fetch = fetchMock;
    try {
        await task();
    } finally {
        globalThis.fetch = oldFetch;
        if (oldWindow === undefined) {
            delete globalThis.window;
        } else {
            Object.defineProperty(globalThis, "window", {configurable: true, value: oldWindow});
        }
    }
};

test("reads only the XMP prefix and the MP4 range, stripping thumbnails and retaining notebook selection", async () => {
    const file = new Uint8Array(await readFile("motion (2).jpg"));
    const ranges = [];
    await withBrowserGlobals(async (url, options) => {
        assert.equal(new URL(String(url)).searchParams.get("style"), null);
        assert.equal(new URL(String(url)).searchParams.get("box"), "notebook");
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        const start = Number(match[1]);
        const end = Number(match[2]);
        ranges.push([start, end]);
        return rangedResponse(file, start, end);
    }, async () => {
        const blob = await fetchMotionPhotoVideo(requestURL, new AbortController().signal);
        assert.ok(blob, JSON.stringify(ranges));
        assert.equal(blob.type, "video/mp4");
        assert.equal(blob.size, 506134);
        assert.deepEqual(ranges[0], [0, 256 * 1024 - 1]);
        assert.deepEqual(ranges.at(-1), [2855371, 3361504]);
        assert.ok(ranges.slice(1, -1).every(([start, end]) =>
            end - start < 256 * 1024 && start >= 256 * 1024));
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file.subarray(2855371));
    });
});

test("works when the asset server ignores Range and returns the full file", async () => {
    const video = new Uint8Array(await readFile("motion (2).jpg"));
    const originalFetch = async () => new Response(video, {
        status: 200,
        headers: {"Content-Length": String(video.length)},
    });
    await withBrowserGlobals(originalFetch, async () => {
        const blob = await fetchMotionPhotoVideo(requestURL, new AbortController().signal);
        assert.ok(blob);
        assert.equal(blob.size, 506134);
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), video.subarray(2855371));
    });
});

test("finds a valid appended video after the JPEG when metadata is missing", async () => {
    const jpeg = new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe0, 0, 4, 0x11, 0x22,
        0xff, 0xda, 0, 2,
        0x1f,
        0xff, 0xd9,
    ]);
    const makeBox = (type, body = new Uint8Array()) => {
        const box = new Uint8Array(body.length + 8);
        new DataView(box.buffer).setUint32(0, box.length);
        box.set([...type].map(character => character.charCodeAt(0)), 4);
        box.set(body, 8);
        return box;
    };
    const mp4 = new Uint8Array([
        ...makeBox("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])),
        ...makeBox("moov"),
        ...makeBox("mdat"),
    ]);
    const file = new Uint8Array([...jpeg, ...mp4]);
    await withBrowserGlobals(async (_url, options) => {
        assert.match(options.headers.Range, /^bytes=0-/);
        return new Response(file, {status: 200, headers: {"Content-Length": String(file.length)}});
    }, async () => {
        const blob = await fetchMotionPhotoVideo(requestURL, new AbortController().signal);
        assert.ok(blob);
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), mp4);
    });
});

test("finds a range-served MP4 after a long JPEG from its trailing movie box", async () => {
    const image = new Uint8Array(300 * 1024).fill(0x41);
    image.set([0xff, 0xd8], 0);
    image.set([0xff, 0xd9], image.length - 2);
    const makeBox = (type, size) => {
        const result = new Uint8Array(size);
        new DataView(result.buffer).setUint32(0, size);
        result.set([...type].map(character => character.charCodeAt(0)), 4);
        if (type === "ftyp") {
            result.set([0x69, 0x73, 0x6f, 0x6d], 8);
        }
        return result;
    };
    const mp4 = new Uint8Array([
        ...makeBox("ftyp", 16),
        ...makeBox("mdat", 500 * 1024 - 24),
        ...makeBox("moov", 8),
    ]);
    const file = new Uint8Array([...image, ...mp4]);
    const ranges = [];
    await withBrowserGlobals(async (_url, options) => {
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        const start = Number(match[1]);
        const end = Number(match[2]);
        ranges.push([start, end]);
        return rangedResponse(file, start, end);
    }, async () => {
        const blob = await fetchMotionPhotoVideo(requestURL, new AbortController().signal);
        assert.ok(blob, JSON.stringify(ranges));
        assert.equal(blob.size, mp4.length);
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), mp4);
        assert.ok(ranges.every(([start, end]) => end < 256 * 1024 || start >= file.length - 512 * 1024));
    });
});

test("does not scan an ordinary large JPEG from the front to find its image terminator", async () => {
    const file = new Uint8Array(1024 * 1024).fill(0x41);
    file.set([0xff, 0xd8, 0xff, 0xda], 0);
    file.set([0xff, 0xd9], file.length - 2);
    const ranges = [];
    await withBrowserGlobals(async (_url, options) => {
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        const start = Number(match[1]);
        const end = Number(match[2]);
        ranges.push([start, end]);
        return rangedResponse(file, start, end);
    }, async () => {
        const blob = await fetchMotionPhotoVideo(requestURL, new AbortController().signal);
        assert.equal(blob, undefined);
        assert.deepEqual(ranges, [[0, 256 * 1024 - 1], [file.length - 256 * 1024, file.length - 1]]);
    });
});

test("ignores external images, non-JPEG assets, missing files, and aborted range reads", async () => {
    let fetchCount = 0;
    await withBrowserGlobals(async () => {
        fetchCount += 1;
        return new Response("missing", {status: 404});
    }, async () => {
        const signal = new AbortController().signal;
        assert.equal(await fetchMotionPhotoVideo("https://external.example/photo.jpg", signal), undefined);
        assert.equal(await fetchMotionPhotoVideo("/assets/video.mp4", signal), undefined);
        assert.equal(fetchCount, 0);
        assert.equal(await fetchMotionPhotoVideo(requestURL, signal), undefined);
        assert.equal(fetchCount, 1);

        const controller = new AbortController();
        controller.abort();
        globalThis.fetch = async (_url, options) => {
            assert.ok(options.signal.aborted);
            throw new DOMException("Aborted", "AbortError");
        };
        await assert.rejects(fetchMotionPhotoVideo(requestURL, controller.signal), {name: "AbortError"});
    });
});
