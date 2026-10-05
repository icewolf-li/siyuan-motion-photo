import {showMessage} from "siyuan";
import type {MotionPhotoTranslations} from "./viewerTypes.ts";
import {fetchMotionPhotoVideo} from "./reader.ts";
import {MotionPhotoExporter} from "./exporter.ts";
import {DEFAULT_SETTINGS} from "./settings.ts";
import type {MotionPhotoSettings} from "./settings.ts";

interface NativeViewer {
    element: HTMLElement;
    viewer?: HTMLElement;
    toolbar?: HTMLElement;
    image?: HTMLImageElement;
    viewed?: boolean;
    options?: {keyboard?: boolean};
}

interface ViewerBridgeOptions {
    getSettings?: () => Readonly<MotionPhotoSettings>;
    openSettings?: () => void;
}

interface ViewerEventDetail {
    image?: HTMLImageElement;
    originalImage?: HTMLImageElement;
}

const SELECTED_ASSET_PREFIX = "/assets/";

const cleanAssetSource = (source: string) => {
    try {
        const url = new URL(source, window.location.href);
        const path = decodeURIComponent(url.pathname).toLowerCase();
        if (url.origin !== window.location.origin || !path.startsWith(SELECTED_ASSET_PREFIX) ||
            path.includes("\\") || path.split("/").includes("..") || !/\.jpe?g$/.test(path)) {
            return undefined;
        }
        url.searchParams.delete("style");
        url.hash = "";
        return url.href;
    } catch {
        return undefined;
    }
};

export class MotionPhotoViewerBridge {
    private observer: MutationObserver | undefined;
    private footerObserver: ResizeObserver | undefined;
    private viewer: NativeViewer | undefined;
    private cancellation: AbortController | undefined;
    private video: HTMLVideoElement | undefined;
    private overlay: HTMLDivElement | undefined;
    private toolbarItem: HTMLLIElement | undefined;
    private toolbarButton: HTMLButtonElement | undefined;
    private settingsItem: HTMLLIElement | undefined;
    private settingsButton: HTMLButtonElement | undefined;
    private toolbarList: HTMLUListElement | undefined;
    private statusElement: HTMLParagraphElement | undefined;
    private sourceImage: HTMLImageElement | undefined;
    private activeSource: string | undefined;
    private blobUrl: string | undefined;
    private videoBlob: Blob | undefined;
    private readonly exporter = new MotionPhotoExporter();
    private session = 0;
    private playbackAttempt = 0;
    private hasStarted = false;
    private settingsSuspensions = 0;
    private restoreKeyboard: (() => void) | undefined;
    private imageSettings: MotionPhotoSettings = {...DEFAULT_SETTINGS};
    private readonly viewedUrls = new Map<string, "static" | "motion">();
    private readonly strings: MotionPhotoTranslations;
    private readonly options: ViewerBridgeOptions;

    constructor(strings: MotionPhotoTranslations, options: ViewerBridgeOptions = {}) {
        this.strings = strings;
        this.options = options;
    }

    start() {
        if (!document.body || typeof MutationObserver === "undefined") {
            return;
        }
        this.exporter.start();
        this.observer = new MutationObserver(this.bindCurrentViewer);
        this.observer.observe(document.body, {childList: true});
        this.bindCurrentViewer();
    }

    stop() {
        this.observer?.disconnect();
        this.observer = undefined;
        this.unbindViewer();
        this.exporter.stop();
        this.settingsSuspensions = 0;
    }

    suspendForSettings(): () => void {
        this.settingsSuspensions += 1;
        this.pauseVideo();
        this.suspendViewerKeyboard();
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.settingsSuspensions = Math.max(0, this.settingsSuspensions - 1);
            if (this.settingsSuspensions === 0) {
                this.restoreViewerKeyboard();
            }
        };
    }

    private suspendViewerKeyboard() {
        const options = this.viewer?.options;
        if (!this.restoreKeyboard && options && this.settingsSuspensions > 0) {
            const previous = options.keyboard;
            options.keyboard = false;
            this.restoreKeyboard = () => { options.keyboard = previous; };
        }
    }

    private restoreViewerKeyboard() {
        this.restoreKeyboard?.();
        this.restoreKeyboard = undefined;
    }

    private readonly bindCurrentViewer = () => {
        const viewer = (window as unknown as {siyuan?: {viewer?: NativeViewer}}).siyuan?.viewer;
        if (!viewer || viewer === this.viewer || !viewer.element?.addEventListener || !viewer.viewer?.isConnected) {
            return;
        }

        this.unbindViewer();
        this.viewer = viewer;
        this.suspendViewerKeyboard();
        viewer.element.addEventListener("view", this.handleImageChange);
        viewer.element.addEventListener("viewed", this.handleImageViewed);
        viewer.element.addEventListener("hide", this.handleViewerHide);
        viewer.element.addEventListener("hidden", this.handleViewerHidden);

        // The lightbox may be inserted and assigned before our observer runs.
        if (viewer.viewed && viewer.image) {
            void this.processViewedImage({image: viewer.image, originalImage: viewer.image});
        }
    };

    private readonly handleImageChange = () => {
        this.resetCurrentImage();
    };

    private readonly handleImageViewed = (event: Event) => {
        const detail = (event as CustomEvent<ViewerEventDetail>).detail;
        void this.processViewedImage(detail ?? {});
    };

    private readonly handleViewerHide = () => {
        this.resetCurrentImage();
    };

    private readonly handleViewerHidden = () => {
        const viewer = this.viewer;
        this.resetCurrentImage();
        if (viewer) {
            this.removeViewerListeners(viewer);
        }
        this.viewer = undefined;
        this.restoreViewerKeyboard();
        this.viewedUrls.clear();
    };

    private removeViewerListeners(viewer: NativeViewer) {
        viewer.element.removeEventListener("view", this.handleImageChange);
        viewer.element.removeEventListener("viewed", this.handleImageViewed);
        viewer.element.removeEventListener("hide", this.handleViewerHide);
        viewer.element.removeEventListener("hidden", this.handleViewerHidden);
    }

    private unbindViewer() {
        this.resetCurrentImage();
        this.restoreViewerKeyboard();
        if (this.viewer) {
            this.removeViewerListeners(this.viewer);
        }
        this.viewer = undefined;
        this.viewedUrls.clear();
    }

    private resetCurrentImage() {
        this.session += 1;
        this.playbackAttempt += 1;
        this.hasStarted = false;
        this.cancellation?.abort();
        this.cancellation = undefined;
        this.video?.pause();
        if (this.video) {
            this.video.removeEventListener("ended", this.returnToPhoto);
            this.video.removeEventListener("error", this.handleVideoError);
            this.video.removeAttribute("src");
            this.video.load();
        }
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl);
        }
        this.blobUrl = undefined;
        this.videoBlob = undefined;
        this.footerObserver?.disconnect();
        this.footerObserver = undefined;
        const actions: Array<[string, (event: Event) => void]> = [
            ["play", this.togglePlayback], ["sound", this.toggleAudio],
            ["photo", this.returnToPhoto], ["export", this.exportVideo],
        ];
        for (const [action, listener] of actions) {
            this.overlay?.querySelector(`[data-sy-motion-action="${action}"]`)?.removeEventListener("click", listener);
        }
        this.overlay?.remove();
        this.overlay = undefined;
        this.video = undefined;
        this.statusElement = undefined;
        this.sourceImage = undefined;
        this.activeSource = undefined;
        this.setViewerMotionMode(false);
        this.removeToolbarButtons();
    }

    private async processViewedImage(detail: ViewerEventDetail) {
        const sourceImage = detail.originalImage ?? detail.image ?? this.viewer?.image;
        const source = sourceImage && cleanAssetSource(sourceImage.currentSrc || sourceImage.src);
        if (!source || !this.viewer?.viewer) {
            this.resetCurrentImage();
            return;
        }
        if (source === this.activeSource) {
            return;
        }

        this.resetCurrentImage();
        this.imageSettings = {...(this.options.getSettings?.() ?? DEFAULT_SETTINGS)};
        this.sourceImage = sourceImage;
        this.activeSource = source;
        const currentSession = this.session;
        const cachedResult = this.viewedUrls.get(source);
        if (cachedResult === "static") {
            return;
        }
        const cancellation = new AbortController();
        this.cancellation = cancellation;
        try {
            const blob = await fetchMotionPhotoVideo(source, cancellation.signal);
            if (currentSession !== this.session || cancellation.signal.aborted) {
                return;
            }
            if (!blob) {
                this.viewedUrls.set(source, "static");
                return;
            }

            this.viewedUrls.set(source, "motion");
            this.videoBlob = blob;
            this.blobUrl = URL.createObjectURL(blob);
            if (!this.createVideoControls()) {
                this.resetCurrentImage();
                return;
            }
            if (!this.attachToolbarButtons()) {
                this.resetCurrentImage();
                return;
            }
            this.setPlaybackStatus(this.strings.loadingVideo);
            this.video!.src = this.blobUrl;
            this.video!.load();
            if (this.imageSettings.autoPlay && this.settingsSuspensions === 0) {
                await this.playVideo();
            } else {
                this.returnToPhoto();
            }
        } catch (error) {
            if (!cancellation.signal.aborted && currentSession === this.session) {
                console.warn("[siyuan-motion-photo] Unable to read Motion Photo", error);
            }
        }
    }

    private createVideoControls() {
        const viewerRoot = this.viewer?.viewer;
        const canvas = viewerRoot?.querySelector<HTMLElement>(".viewer-canvas");
        if (!canvas) {
            return false;
        }

        const overlay = document.createElement("div");
        overlay.className = "sy-motion-photo__overlay";
        overlay.hidden = true;
        overlay.setAttribute("role", "group");
        overlay.setAttribute("aria-label", this.strings.controlsLabel);

        const video = document.createElement("video");
        video.className = "sy-motion-photo__video";
        video.autoplay = false;
        video.muted = this.imageSettings.defaultMuted;
        video.loop = false;
        video.controls = false;
        video.playsInline = true;
        video.preload = this.imageSettings.autoPlay ? "auto" : "none";
        video.setAttribute("aria-label", this.strings.videoLabel);
        video.disablePictureInPicture = true;
        video.addEventListener("ended", this.returnToPhoto);
        video.addEventListener("error", this.handleVideoError);

        const panel = document.createElement("div");
        panel.className = "sy-motion-photo__panel";

        const status = document.createElement("p");
        status.className = "sy-motion-photo__status";
        status.setAttribute("aria-live", "polite");
        panel.append(status);

        const buttons = document.createElement("div");
        buttons.className = "sy-motion-photo__buttons";
        const playButton = this.makeButton(this.strings.playVideo, this.strings.playVideo, this.togglePlayback);
        const soundLabel = video.muted ? this.strings.turnOnSound : this.strings.muteSound;
        const soundButton = this.makeButton(soundLabel, soundLabel, this.toggleAudio);
        const photoButton = this.makeButton(this.strings.showPhoto, this.strings.showPhoto, this.returnToPhoto);
        const exportLabel = this.exportLabel;
        const exportButton = this.makeButton(exportLabel, exportLabel, this.exportVideo);
        if (!this.exporter.available) {
            exportButton.disabled = true;
            exportButton.title = this.strings.exportUnavailable;
        }
        playButton.dataset.syMotionAction = "play";
        soundButton.dataset.syMotionAction = "sound";
        photoButton.dataset.syMotionAction = "photo";
        exportButton.dataset.syMotionAction = "export";
        buttons.append(playButton, soundButton, photoButton, exportButton);

        overlay.append(video, panel);
        panel.append(buttons);
        canvas.append(overlay);
        this.overlay = overlay;
        this.video = video;
        this.statusElement = status;
        return true;
    }

    private attachToolbarButtons() {
        const toolbar = this.viewer?.toolbar?.matches("div.viewer-toolbar") ? this.viewer.toolbar :
            this.viewer?.viewer?.querySelector<HTMLElement>("div.viewer-toolbar");
        const list = toolbar?.querySelector<HTMLUListElement>(":scope > ul");
        if (!list) {
            return false;
        }

        this.removeToolbarButtons();
        this.toolbarList = list;
        list.classList.add("sy-motion-photo__toolbar-list");
        const playback = this.makeToolbarButton(this.strings.playVideo, "▶", this.toggleToolbarPlayback);
        const settings = this.makeToolbarButton(this.strings.openSettings, "⚙", this.openSettings);
        playback.button.dataset.syMotionAction = "toolbar-play";
        settings.button.dataset.syMotionAction = "settings";
        this.toolbarItem = playback.item;
        this.toolbarButton = playback.button;
        this.settingsItem = settings.item;
        this.settingsButton = settings.button;
        list.append(playback.item, settings.item);
        this.viewer?.viewer?.classList.add("sy-motion-photo--enhanced");
        const footer = this.viewer?.viewer?.querySelector<HTMLElement>(".viewer-footer");
        if (footer && typeof ResizeObserver !== "undefined") {
            this.footerObserver = new ResizeObserver(() => {
                this.overlay?.style.setProperty("--sy-motion-photo-footer-height",
                    `${Math.ceil(footer.getBoundingClientRect().height)}px`);
            });
            this.footerObserver.observe(footer);
        }
        return true;
    }

    private makeToolbarButton(label: string, iconText: string, click: (event: Event) => void) {
        const item = document.createElement("li");
        item.className = "sy-motion-photo__toolbar-item";
        const button = document.createElement("button");
        button.className = "sy-motion-photo__toolbar-button";
        button.type = "button";
        const icon = document.createElement("span");
        icon.className = "sy-motion-photo__toolbar-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = iconText;
        const text = document.createElement("span");
        text.className = "sy-motion-photo__toolbar-label";
        text.textContent = label;
        button.append(icon, text);
        button.setAttribute("aria-label", label);
        button.title = label;
        button.addEventListener("click", click);
        item.append(button);
        return {item, button};
    }

    private removeToolbarButtons() {
        this.toolbarButton?.removeEventListener("click", this.toggleToolbarPlayback);
        this.settingsButton?.removeEventListener("click", this.openSettings);
        this.toolbarItem?.remove();
        this.settingsItem?.remove();
        this.toolbarList?.classList.remove("sy-motion-photo__toolbar-list");
        this.viewer?.viewer?.classList.remove("sy-motion-photo--enhanced");
        this.toolbarItem = undefined;
        this.toolbarButton = undefined;
        this.settingsItem = undefined;
        this.settingsButton = undefined;
        this.toolbarList = undefined;
    }

    private readonly openSettings = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.openSettings?.();
    }

    private makeButton(label: string, ariaLabel: string, click: (event: MouseEvent) => void) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sy-motion-photo__button";
        button.textContent = label;
        button.setAttribute("aria-label", ariaLabel);
        button.addEventListener("click", click);
        return button;
    }

    private readonly togglePlayback = (event?: Event) => {
        event?.preventDefault();
        event?.stopPropagation();
        if (!this.video) {
            return;
        }
        if (this.overlay?.hidden) {
            // Still-photo mode always starts a replay from the beginning.
            this.video.currentTime = 0;
            void this.playVideo();
        } else if (this.video.paused || this.video.ended) {
            if (this.video.ended) {
                this.video.currentTime = 0;
            }
            void this.playVideo();
        } else {
            this.pauseVideo();
        }
    };

    private readonly toggleToolbarPlayback = (event?: Event) => {
        event?.preventDefault();
        event?.stopPropagation();
        if (this.overlay && !this.overlay.hidden && !this.overlay.classList.contains("sy-motion-photo__overlay--photo")) {
            this.returnToPhoto(event);
        } else {
            this.togglePlayback(event);
        }
    };

    private readonly toggleAudio = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.video) {
            return;
        }
        this.video.muted = !this.video.muted;
        const label = this.video.muted ? this.strings.turnOnSound : this.strings.muteSound;
        const button = this.overlay?.querySelector<HTMLButtonElement>('[data-sy-motion-action="sound"]');
        if (button) {
            button.textContent = label;
            button.setAttribute("aria-label", label);
        }
    };

    private pauseVideo() {
        this.playbackAttempt += 1;
        this.video?.pause();
        this.setPlaybackStatus(this.strings.videoPaused);
        this.updatePlaybackButton(this.strings.playVideo);
    }

    private async playVideo() {
        if (this.settingsSuspensions > 0) {
            return;
        }
        const currentSession = this.session;
        const video = this.video;
        const overlay = this.overlay;
        const attempt = ++this.playbackAttempt;
        if (!video || !overlay) {
            return;
        }
        if (video.canPlayType("video/mp4") === "") {
            this.handleUnsupportedVideo();
            return;
        }
        overlay.hidden = false;
        overlay.classList.remove("sy-motion-photo__overlay--photo");
        this.hasStarted = true;
        this.setViewerMotionMode(true);
        this.updateToolbarButton(this.strings.showPhoto);
        try {
            await video.play();
            if (currentSession !== this.session || this.video !== video || attempt !== this.playbackAttempt || video.paused) {
                return;
            }
            this.setPlaybackStatus(this.strings.videoPlaying);
            this.updatePlaybackButton(this.strings.pauseVideo);
        } catch {
            if (currentSession !== this.session || this.video !== video || attempt !== this.playbackAttempt) {
                return;
            }
            if (video.error) {
                this.handleUnsupportedVideo();
            } else {
                this.setPlaybackStatus(this.strings.autoplayBlocked);
                this.updatePlaybackButton(this.strings.playVideo);
            }
        }
    }

    private readonly returnToPhoto = (event?: Event) => {
        event?.preventDefault();
        event?.stopPropagation();
        this.playbackAttempt += 1;
        if (this.video) {
            this.video.pause();
            if (Number.isFinite(this.video.duration)) {
                this.video.currentTime = 0;
            }
        }
        if (this.overlay) {
            this.overlay.hidden = true;
        }
        this.setViewerMotionMode(false);
        this.setPlaybackStatus(this.strings.photoVisible);
        this.updateToolbarButton(this.hasStarted ? this.strings.replayVideo : this.strings.playVideo);
        this.updatePlaybackButton(this.strings.playVideo);
    };

    private readonly handleVideoError = () => {
        this.handleUnsupportedVideo();
    };

    private handleUnsupportedVideo() {
        this.pauseVideo();
        if (this.overlay) {
            this.overlay.hidden = false;
            this.overlay.classList.add("sy-motion-photo__overlay--photo");
        }
        this.setViewerMotionMode(false);
        this.setPlaybackStatus(this.strings.unsupportedCodec);
        this.updateToolbarButton(this.strings.retryPlayback);
        this.updatePlaybackButton(this.strings.retryPlayback);
        showMessage(this.strings.unsupportedCodec);
    }

    private setViewerMotionMode(active: boolean) {
        this.viewer?.viewer?.classList.toggle("sy-motion-photo--playing", active);
    }

    private updateToolbarButton(label: string) {
        if (!this.toolbarButton) {
            return;
        }
        this.toolbarButton.querySelector(".sy-motion-photo__toolbar-label")!.textContent = label;
        this.toolbarButton.querySelector(".sy-motion-photo__toolbar-icon")!.textContent =
            label === this.strings.showPhoto ? "▣" : label === this.strings.replayVideo ? "↻" : "▶";
        this.toolbarButton.setAttribute("aria-label", label);
        this.toolbarButton.title = label;
    }

    private updatePlaybackButton(label: string) {
        const button = this.overlay?.querySelector<HTMLButtonElement>('[data-sy-motion-action="play"]');
        if (button) {
            button.textContent = label;
            button.setAttribute("aria-label", label);
        }
    }

    private setPlaybackStatus(message: string) {
        if (this.statusElement) {
            this.statusElement.textContent = message;
        }
    }

    private get exportLabel() {
        return this.exporter.isAndroid ? this.strings.openVideoExternal : this.strings.exportVideo;
    }

    private readonly exportVideo = async (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const videoBlob = this.videoBlob;
        const controller = this.cancellation;
        const currentSession = this.session;
        const source = this.sourceImage && cleanAssetSource(this.sourceImage.currentSrc || this.sourceImage.src);
        const button = this.overlay?.querySelector<HTMLButtonElement>('[data-sy-motion-action="export"]');
        if (!videoBlob || !controller || !source || !button || button.disabled) {
            return;
        }

        this.pauseVideo();
        button.disabled = true;
        button.textContent = this.strings.exportingVideo;
        this.setPlaybackStatus(this.strings.exportingVideo);
        try {
            const assetURL = new URL(source);
            const originalName = decodeURIComponent(assetURL.pathname.split("/").pop() ?? "motion-photo");
            const videoName = originalName.replace(/\.jpe?g$/i, ".mp4");
            const result = await this.exporter.exportVideo(videoBlob, videoName, controller.signal);
            if (controller.signal.aborted || currentSession !== this.session) {
                return;
            }
            this.setPlaybackStatus(result === "opened" ? this.strings.videoOpenedExternal :
                result === "canceled" ? this.strings.exportCanceled : this.strings.exportComplete);
        } catch (error) {
            if (!controller.signal.aborted) {
                showMessage(`${this.strings.exportFailed}: ${error instanceof Error ? error.message : String(error)}`);
                this.setPlaybackStatus(this.strings.exportFailed);
            }
        } finally {
            if (!controller.signal.aborted && button.isConnected) {
                button.disabled = false;
                button.textContent = this.exportLabel;
            }
        }
    };
}
