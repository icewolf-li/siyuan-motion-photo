import {Plugin} from "siyuan";
import {MotionPhotoViewerBridge} from "./motion-photo/viewer.ts";
import type {MotionPhotoTranslations} from "./motion-photo/viewerTypes.ts";
import "./index.scss";

export default class SiYuanMotionPhotoPlugin extends Plugin {
    private viewerBridge: MotionPhotoViewerBridge | undefined;

    onload() {
        const translations = this.i18n as unknown as MotionPhotoTranslations;
        this.viewerBridge = new MotionPhotoViewerBridge(translations);
        this.viewerBridge.start();
    }

    onunload() {
        this.viewerBridge?.stop();
        this.viewerBridge = undefined;
    }
}
