import {Dialog} from "siyuan";
import type {MotionPhotoTranslations} from "./viewerTypes.ts";

export interface MotionPhotoSettings {
    autoPlay: boolean;
    defaultMuted: boolean;
}

export const DEFAULT_SETTINGS: Readonly<MotionPhotoSettings> = Object.freeze({
    autoPlay: true,
    defaultMuted: true,
});

export const SETTINGS_FILE = "settings.json";

export function normalizeSettings(value: unknown): MotionPhotoSettings {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return {...DEFAULT_SETTINGS};
        }
    }
    const settings = value && typeof value === "object" ? value as Partial<MotionPhotoSettings> : {};
    return {
        autoPlay: typeof settings.autoPlay === "boolean" ? settings.autoPlay : DEFAULT_SETTINGS.autoPlay,
        defaultMuted: typeof settings.defaultMuted === "boolean" ? settings.defaultMuted : DEFAULT_SETTINGS.defaultMuted,
    };
}

interface SettingsStorage {
    loadData(name: string): Promise<unknown>;
    saveData(name: string, value: MotionPhotoSettings): Promise<unknown>;
}

interface SettingsDialogState {
    dialog: Dialog;
    busy: boolean;
    closing: boolean;
    release: () => void;
    removeListeners: () => void;
}

const errorMessage = (error: unknown) => {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === "object" && "msg" in error && typeof error.msg === "string") {
        return error.msg;
    }
    return typeof error === "string" ? error : "";
};

export class MotionPhotoSettingsController {
    private settings: MotionPhotoSettings = {...DEFAULT_SETTINGS};
    private state: SettingsDialogState | undefined;
    private disposed = false;
    private readonly storage: SettingsStorage;
    private readonly strings: MotionPhotoTranslations;
    private readonly suspendViewer: () => (() => void) | undefined;

    constructor(storage: SettingsStorage, strings: MotionPhotoTranslations,
        suspendViewer: () => (() => void) | undefined) {
        this.storage = storage;
        this.strings = strings;
        this.suspendViewer = suspendViewer;
    }

    async load() {
        let loaded: unknown;
        try {
            loaded = await this.storage.loadData(SETTINGS_FILE);
        } catch {
            // Missing, unreadable or corrupt configuration uses the same defaults.
        }
        if (!this.disposed) {
            this.settings = normalizeSettings(loaded);
        }
    }

    read(): MotionPhotoSettings {
        return {...this.settings};
    }

    open() {
        if (this.disposed) {
            return;
        }
        if (this.state) {
            if (!this.state.closing) {
                this.state.dialog.element.querySelector<HTMLElement>(".b3-dialog__container")?.focus();
            }
            return;
        }

        const release = this.suspendViewer() ?? (() => {});
        let dialog: Dialog;
        try {
            dialog = new Dialog({
                title: this.strings.settingsTitle,
                width: "440px",
                // Our Cancel / Escape handlers also guard against closing during an in-flight save.
                disableClose: true,
                content: `<div class="sy-motion-photo__settings">
<label class="sy-motion-photo__setting-row"><span><strong data-sy-setting-label="autoPlay"></strong><small data-sy-setting-description="autoPlay"></small></span><input class="b3-switch" type="checkbox" data-sy-setting="autoPlay"></label>
<label class="sy-motion-photo__setting-row"><span><strong data-sy-setting-label="defaultMuted"></strong><small data-sy-setting-description="defaultMuted"></small></span><input class="b3-switch" type="checkbox" data-sy-setting="defaultMuted"></label>
<p class="sy-motion-photo__settings-note"></p>
<p class="sy-motion-photo__settings-error" role="alert" hidden></p>
<div class="sy-motion-photo__settings-actions"><button class="b3-button b3-button--cancel" type="button" data-sy-setting-action="cancel"></button><button class="b3-button b3-button--text" type="button" data-sy-setting-action="save"></button></div>
</div>`,
                destroyCallback: () => {
                    if (this.state?.dialog === dialog) {
                        this.state.removeListeners();
                        this.state.release();
                        this.state = undefined;
                    }
                },
            });
        } catch (error) {
            release();
            throw error;
        }

        const root = dialog.element;
        const autoPlay = root.querySelector<HTMLInputElement>('[data-sy-setting="autoPlay"]')!;
        const defaultMuted = root.querySelector<HTMLInputElement>('[data-sy-setting="defaultMuted"]')!;
        const save = root.querySelector<HTMLButtonElement>('[data-sy-setting-action="save"]')!;
        const cancel = root.querySelector<HTMLButtonElement>('[data-sy-setting-action="cancel"]')!;
        const error = root.querySelector<HTMLParagraphElement>(".sy-motion-photo__settings-error")!;
        autoPlay.checked = this.settings.autoPlay;
        defaultMuted.checked = this.settings.defaultMuted;
        root.querySelector('[data-sy-setting-label="autoPlay"]')!.textContent = this.strings.autoPlaySetting;
        root.querySelector('[data-sy-setting-label="defaultMuted"]')!.textContent = this.strings.defaultMutedSetting;
        root.querySelector('[data-sy-setting-description="autoPlay"]')!.textContent = this.strings.autoPlayDescription;
        root.querySelector('[data-sy-setting-description="defaultMuted"]')!.textContent = this.strings.defaultMutedDescription;
        root.querySelector(".sy-motion-photo__settings-note")!.textContent = this.strings.settingsNextPhoto;
        save.textContent = this.strings.saveSettings;
        cancel.textContent = this.strings.cancelSettings;

        // Viewer.js may use a higher z-index than the host's current dialog counter.
        const layer = root.querySelector<HTMLElement>(".b3-dialog")!;
        const viewer = document.querySelector<HTMLElement>(".viewer-container");
        const viewerZIndex = viewer && window.getComputedStyle ? Number(window.getComputedStyle(viewer).zIndex) : 0;
        const zIndex = Math.max(Number(layer.style.zIndex) || 0, (viewerZIndex || 0) + 1);
        layer.style.zIndex = String(zIndex);
        const host = (window as unknown as {siyuan?: {zIndex?: number}}).siyuan;
        if (host && typeof host.zIndex === "number") {
            host.zIndex = Math.max(host.zIndex, zIndex);
        }

        const close = () => {
            if (!state.busy) {
                this.close(state);
            }
        };
        const saveDraft = async () => {
            if (state.busy || state.closing || this.disposed) {
                return;
            }
            const draft = {autoPlay: autoPlay.checked, defaultMuted: defaultMuted.checked};
            state.busy = true;
            error.hidden = true;
            for (const control of [autoPlay, defaultMuted, save, cancel]) {
                control.disabled = true;
            }
            save.textContent = this.strings.savingSettings;
            try {
                const response = await this.storage.saveData(SETTINGS_FILE, draft);
                if (this.disposed || this.state !== state || state.closing) {
                    return;
                }
                if (response && typeof response === "object" && "code" in response && response.code !== 0) {
                    throw response;
                }
                this.settings = {...draft};
                this.close(state);
            } catch (failure) {
                if (this.disposed || this.state !== state || state.closing) {
                    return;
                }
                const detail = errorMessage(failure);
                error.textContent = this.strings.settingsSaveFailed + (detail ? `：${detail}` : "");
                error.hidden = false;
            } finally {
                if (!this.disposed && this.state === state && !state.closing) {
                    state.busy = false;
                    for (const control of [autoPlay, defaultMuted, save, cancel]) {
                        control.disabled = false;
                    }
                    save.textContent = this.strings.saveSettings;
                }
            }
        };
        const handleKeydown = (event: KeyboardEvent) => {
            // The native viewer's document listener must not receive keys from this modal.
            event.stopPropagation();
            if (event.key === "Escape") {
                event.preventDefault();
                close();
            }
        };
        const state: SettingsDialogState = {
            dialog, busy: false, closing: false, release,
            removeListeners: () => {
                cancel.removeEventListener("click", close);
                save.removeEventListener("click", saveDraft);
                root.removeEventListener("keydown", handleKeydown);
            },
        };
        this.state = state;
        cancel.addEventListener("click", close);
        save.addEventListener("click", saveDraft);
        root.addEventListener("keydown", handleKeydown);
    }

    dispose() {
        this.disposed = true;
        const state = this.state;
        if (state) {
            state.removeListeners();
            state.release();
            this.state = undefined;
            this.close(state);
        }
    }

    private close(state: SettingsDialogState) {
        if (!state.closing) {
            state.closing = true;
            state.dialog.destroy();
        }
    }
}
