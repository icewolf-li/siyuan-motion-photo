import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {registerHooks} from "node:module";
import {test} from "node:test";
import {parseHTML} from "linkedom";
import {MockDialog} from "./helpers/mock-dialog.mjs";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "siyuan") {
            const source = `
export class Dialog { constructor(options) { return new globalThis.__motionPhotoDialog(options); } }
export class Plugin {
    constructor(options) { Object.assign(this, options); }
    loadData(name) { return globalThis.__settingsStorage.loadData(name); }
    saveData(name, content) { return globalThis.__settingsStorage.saveData(name, content); }
}
export const showMessage = () => {};
export const getFrontend = () => 'desktop';
export const getBackend = () => 'windows';
export const saveExportFile = async () => ({status: 'success'});
`;
            return {url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true};
        }
        if (specifier.endsWith(".scss")) {
            return {url: "data:text/javascript,export default {}", shortCircuit: true};
        }
        return nextResolve(specifier, context);
    },
});

const {MotionPhotoSettingsController, normalizeSettings, DEFAULT_SETTINGS, SETTINGS_FILE} =
    await import("../src/motion-photo/settings.ts");
const {default: MotionPhotoPlugin} = await import("../src/index.ts");
const strings = JSON.parse(await readFile("src/i18n/zh-CN.json", "utf8"));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(storage = {loadData: async () => undefined, saveData: async () => ({code: 0})}) {
    const previous = {
        document: globalThis.document, window: globalThis.window,
        dialog: globalThis.__motionPhotoDialog, storage: globalThis.__settingsStorage,
        MutationObserver: globalThis.MutationObserver,
    };
    const {document, window} = parseHTML("<html><body><div class='viewer-container' style='z-index:99999'></div></body></html>");
    Object.defineProperty(window, "getComputedStyle", {configurable: true,
        value: element => ({zIndex: element.style.zIndex})});
    window.siyuan = {zIndex: 100};
    globalThis.document = document;
    globalThis.window = window;
    globalThis.__motionPhotoDialog = MockDialog;
    globalThis.__settingsStorage = storage;
    let pauses = 0;
    let releases = 0;
    let observers = 0;
    globalThis.MutationObserver = class {
        observe() { observers += 1; }
        disconnect() { observers -= 1; }
    };
    const controller = new MotionPhotoSettingsController(storage, strings, () => {
        pauses += 1;
        return () => { releases += 1; };
    });
    return {controller, document, window,
        input: name => document.querySelector(`[data-sy-setting="${name}"]`),
        button: name => document.querySelector(`[data-sy-setting-action="${name}"]`),
        get pauses() { return pauses; }, get releases() { return releases; }, get observers() { return observers; },
        cleanup() {
            controller.dispose();
            globalThis.document = previous.document;
            globalThis.window = previous.window;
            globalThis.__motionPhotoDialog = previous.dialog;
            globalThis.__settingsStorage = previous.storage;
            globalThis.MutationObserver = previous.MutationObserver;
        },
    };
}

test("missing, corrupt, or invalid fields fall back to defaults without coercing booleans", () => {
    for (const value of [undefined, null, "", "{", [], 42, {code: 404}, {autoPlay: "false", defaultMuted: 0}]) {
        assert.deepEqual(normalizeSettings(value), DEFAULT_SETTINGS);
    }
    assert.deepEqual(normalizeSettings('{"autoPlay":false,"defaultMuted":false}'),
        {autoPlay: false, defaultMuted: false});
    assert.deepEqual(normalizeSettings({autoPlay: false}), {autoPlay: false, defaultMuted: true});
});

test("settings load from settings.json and a failed read uses defaults", async (t) => {
    for (const failure of [false, true]) {
        await t.test(`read failure=${failure}`, async () => {
            const context = harness({loadData: async name => {
                assert.equal(name, SETTINGS_FILE);
                if (failure) throw new Error("Missing file");
                return {autoPlay: false, defaultMuted: false};
            }, saveData: async () => assert.fail("loading does not save defaults")});
            try {
                await context.controller.load();
                assert.deepEqual(context.controller.read(), failure ? DEFAULT_SETTINGS :
                    {autoPlay: false, defaultMuted: false});
                context.controller.read().autoPlay = true;
                assert.equal(context.controller.read().autoPlay, failure);
            } finally { context.cleanup(); }
        });
    }
});

test("one native Dialog is shared by settings entries and cancel discards the draft", async () => {
    let writes = 0;
    const context = harness({loadData: async () => ({autoPlay: true, defaultMuted: true}),
        saveData: async () => { writes += 1; return {code: 0}; }});
    try {
        await context.controller.load();
        context.controller.open();
        context.controller.open();
        assert.equal(context.document.querySelectorAll(".sy-motion-photo__settings").length, 1);
        assert.equal(context.pauses, 1);
        assert.equal(context.document.querySelector(".b3-dialog").style.zIndex, "100000");
        context.input("autoPlay").checked = false;
        context.input("defaultMuted").checked = false;
        context.button("cancel").click();
        assert.equal(writes, 0);
        assert.equal(context.releases, 1);
        assert.deepEqual(context.controller.read(), DEFAULT_SETTINGS);
        context.controller.open();
        assert.equal(context.input("autoPlay").checked, true);
        assert.equal(context.input("defaultMuted").checked, true);
        const key = new context.window.Event("keydown", {bubbles: true, cancelable: true});
        key.key = "Escape";
        context.input("autoPlay").dispatchEvent(key);
        assert.equal(context.document.querySelector(".sy-motion-photo__settings"), null);
        assert.equal(context.releases, 2);
    } finally { context.cleanup(); }
});

test("saving persists all four combinations and reloading restores them", async (t) => {
    for (const autoPlay of [false, true]) {
        for (const defaultMuted of [false, true]) {
            await t.test(`${autoPlay}/${defaultMuted}`, async () => {
                let persisted;
                const context = harness({loadData: async name => {
                    assert.equal(name, SETTINGS_FILE);
                    return persisted;
                }, saveData: async (name, value) => {
                    assert.equal(name, SETTINGS_FILE);
                    persisted = structuredClone(value);
                    return {code: 0};
                }});
                try {
                    await context.controller.load();
                    context.controller.open();
                    context.input("autoPlay").checked = autoPlay;
                    context.input("defaultMuted").checked = defaultMuted;
                    context.button("save").click();
                    await tick();
                    assert.deepEqual(persisted, {autoPlay, defaultMuted});
                    assert.deepEqual(context.controller.read(), persisted);
                    assert.equal(context.document.querySelector(".sy-motion-photo__settings"), null);
                    const reloaded = new MotionPhotoSettingsController(globalThis.__settingsStorage, strings, () => undefined);
                    await reloaded.load();
                    assert.deepEqual(reloaded.read(), persisted);
                    reloaded.dispose();
                } finally { context.cleanup(); }
            });
        }
    }
});

test("a rejected save or kernel error retains the draft, dialog and current settings; retry succeeds", async (t) => {
    for (const rejected of [false, true]) {
        await t.test(`Promise rejection=${rejected}`, async () => {
            let attempts = 0;
            const context = harness({loadData: async () => DEFAULT_SETTINGS, saveData: async () => {
                attempts += 1;
                if (attempts > 1) return {code: 0};
                if (rejected) throw new Error("offline");
                return {code: -1, msg: "readonly"};
            }});
            try {
                await context.controller.load();
                context.controller.open();
                context.input("autoPlay").checked = false;
                context.button("save").click();
                await tick();
                assert.equal(context.input("autoPlay").checked, false);
                assert.equal(context.input("defaultMuted").checked, true);
                assert.deepEqual(context.controller.read(), DEFAULT_SETTINGS);
                const error = context.document.querySelector(".sy-motion-photo__settings-error");
                assert.equal(error.hidden, false);
                assert.ok(error.textContent.includes(rejected ? "offline" : "readonly"));
                assert.equal(context.releases, 0);
                assert.equal(context.button("save").disabled, false);
                context.button("save").click();
                await tick();
                assert.deepEqual(context.controller.read(), {autoPlay: false, defaultMuted: true});
                assert.equal(context.releases, 1);
            } finally { context.cleanup(); }
        });
    }
});

test("save commits only after success and prevents duplicate writes or cancellation while saving", async () => {
    let finish;
    let writes = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const context = harness({loadData: async () => DEFAULT_SETTINGS,
        saveData: async () => { writes += 1; return pending; }});
    try {
        await context.controller.load();
        context.controller.open();
        context.input("autoPlay").checked = false;
        context.button("save").click();
        assert.equal(context.button("save").disabled, true);
        assert.equal(context.button("cancel").disabled, true);
        assert.equal(context.input("autoPlay").disabled, true);
        context.button("save").click();
        context.button("cancel").click();
        assert.equal(writes, 1);
        assert.deepEqual(context.controller.read(), DEFAULT_SETTINGS);
        finish({code: 0});
        await tick();
        assert.deepEqual(context.controller.read(), {autoPlay: false, defaultMuted: true});
        assert.equal(context.document.querySelector(".sy-motion-photo__settings"), null);
    } finally { finish({code: 0}); context.cleanup(); }
});

test("unloading during load does not install observers or open a queued settings dialog", async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const context = harness({loadData: async () => pending, saveData: async () => assert.fail("No save expected")});
    const plugin = new MotionPhotoPlugin({i18n: strings});
    try {
        const loading = plugin.onload();
        plugin.openSetting();
        plugin.onunload();
        finish({autoPlay: false, defaultMuted: false});
        await loading;
        await tick();
        assert.equal(context.observers, 0);
        assert.equal(context.document.querySelector(".sy-motion-photo__settings"), null);
    } finally { finish(undefined); plugin.onunload(); context.cleanup(); }
});

test("unloading during save closes the dialog and ignores late success or failure", async (t) => {
    for (const rejected of [false, true]) {
        await t.test(`late failure=${rejected}`, async () => {
            let finish;
            let fail;
            const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
            const context = harness({loadData: async () => DEFAULT_SETTINGS, saveData: async () => pending});
            const plugin = new MotionPhotoPlugin({i18n: strings});
            try {
                await plugin.onload();
                plugin.openSetting();
                await tick();
                context.input("autoPlay").checked = false;
                context.button("save").click();
                assert.equal(context.observers, 1);
                plugin.onunload();
                if (rejected) fail(new Error("late failure"));
                else finish({code: 0});
                await tick();
                assert.equal(context.observers, 0);
                assert.equal(context.document.querySelector(".sy-motion-photo__settings"), null);
                plugin.openSetting();
                await tick();
                assert.equal(context.document.querySelector(".sy-motion-photo__settings"), null);
            } finally { finish({code: 0}); plugin.onunload(); context.cleanup(); }
        });
    }
});
