import {Plugin} from "siyuan";
import {MotionPhotoViewerBridge} from "./motion-photo/viewer.ts";
import type {MotionPhotoTranslations} from "./motion-photo/viewerTypes.ts";
import {MotionPhotoSettingsController} from "./motion-photo/settings.ts";
import "./index.scss";

export default class SiYuanMotionPhotoPlugin extends Plugin {
    private viewerBridge: MotionPhotoViewerBridge | undefined;
    private settings: MotionPhotoSettingsController | undefined;
    private initialization: Promise<void> | undefined;

    onload() {
        this.initialization = this.initialize();
        return this.initialization;
    }

    private async initialize() {
        const translations = this.i18n as unknown as MotionPhotoTranslations;
        const settings = new MotionPhotoSettingsController(this, translations,
            () => this.viewerBridge?.suspendForSettings());
        this.settings = settings;
        await settings.load();
        if (this.settings !== settings) {
            return;
        }
        this.viewerBridge = new MotionPhotoViewerBridge(translations, {
            getSettings: () => settings.read(),
            openSettings: () => this.openSetting(),
        });
        this.viewerBridge.start();
    }

    openSetting() {
        const settings = this.settings;
        void this.initialization?.then(() => {
            if (this.settings === settings) {
                settings?.open();
            }
        });
    }

    onunload() {
        this.settings?.dispose();
        this.settings = undefined;
        this.initialization = undefined;
        this.viewerBridge?.stop();
        this.viewerBridge = undefined;
    }
}
