import {showMessage} from "siyuan";
import type {MotionPhotoTranslations} from "./viewerTypes.ts";
import {fetchMotionPhotoVideo} from "./reader.ts";
import {MotionPhotoExporter} from "./exporter.ts";

interface NativeViewer {
    element: HTMLElement;
    viewer?: HTMLElement;
    toolbar?: HTMLElement;
    image?: HTMLImageElement;
    viewed?: boolean;
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
    private viewer: NativeViewer | undefined;
    private cancellation: AbortController | undefined;
    private video: HTMLVideoElement | undefined;
    private overlay: HTMLDivElement | undefined;
    private toolbarItem: HTMLLIElement | undefined;
    private toolbarButton: HTMLButtonElement | undefined;
    private statusElement: HTMLParagraphElement | undefined;
    private sourceImage: HTMLImageElement | undefined;
    private activeSource: string | undefined;
    private blobUrl: string | undefined;
    private videoBlob: Blob | undefined;
    private readonly exporter = new MotionPhotoExporter();
    private session = 0;
    private readonly viewedUrls = new Map<string, "static" | "motion">();
    private readonly strings: MotionPhotoTranslations;

    constructor(strings: MotionPhotoTranslations) {
        this.strings = strings;
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
        this.toolbarItem?.remove();
        this.toolbarItem = undefined;
        this.toolbarButton = undefined;
    }

    private readonly bindCurrentViewer = () => {
        const viewer = (window as unknown as {siyuan?: {viewer?: NativeViewer}}).siyuan?.viewer;
        if (!viewer || viewer === this.viewer || !viewer.element?.addEventListener || !viewer.viewer) {
            return;
        }

        this.unbindViewer();
        this.viewer = viewer;
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
        this.toolbarItem?.remove();
        this.toolbarItem = undefined;
        this.toolbarButton = undefined;
        this.viewedUrls.clear();
    };

    private removeViewerListeners(viewer: NativeViewer) {
        viewer.element.removeEventListener("view", this.handleImageChange);
        viewer.element.removeEventListener("viewed", this.handleImageViewed);
        viewer.element.removeEventListener("hide", this.handleViewerHide);
        viewer.element.removeEventListener("hidden", this.handleViewerHidden);
    }

    private unbindViewer() {
        if (this.viewer) {
            this.removeViewerListeners(this.viewer);
        }
        this.viewer = undefined;
        this.resetCurrentImage();
        this.toolbarItem?.remove();
        this.toolbarItem = undefined;
        this.toolbarButton = undefined;
        this.viewedUrls.clear();
    }

    private resetCurrentImage() {
        this.session += 1;
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
        this.overlay?.remove();
        this.overlay = undefined;
        this.video = undefined;
        this.statusElement = undefined;
        this.sourceImage = undefined;
        this.activeSource = undefined;
        this.setViewerMotionMode(false);
        if (this.toolbarItem) {
            this.toolbarItem.hidden = true;
        }
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
            this.attachToolbarButton();
            this.setPlaybackStatus(this.strings.loadingVideo);
            this.video!.src = this.blobUrl;
            this.video!.load();
            await this.playVideo(currentSession);
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
        overlay.setAttribute("role", "group");
        overlay.setAttribute("aria-label", this.strings.controlsLabel);

        const video = document.createElement("video");
        video.className = "sy-motion-photo__video";
        video.autoplay = true;
        video.muted = true;
        video.loop = false;
        video.controls = false;
        video.playsInline = true;
        video.preload = "auto";
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
        const soundButton = this.makeButton(this.strings.turnOnSound, this.strings.turnOnSound, this.toggleAudio);
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

    private attachToolbarButton() {
        const viewerToolbar = this.viewer?.toolbar?.querySelector<HTMLElement>(".viewer-toolbar") ??
            this.viewer?.viewer?.querySelector<HTMLElement>(".viewer-toolbar");
        if (!viewerToolbar) {
            return;
        }

        if (!this.toolbarItem || !this.toolbarItem.isConnected) {
            const item = document.createElement("li");
            item.className = "sy-motion-photo__toolbar-item";
            const button = document.createElement("button");
            button.className = "sy-motion-photo__toolbar-button";
            button.type = "button";
            button.addEventListener("click", this.toggleToolbarPlayback);
            item.append(button);
            viewerToolbar.append(item);
            this.toolbarItem = item;
            this.toolbarButton = button;
        }
        this.toolbarItem.hidden = false;
        this.updateToolbarButton(this.strings.showPhoto);
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
            void this.showVideoAndPlay();
        } else if (this.video.paused || this.video.ended) {
            if (this.video.ended) {
                this.video.currentTime = 0;
            }
            void this.showVideoAndPlay();
        } else {
            this.video.pause();
            this.setPlaybackStatus(this.strings.videoPaused);
            this.updatePlaybackButton(this.strings.playVideo);
        }
    };

    private readonly toggleToolbarPlayback = (event?: Event) => {
        event?.preventDefault();
        event?.stopPropagation();
        if (this.overlay && !this.overlay.hidden) {
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

    private async showVideoAndPlay() {
        const currentSession = this.session;
        const video = this.video;
        if (!video || video.canPlayType("video/mp4") === "") {
            this.handleUnsupportedVideo();
            return;
        }
        this.overlay!.hidden = false;
        this.overlay!.classList.remove("sy-motion-photo__overlay--photo");
        this.setViewerMotionMode(true);
        try {
            await video.play();
            if (currentSession !== this.session || this.video !== video) {
                return;
            }
            this.setPlaybackStatus(this.strings.videoPlaying);
            this.updatePlaybackButton(this.strings.pauseVideo);
        } catch {
            if (currentSession !== this.session || this.video !== video) {
                return;
            }
            if (!video.error) {
                this.setPlaybackStatus(this.strings.autoplayBlocked);
                this.updatePlaybackButton(this.strings.playVideo);
            }
        }
    }

    private async playVideo(currentSession: number) {
        if (!this.video || !this.overlay || this.video.canPlayType("video/mp4") === "") {
            this.handleUnsupportedVideo();
            return;
        }
        this.overlay.hidden = false;
        this.overlay.classList.remove("sy-motion-photo__overlay--photo");
        this.setViewerMotionMode(true);
        try {
            await this.video.play();
            if (currentSession !== this.session || !this.video) {
                return;
            }
            this.overlay.hidden = false;
            this.setPlaybackStatus(this.strings.videoPlaying);
            this.updatePlaybackButton(this.strings.pauseVideo);
        } catch {
            if (currentSession !== this.session || !this.video) {
                return;
            }
            if (this.video.error) {
                return;
            }
            this.overlay.hidden = false;
            this.setPlaybackStatus(this.strings.autoplayBlocked);
            this.updatePlaybackButton(this.strings.playVideo);
        }
    }

    private readonly returnToPhoto = (event?: Event) => {
        event?.preventDefault();
        event?.stopPropagation();
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
        this.updateToolbarButton(this.strings.playVideo);
        this.updatePlaybackButton(this.strings.playVideo);
    };

    private readonly handleVideoError = () => {
        this.handleUnsupportedVideo();
    };

    private handleUnsupportedVideo() {
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
        this.toolbarButton.textContent = label === this.strings.playVideo ? "↻" : "▶";
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

        this.video?.pause();
        this.updatePlaybackButton(this.strings.playVideo);
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
