import {getBackend, getFrontend, saveExportFile} from "siyuan";

// Android 3.8.5 grants other applications access only to assets through
// JSAndroid.openExternal. Keep these files alive while the recipient reads them.
export const ANDROID_TEMP_LIFETIME_MS = 30 * 60 * 1000;
export const ANDROID_TEMP_DIRECTORY = "/data/assets/siyuan-motion-photo-temp";
const TEMP_ASSET_NAME = /^motion-photo-(\d{13})-[0-9a-f]{32}-[^/\\]+\.mp4$/i;

interface KernelResponse<T> {
    code?: number;
    msg?: string;
    data?: T;
}

interface NativeSaveResult {
    status: "success" | "canceled" | "error";
    message?: string;
}

interface AndroidBridge {
    openExternal(uri: string): void;
}

export type VideoExportResult = "saved" | "canceled" | "opened";

const abortIfNeeded = (signal: AbortSignal) => {
    if (signal.aborted) {
        throw new DOMException("The export was canceled.", "AbortError");
    }
};

const safeVideoName = (name: string) => {
    let stem = name.replace(/\.mp4$/i, "")
        .replace(/[<>:"/\\|?*#%\u0000-\u001f]/g, "_")
        .replace(/\.{2,}/g, ".")
        .replace(/^[.\s]+|[.\s]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) {
        stem = `_${stem}`;
    }
    let shortStem = "";
    const encoder = new TextEncoder();
    for (const character of stem) {
        if (encoder.encode(shortStem + character).length > 120) {
            break;
        }
        shortStem += character;
    }
    return `${shortStem.replace(/[.\s]+$/g, "") || "motion-photo"}.mp4`;
};

const newExportID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("");

const postKernel = async <T>(endpoint: string, body: FormData | object, signal?: AbortSignal) => {
    const isForm = body instanceof FormData;
    const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        ...(isForm ? {} : {headers: {"Content-Type": "application/json"}}),
        body: isForm ? body : JSON.stringify(body),
        signal,
    });
    const result = await response.json() as KernelResponse<T>;
    if (!response.ok || result.code !== 0) {
        const error = new Error(result.msg || `HTTP ${response.status}: ${endpoint}`);
        Object.assign(error, {code: result.code ?? response.status});
        throw error;
    }
    return result.data;
};

const putVideo = async (path: string, video: Blob, name: string, signal: AbortSignal) => {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", "false");
    form.append("file", new File([video], name, {type: "video/mp4"}));
    await postKernel("/api/file/putFile", form, signal);
};

const removeTemporaryFile = async (path: string, signal?: AbortSignal) => {
    try {
        await postKernel("/api/file/removeFile", {path}, signal);
        return true;
    } catch (error) {
        if ((error as {code?: number}).code === 404) {
            return true;
        }
        if (!signal?.aborted) {
            console.warn("[siyuan-motion-photo] Unable to remove temporary export", error);
        }
        return false;
    }
};

export class MotionPhotoExporter {
    private maintenance: AbortController | undefined;
    private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly temporaryAssets = new Map<string, number>();
    private stopped = false;

    get isAndroid() {
        return getFrontend() === "mobile" && getBackend() === "android";
    }

    get available() {
        if (this.isAndroid) {
            return typeof this.androidBridge?.openExternal === "function";
        }
        return ["desktop", "desktop-window"].includes(getFrontend()) &&
            ["windows", "linux", "darwin"].includes(getBackend()) &&
            typeof saveExportFile === "function";
    }

    private get androidBridge() {
        return (window as unknown as {JSAndroid?: AndroidBridge}).JSAndroid;
    }

    start() {
        this.stopped = false;
        this.maintenance = new AbortController();
        if (this.isAndroid) {
            void this.discoverTemporaryAssets(this.maintenance.signal);
        }
    }

    stop() {
        this.stopped = true;
        this.maintenance?.abort();
        this.maintenance = undefined;
        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = undefined;
        this.temporaryAssets.clear();
        // Android has no recipient-completed callback. Expired exports are
        // discovered again on the next plugin load instead of being deleted
        // as soon as the lightbox closes or the app goes into the background.
    }

    async exportVideo(video: Blob, name: string, signal: AbortSignal): Promise<VideoExportResult> {
        abortIfNeeded(signal);
        if (this.stopped || !this.available) {
            throw new Error("The native file export interface is unavailable.");
        }
        const fileName = safeVideoName(name);
        if (this.isAndroid) {
            return this.openOnAndroid(video, fileName, signal);
        }
        return this.saveOnDesktop(video, fileName, signal);
    }

    private async saveOnDesktop(video: Blob, name: string, signal: AbortSignal): Promise<VideoExportResult> {
        const relativePath = `siyuan-motion-photo/${newExportID()}/${name}`;
        const path = `/temp/export/${relativePath}`;
        try {
            await putVideo(path, video, name, signal);
            abortIfNeeded(signal);
            if (this.stopped) {
                throw new DOMException("The plugin has stopped.", "AbortError");
            }
            const uri = `/export/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
            // SiYuan 3.8.5 returns a result although older SDK typings say void.
            // Its helper opens the native save dialog, then calls the kernel's
            // /api/export/copyExportFile. No Electron or Node runtime is bundled.
            const result = await saveExportFile(uri) as unknown as NativeSaveResult | undefined;
            if (result?.status === "canceled") {
                return "canceled";
            }
            if (result?.status !== "success") {
                throw new Error(result?.message || "SiYuan could not save the video.");
            }
            return "saved";
        } finally {
            // A save dialog already handed to the OS may finish after the
            // lightbox closes. Do not remove its source until the helper ends.
            await removeTemporaryFile(path);
        }
    }

    private async openOnAndroid(video: Blob, name: string, signal: AbortSignal): Promise<VideoExportResult> {
        const expiresAt = Date.now() + ANDROID_TEMP_LIFETIME_MS;
        const temporaryName = `motion-photo-${expiresAt}-${newExportID()}-${name}`;
        const path = `${ANDROID_TEMP_DIRECTORY}/${temporaryName}`;
        // Also retry cleanup of attempted writes: canceling fetch cannot prove
        // that the kernel did not finish writing after the client disconnected.
        this.temporaryAssets.set(path, expiresAt);
        this.scheduleCleanup();
        let handedOff = false;
        try {
            await putVideo(path, video, name, signal);
            abortIfNeeded(signal);
            if (this.stopped) {
                throw new DOMException("The plugin has stopped.", "AbortError");
            }
            this.androidBridge!.openExternal(`assets/siyuan-motion-photo-temp/${encodeURIComponent(temporaryName)}`);
            handedOff = true;
            return "opened";
        } finally {
            if (!handedOff) {
                await removeTemporaryFile(path);
            }
        }
    }

    private async discoverTemporaryAssets(signal: AbortSignal) {
        try {
            const entries = await postKernel<Array<{name: string; isDir: boolean; isSymlink?: boolean}>>(
                "/api/file/readDir", {path: ANDROID_TEMP_DIRECTORY}, signal,
            );
            if (signal.aborted || !Array.isArray(entries)) {
                return;
            }
            for (const entry of entries) {
                const match = typeof entry.name === "string" && TEMP_ASSET_NAME.exec(entry.name);
                if (match && !entry.isDir && !entry.isSymlink) {
                    this.temporaryAssets.set(`${ANDROID_TEMP_DIRECTORY}/${entry.name}`, Number(match[1]));
                }
            }
            await this.cleanupExpiredAssets();
        } catch (error) {
            if (!signal.aborted && (error as {code?: number}).code !== 404) {
                console.warn("[siyuan-motion-photo] Unable to check temporary exports", error);
            }
        }
    }

    private async cleanupExpiredAssets() {
        const signal = this.maintenance?.signal;
        if (!signal || signal.aborted || this.stopped) {
            return;
        }
        for (const [path, expiresAt] of this.temporaryAssets) {
            if (signal.aborted) {
                return;
            }
            if (expiresAt <= Date.now() && await removeTemporaryFile(path, signal)) {
                this.temporaryAssets.delete(path);
            }
        }
        this.scheduleCleanup();
    }

    private scheduleCleanup() {
        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = undefined;
        if (this.stopped || !this.maintenance || this.temporaryAssets.size === 0) {
            return;
        }
        const expiresAt = Math.min(...this.temporaryAssets.values());
        // Retry failures at most once a minute; timers also recover after an
        // Android WebView resumes from the background.
        const delay = Math.max(60_000, Math.min(ANDROID_TEMP_LIFETIME_MS, expiresAt - Date.now()));
        this.cleanupTimer = setTimeout(() => {
            this.cleanupTimer = undefined;
            void this.cleanupExpiredAssets();
        }, delay);
    }
}
