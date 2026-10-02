import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {setImmediate as nextTurn} from "node:timers/promises";
import {test} from "node:test";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "siyuan") {
            const source = `
                export const getFrontend = () => globalThis.__exportPlatform.frontend;
                export const getBackend = () => globalThis.__exportPlatform.backend;
                export const saveExportFile = (uri) => globalThis.__saveExportFile(uri);
            `;
            return {url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true};
        }
        return nextResolve(specifier, context);
    },
});

const {MotionPhotoExporter, ANDROID_TEMP_DIRECTORY, ANDROID_TEMP_LIFETIME_MS} =
    await import("../src/motion-photo/exporter.ts");
const jsonResponse = (data, code = 0) => new Response(JSON.stringify({code, data}), {status: 200});
const video = new Blob([new Uint8Array([0, 1, 2, 3, 255])], {type: "video/mp4"});

const withExporter = async (options, task) => {
    const previous = {window: globalThis.window, fetch: globalThis.fetch,
        platform: globalThis.__exportPlatform, save: globalThis.__saveExportFile};
    const requests = [];
    const opened = [];
    const saves = [];
    const files = new Map();
    globalThis.__exportPlatform = options.platform ?? {frontend: "desktop", backend: "windows"};
    globalThis.window = options.noAndroidBridge ? {} : {JSAndroid: {openExternal: uri => {
        opened.push(uri);
        options.onOpen?.(uri);
    }}};
    globalThis.__saveExportFile = async uri => {
        saves.push(uri);
        return options.onSave ? options.onSave(uri) : {status: "success"};
    };
    globalThis.fetch = async (url, init = {}) => {
        requests.push({url, init});
        if (options.fetch) {
            const override = await options.fetch(url, init);
            if (override !== undefined) {
                return override;
            }
        }
        if (url === "/api/file/putFile") {
            const file = init.body.get("file");
            const path = init.body.get("path");
            assert.equal(init.body.get("isDir"), "false");
            assert.equal(file.type, "video/mp4");
            files.set(path, new Uint8Array(await file.arrayBuffer()));
            return jsonResponse(null);
        }
        if (url === "/api/file/removeFile") {
            files.delete(JSON.parse(init.body).path);
            return jsonResponse(null);
        }
        if (url === "/api/file/readDir") {
            assert.equal(JSON.parse(init.body).path, ANDROID_TEMP_DIRECTORY);
            return jsonResponse(options.entries ?? []);
        }
        assert.fail(`Unexpected endpoint: ${url}`);
    };
    const exporter = new MotionPhotoExporter();
    try {
        exporter.start();
        await task({exporter, requests, opened, saves, files});
    } finally {
        exporter.stop();
        globalThis.window = previous.window;
        globalThis.fetch = previous.fetch;
        globalThis.__exportPlatform = previous.platform;
        globalThis.__saveExportFile = previous.save;
    }
};

const waitFor = async (condition) => {
    for (let i = 0; i < 100; i += 1) {
        if (condition()) {
            return;
        }
        await nextTurn();
    }
    assert.fail("Timed out waiting for export cleanup");
};

test("desktop export keeps a clean suggested filename, stages only in temp, and removes the file after saving", async () => {
    let savedBytes;
    let stagedFiles;
    await withExporter({onSave: async uri => {
        const path = `/temp${decodeURIComponent(uri)}`;
        assert.match(path, /^\/temp\/export\/siyuan-motion-photo\/[0-9a-f]{32}\/照片 \(2\)\.mp4$/);
        savedBytes = stagedFiles.get(path);
        return {status: "success"};
    }}, async ({exporter, requests, saves, files}) => {
        stagedFiles = files;
        assert.equal(await exporter.exportVideo(video, "照片 (2).mp4", new AbortController().signal), "saved");
        assert.deepEqual(savedBytes, new Uint8Array(await video.arrayBuffer()));
        assert.equal(saves.length, 1);
        assert.equal(files.size, 0);
        assert.deepEqual(requests.map(item => item.url), ["/api/file/putFile", "/api/file/removeFile"]);
        const writtenPath = requests[0].init.body.get("path");
        assert.equal(JSON.parse(requests[1].init.body).path, writtenPath);
        assert.equal(writtenPath.includes("assets"), false);
    });
});

test("desktop cancellation and native failures clean up without falsely confirming a save", async t => {
    await t.test("canceled dialog", async () => {
        await withExporter({onSave: () => ({status: "canceled"})}, async ({exporter, files}) => {
            assert.equal(await exporter.exportVideo(video, "sample.mp4", new AbortController().signal), "canceled");
            assert.equal(files.size, 0);
        });
    });
    for (const result of [{status: "error", message: "Disk full"}, undefined]) {
        await t.test(result ? "native error" : "missing native confirmation", async () => {
            await withExporter({onSave: () => result}, async ({exporter, files}) => {
                await assert.rejects(exporter.exportVideo(video, "sample.mp4", new AbortController().signal),
                    result ? /Disk full/ : /could not save/);
                assert.equal(files.size, 0);
            });
        });
    }
});

test("kernel write failures and stale responses never launch the native save dialog", async t => {
    await t.test("write failure", async () => {
        await withExporter({fetch: url => url === "/api/file/putFile" ?
            jsonResponse(null, -1) : undefined}, async ({exporter, saves, requests}) => {
            await assert.rejects(exporter.exportVideo(video, "sample.mp4", new AbortController().signal));
            assert.deepEqual(saves, []);
            assert.equal(requests.at(-1).url, "/api/file/removeFile");
        });
    });
    await t.test("response arriving after cancellation", async () => {
        const controller = new AbortController();
        await withExporter({fetch: url => {
            if (url === "/api/file/putFile") {
                controller.abort();
                return jsonResponse(null);
            }
        }}, async ({exporter, saves}) => {
            await assert.rejects(exporter.exportVideo(video, "sample.mp4", controller.signal), {name: "AbortError"});
            assert.deepEqual(saves, []);
        });
    });
});

test("once the OS owns the save dialog its source stays available until the dialog finishes", async () => {
    let finishSave;
    const nativeResult = new Promise(resolve => { finishSave = resolve; });
    await withExporter({onSave: () => nativeResult}, async ({exporter, files, saves}) => {
        const controller = new AbortController();
        const result = exporter.exportVideo(video, "sample.mp4", controller.signal);
        await waitFor(() => saves.length === 1);
        controller.abort();
        exporter.stop();
        assert.equal(files.size, 1);
        finishSave({status: "success"});
        assert.equal(await result, "saved");
        assert.equal(files.size, 0);
    });
});

test("Android uses temporary assets and the native other-app action, with deferred cleanup", async t => {
    t.mock.timers.enable({apis: ["setTimeout", "Date"], now: Date.now()});
    await withExporter({platform: {frontend: "mobile", backend: "android"}},
        async ({exporter, requests, opened, saves, files}) => {
            assert.equal(await exporter.exportVideo(video, "样本.mp4", new AbortController().signal), "opened");
            assert.deepEqual(saves, []);
            assert.equal(opened.length, 1);
            const path = `/data/${decodeURIComponent(opened[0])}`;
            assert.ok(path.startsWith(`${ANDROID_TEMP_DIRECTORY}/motion-photo-`));
            assert.deepEqual(files.get(path), new Uint8Array(await video.arrayBuffer()));
            assert.equal(requests.some(item => item.url === "/api/file/removeFile"), false);
            t.mock.timers.tick(ANDROID_TEMP_LIFETIME_MS - 1);
            await nextTurn();
            assert.equal(files.size, 1);
            t.mock.timers.tick(1);
            await waitFor(() => files.size === 0);
        });
});

test("Android startup cleans expired plugin MP4s and preserves recent files, unrelated assets, directories, and symlinks", async () => {
    const now = Date.now();
    const id = "1234567890abcdef1234567890abcdef";
    const expired = `motion-photo-${now - 1}-${id}-old.mp4`;
    const recent = `motion-photo-${now + ANDROID_TEMP_LIFETIME_MS}-${id}-recent.mp4`;
    const directory = `motion-photo-${now - 1}-${id}-directory.mp4`;
    const symlink = `motion-photo-${now - 1}-${id}-symlink.mp4`;
    const entries = [
        {name: expired, isDir: false}, {name: recent, isDir: false},
        {name: directory, isDir: true}, {name: symlink, isDir: false, isSymlink: true},
        {name: "original.jpg", isDir: false}, {name: "permanent.mp4", isDir: false},
        {name: `motion-photo-${now - 1}-${id}-../other.mp4`, isDir: false},
    ];
    await withExporter({platform: {frontend: "mobile", backend: "android"}, entries}, async ({requests}) => {
        await waitFor(() => requests.some(item => item.url === "/api/file/removeFile"));
        await nextTurn();
        assert.deepEqual(requests.filter(item => item.url === "/api/file/removeFile")
            .map(item => JSON.parse(item.init.body).path), [`${ANDROID_TEMP_DIRECTORY}/${expired}`]);
    });
});

test("Android closing or disabling after handoff preserves the recipient's file and cancels cleanup timers", async t => {
    t.mock.timers.enable({apis: ["setTimeout", "Date"], now: Date.now()});
    await withExporter({platform: {frontend: "mobile", backend: "android"}}, async ({exporter, files, requests}) => {
        await exporter.exportVideo(video, "sample.mp4", new AbortController().signal);
        exporter.stop();
        t.mock.timers.tick(ANDROID_TEMP_LIFETIME_MS * 2);
        await nextTurn();
        assert.equal(files.size, 1);
        assert.equal(requests.some(item => item.url === "/api/file/removeFile"), false);
    });
});

test("Android native handoff errors remove the attempted temporary file", async () => {
    await withExporter({platform: {frontend: "mobile", backend: "android"},
        onOpen: () => { throw new Error("Native bridge failed"); }}, async ({exporter, files}) => {
        await assert.rejects(exporter.exportVideo(video, "sample.mp4", new AbortController().signal), /Native bridge failed/);
        assert.equal(files.size, 0);
    });
});

test("unsupported clients and Android without its native bridge create no file", async t => {
    for (const options of [
        {platform: {frontend: "browser-desktop", backend: "windows"}},
        {platform: {frontend: "mobile", backend: "android"}, noAndroidBridge: true},
    ]) {
        await t.test(options.platform.frontend, async () => {
            await withExporter(options, async ({exporter, requests}) => {
                assert.equal(exporter.available, false);
                await assert.rejects(exporter.exportVideo(video, "sample.mp4", new AbortController().signal), /unavailable/);
                assert.equal(requests.some(item => item.url === "/api/file/putFile"), false);
            });
        });
    }
});

test("filenames cannot leave the dedicated temporary directory and long Unicode names fit Android limits", async () => {
    await withExporter({platform: {frontend: "mobile", backend: "android"}}, async ({exporter, requests}) => {
        await exporter.exportVideo(video, `../../CON:${"照片".repeat(100)}.mp4`, new AbortController().signal);
        const path = requests.find(item => item.url === "/api/file/putFile").init.body.get("path");
        assert.equal(path.split("/").length, ANDROID_TEMP_DIRECTORY.split("/").length + 1);
        assert.equal(path.includes(".."), false);
        assert.ok(new TextEncoder().encode(path.split("/").at(-1)).length < 255);
    });
});
