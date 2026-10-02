import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {registerHooks} from "node:module";
import {test} from "node:test";
import {parseHTML} from "linkedom";

globalThis.__motionPhotoMessages = [];
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "siyuan") {
            const source = `
                export const showMessage = (message) => globalThis.__motionPhotoMessages.push(message);
                export const getFrontend = () => globalThis.__motionPhotoPlatform?.frontend ?? 'desktop';
                export const getBackend = () => globalThis.__motionPhotoPlatform?.backend ?? 'windows';
                export const saveExportFile = (uri) => globalThis.__motionPhotoNativeExport(uri);
            `;
            return {url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true};
        }
        return nextResolve(specifier, context);
    },
});

const {MotionPhotoViewerBridge} = await import("../src/motion-photo/viewer.ts");
const fixture = new Uint8Array(await readFile("motion (2).jpg"));
const strings = JSON.parse(await readFile("src/i18n/zh-CN.json", "utf8"));

const rangedResponse = (start, end) => new Response(fixture.subarray(start, end + 1), {
    status: 206,
    headers: {
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${fixture.length}`,
    },
});

const createHarness = ({codec = "probably", rejectFirstPlay = false, fetchMock, nativeExport,
    android = false, openExternal} = {}) => {
    const {document, window} = parseHTML("<html><body></body></html>");
    Object.defineProperty(window, "location", {
        configurable: true,
        value: new URL("http://siyuan.test/"),
    });
    const image = document.createElement("img");
    image.src = "http://siyuan.test/assets/motion%20%282%29.jpg?style=thumb&box=notebook";
    image.className = "viewer-image";
    const nativeImage = document.createElement("img");
    nativeImage.src = image.src;
    nativeImage.className = "viewer-image";
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "viewer-container";
    const canvas = document.createElement("div");
    canvas.className = "viewer-canvas";
    canvas.append(nativeImage);
    const toolbar = document.createElement("ul");
    toolbar.className = "viewer-toolbar";
    for (const className of ["viewer-prev", "viewer-next", "viewer-close", "viewer-zoom-in", "viewer-rotate-left"]) {
        const item = document.createElement("li");
        item.className = className;
        toolbar.append(item);
    }
    viewerRoot.append(canvas, toolbar);
    const eventTarget = document.createElement("div");
    document.body.append(viewerRoot, eventTarget);

    let videoElement;
    let playCalls = 0;
    const originalCreateElement = document.createElement.bind(document);
    Object.defineProperty(document, "createElement", {
        configurable: true,
        value(tagName, options) {
            const element = originalCreateElement(tagName, options);
            if (String(tagName).toLowerCase() === "video") {
                videoElement = element;
                element.paused = true;
                element.ended = false;
                element.duration = 1.43;
                element.currentTime = 0;
                element.error = null;
                element.play = async () => {
                    playCalls += 1;
                    if (rejectFirstPlay && playCalls === 1) {
                        throw new DOMException("Autoplay blocked", "NotAllowedError");
                    }
                    element.paused = false;
                    element.ended = false;
                };
                element.pause = () => {
                    element.paused = true;
                };
                element.load = () => {};
                element.canPlayType = () => codec;
            }
            return element;
        },
    });

    const viewer = {
        element: eventTarget,
        viewer: viewerRoot,
        toolbar: viewerRoot,
        image,
        viewed: true,
    };
    window.siyuan = {viewer};
    const oldGlobals = {
        document: globalThis.document,
        window: globalThis.window,
        fetch: globalThis.fetch,
        MutationObserver: globalThis.MutationObserver,
        createObjectURL: URL.createObjectURL,
        revokeObjectURL: URL.revokeObjectURL,
        platform: globalThis.__motionPhotoPlatform,
        nativeExport: globalThis.__motionPhotoNativeExport,
    };
    const revoked = [];
    globalThis.document = document;
    globalThis.window = window;
    globalThis.__motionPhotoPlatform = android ? {frontend: "mobile", backend: "android"} :
        {frontend: "desktop", backend: "windows"};
    globalThis.__motionPhotoNativeExport = nativeExport ?? (async () => ({status: "success"}));
    if (android) {
        window.JSAndroid = {openExternal: openExternal ?? (() => {})};
    }
    globalThis.MutationObserver = class {
        observe() {}
        disconnect() {}
    };
    globalThis.fetch = fetchMock ?? (async (_url, options) => {
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        return rangedResponse(Number(match[1]), Number(match[2]));
    });
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: () => "blob:motion-photo-test",
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: (url) => revoked.push(url),
    });

    const bridge = new MotionPhotoViewerBridge(strings);
    const viewed = (nextImage = image) => {
        viewer.image = nextImage;
        eventTarget.dispatchEvent(new window.CustomEvent("viewed", {
            detail: {image: nextImage, originalImage: nextImage},
        }));
    };
    const cleanup = () => {
        bridge.stop();
        globalThis.document = oldGlobals.document;
        globalThis.window = oldGlobals.window;
        globalThis.fetch = oldGlobals.fetch;
        globalThis.MutationObserver = oldGlobals.MutationObserver;
        globalThis.__motionPhotoPlatform = oldGlobals.platform;
        globalThis.__motionPhotoNativeExport = oldGlobals.nativeExport;
        Object.defineProperty(URL, "createObjectURL", {configurable: true, value: oldGlobals.createObjectURL});
        Object.defineProperty(URL, "revokeObjectURL", {configurable: true, value: oldGlobals.revokeObjectURL});
    };
    return {bridge, document, window, viewer, eventTarget, image, nativeImage, viewed, cleanup,
        get video() { return videoElement; }, get playCalls() { return playCalls; }, revoked};
};

const waitFor = async (condition) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (condition()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail("Timed out waiting for the native viewer enhancement");
};

test("enhances the initially open native viewer and supports sound, pause, still photo, replay, and cleanup", async () => {
    const harness = createHarness();
    try {
        harness.bridge.start();
        await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
        const overlay = harness.document.querySelector(".sy-motion-photo__overlay");
        assert.equal(harness.video.muted, true);
        assert.equal(harness.playCalls, 1);
        assert.equal(overlay.hidden, false);
        assert.equal(harness.viewer.viewer.classList.contains("sy-motion-photo--playing"), true);
        assert.equal(harness.document.querySelector(".sy-motion-photo__toolbar-item").hidden, false);

        harness.document.querySelector('[data-sy-motion-action="sound"]').click();
        assert.equal(harness.video.muted, false);
        harness.document.querySelector('[data-sy-motion-action="play"]').click();
        assert.equal(harness.video.paused, true);
        harness.document.querySelector('[data-sy-motion-action="play"]').click();
        await waitFor(() => harness.playCalls === 2);

        harness.video.currentTime = 0.8;
        harness.document.querySelector('[data-sy-motion-action="photo"]').click();
        assert.equal(overlay.hidden, true);
        assert.equal(harness.viewer.viewer.classList.contains("sy-motion-photo--playing"), false);
        assert.equal(harness.video.currentTime, 0);
        harness.document.querySelector(".sy-motion-photo__toolbar-button").click();
        await waitFor(() => harness.playCalls === 3);
        assert.equal(overlay.hidden, false);
        assert.equal(harness.viewer.viewer.classList.contains("sy-motion-photo--playing"), true);

        harness.video.ended = true;
        harness.video.dispatchEvent(new harness.window.Event("ended"));
        assert.equal(overlay.hidden, true);
        assert.equal(harness.viewer.viewer.classList.contains("sy-motion-photo--playing"), false);
        harness.eventTarget.dispatchEvent(new harness.window.Event("hidden"));
        assert.equal(harness.document.querySelector(".sy-motion-photo__toolbar-item"), null);
        assert.deepEqual(harness.revoked, ["blob:motion-photo-test"]);
        assert.equal(harness.video.getAttribute("src"), null);
    } finally {
        harness.cleanup();
    }
});

test("shows a manual play action when autoplay is blocked and keeps the photo visible for unsupported codecs", async (t) => {
    await t.test("autoplay blocked", async () => {
        const harness = createHarness({rejectFirstPlay: true});
        try {
            harness.bridge.start();
            await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
            const overlay = harness.document.querySelector(".sy-motion-photo__overlay");
            assert.equal(overlay.hidden, false);
            assert.equal(harness.document.querySelector(".sy-motion-photo__status").textContent, strings.autoplayBlocked);
            harness.document.querySelector('[data-sy-motion-action="play"]').click();
            await waitFor(() => harness.playCalls === 2);
            assert.equal(harness.document.querySelector(".sy-motion-photo__status").textContent, strings.videoPlaying);
        } finally {
            harness.cleanup();
        }
    });

    await t.test("unsupported codec", async () => {
        globalThis.__motionPhotoMessages = [];
        const harness = createHarness({codec: ""});
        try {
            harness.bridge.start();
            await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
            const overlay = harness.document.querySelector(".sy-motion-photo__overlay");
            assert.equal(overlay.hidden, false);
            assert.equal(overlay.classList.contains("sy-motion-photo__overlay--photo"), true);
            assert.equal(harness.viewer.viewer.classList.contains("sy-motion-photo--playing"), false);
            assert.equal(harness.document.querySelector(".viewer-image"), harness.nativeImage);
            assert.equal(harness.document.querySelector(".sy-motion-photo__status").textContent, strings.unsupportedCodec);
            assert.deepEqual(globalThis.__motionPhotoMessages, [strings.unsupportedCodec]);
            assert.ok(harness.document.querySelector('[data-sy-motion-action="export"]'));
        } finally {
            harness.cleanup();
        }
    });
});

test("switches cleanly between motion and ordinary photos", async () => {
    const harness = createHarness();
    try {
        harness.bridge.start();
        await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
        harness.eventTarget.dispatchEvent(new harness.window.Event("view"));
        const still = harness.document.createElement("img");
        still.src = "http://siyuan.test/assets/still.jpg";
        harness.viewer.image = still;
        harness.viewed(still);
        await waitFor(() => harness.document.querySelector(".sy-motion-photo__overlay") === null);
        assert.equal(harness.nativeImage.isConnected, true);

        harness.viewer.image = harness.image;
        harness.viewed(harness.image);
        await waitFor(() => harness.document.querySelector(".sy-motion-photo__overlay"));
        assert.equal(harness.document.querySelector(".sy-motion-photo__overlay").hidden, false);
    } finally {
        harness.cleanup();
    }
});

test("exports the sample through the desktop native save helper only after an explicit click", async () => {
    let temporaryFile;
    let temporaryPath;
    let nativeCalls = 0;
    const removed = [];
    const fetchMock = async (url, options = {}) => {
        if (String(url) === "/api/file/putFile") {
            temporaryPath = options.body.get("path");
            temporaryFile = options.body.get("file");
            assert.equal(options.body.get("assetsDirPath"), null);
            assert.match(temporaryPath, /^\/temp\/export\/siyuan-motion-photo\/[0-9a-f]{32}\/motion \(2\)\.mp4$/);
            assert.equal(temporaryFile.name, "motion (2).mp4");
            assert.equal(temporaryFile.type, "video/mp4");
            assert.equal(temporaryFile.size, 506134);
            assert.deepEqual(new Uint8Array(await temporaryFile.arrayBuffer()), fixture.subarray(2855371));
            return new Response(JSON.stringify({code: 0}), {status: 200});
        }
        if (String(url) === "/api/file/removeFile") {
            removed.push(JSON.parse(options.body).path);
            return new Response(JSON.stringify({code: 0}), {status: 200});
        }
        assert.notEqual(String(url), "/api/asset/upload");
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        return rangedResponse(Number(match[1]), Number(match[2]));
    };
    const harness = createHarness({fetchMock, nativeExport: async (uri) => {
        nativeCalls += 1;
        assert.equal(decodeURIComponent(uri), temporaryPath.replace(/^\/temp/, ""));
        assert.ok(temporaryFile);
        return {status: "success"};
    }});
    try {
        harness.bridge.start();
        await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
        assert.equal(temporaryFile, undefined);
        assert.equal(nativeCalls, 0);
        harness.document.querySelector('[data-sy-motion-action="export"]').click();
        await waitFor(() => harness.document.querySelector(".sy-motion-photo__status").textContent === strings.exportComplete);
        assert.equal(nativeCalls, 1);
        assert.deepEqual(removed, [temporaryPath]);
        assert.equal(harness.video.paused, true);
        assert.equal(harness.document.querySelector('[data-sy-motion-action="export"]').disabled, false);
        assert.equal(harness.document.querySelector(".sy-motion-photo__asset-link"), null);
    } finally {
        harness.cleanup();
    }
});

test("Android control hands a temporary video to other apps and keeps it available after the lightbox closes", async () => {
    let temporaryPath;
    const opened = [];
    const removed = [];
    const fetchMock = async (url, options = {}) => {
        if (url === "/api/file/readDir") {
            return new Response(JSON.stringify({code: 0, data: []}), {status: 200});
        }
        if (url === "/api/file/putFile") {
            temporaryPath = options.body.get("path");
            assert.match(temporaryPath, /^\/data\/assets\/siyuan-motion-photo-temp\/motion-photo-\d{13}-[0-9a-f]{32}-motion \(2\)\.mp4$/);
            assert.equal(options.body.get("file").size, 506134);
            return new Response(JSON.stringify({code: 0}), {status: 200});
        }
        if (url === "/api/file/removeFile") {
            removed.push(JSON.parse(options.body).path);
            return new Response(JSON.stringify({code: 0}), {status: 200});
        }
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
        return rangedResponse(Number(match[1]), Number(match[2]));
    };
    const harness = createHarness({android: true, fetchMock, openExternal: uri => opened.push(uri),
        nativeExport: () => assert.fail("Android should use the other-app bridge")});
    try {
        harness.bridge.start();
        await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
        const button = harness.document.querySelector('[data-sy-motion-action="export"]');
        assert.equal(button.textContent, strings.openVideoExternal);
        assert.equal(temporaryPath, undefined);
        button.click();
        await waitFor(() => harness.document.querySelector(".sy-motion-photo__status").textContent === strings.videoOpenedExternal);
        assert.equal(opened.length, 1);
        assert.equal(decodeURIComponent(opened[0]), temporaryPath.replace(/^\/data\//, ""));
        assert.equal(harness.video.paused, true);
        harness.eventTarget.dispatchEvent(new harness.window.Event("hide"));
        assert.deepEqual(removed, []);
        assert.deepEqual(harness.revoked, ["blob:motion-photo-test"]);
    } finally {
        harness.cleanup();
    }
    assert.deepEqual(removed, []);
});

test("closing or disabling during export staging aborts the write and never launches a native action", async (t) => {
    for (const action of ["hide", "stop"]) {
        await t.test(action, async () => {
            let writeSignal;
            let temporaryPath;
            const removed = [];
            const fetchMock = async (url, options = {}) => {
                if (url === "/api/file/putFile") {
                    writeSignal = options.signal;
                    temporaryPath = options.body.get("path");
                    return new Promise((_resolve, reject) => {
                        options.signal.addEventListener("abort", () =>
                            reject(new DOMException("Aborted", "AbortError")), {once: true});
                    });
                }
                if (url === "/api/file/removeFile") {
                    removed.push(JSON.parse(options.body).path);
                    return new Response(JSON.stringify({code: 0}), {status: 200});
                }
                const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
                return rangedResponse(Number(match[1]), Number(match[2]));
            };
            const harness = createHarness({fetchMock,
                nativeExport: () => assert.fail("A canceled lightbox must not launch a native dialog")});
            try {
                harness.bridge.start();
                await waitFor(() => harness.video && harness.document.querySelector(".sy-motion-photo__overlay"));
                harness.document.querySelector('[data-sy-motion-action="export"]').click();
                await waitFor(() => writeSignal);
                if (action === "stop") {
                    harness.bridge.stop();
                } else {
                    harness.eventTarget.dispatchEvent(new harness.window.Event("hide"));
                }
                assert.equal(writeSignal.aborted, true);
                await waitFor(() => removed.length === 1);
                assert.deepEqual(removed, [temporaryPath]);
                assert.equal(harness.document.querySelector(".sy-motion-photo__overlay"), null);
            } finally {
                harness.cleanup();
            }
        });
    }
});

test("aborts an in-flight metadata request when the lightbox closes", async () => {
    let started;
    const requestStarted = new Promise(resolve => { started = resolve; });
    let requestSignal;
    const harness = createHarness({fetchMock: (_url, options) => {
        requestSignal = options.signal;
        started();
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
        });
    }});
    try {
        harness.viewer.viewed = false;
        harness.bridge.start();
        harness.viewed();
        await requestStarted;
        harness.eventTarget.dispatchEvent(new harness.window.Event("hide"));
        assert.equal(requestSignal.aborted, true);
        assert.equal(harness.document.querySelector(".sy-motion-photo__overlay"), null);
    } finally {
        harness.cleanup();
    }
});
