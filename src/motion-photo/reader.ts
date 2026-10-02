import {findMotionPhotoVideo, parseJpegEnd, parseMP4Boxes, parseMotionPhotoBytes} from "./parser.ts";
import type {MotionPhotoInfo} from "./parser.ts";

const METADATA_RANGE_LENGTH = 256 * 1024;
const JPEG_SCAN_RANGE_LENGTH = 256 * 1024;

interface FileRange {
    bytes: Uint8Array;
    fileSize: number;
    isCompleteFile: boolean;
}

const findFileSize = async (response: Response, requestedOffset: number, bodyLength: number, signal: AbortSignal) => {
    const contentRange = response.headers.get("Content-Range");
    const contentRangeMatch = contentRange && /^bytes\s+\d+-\d+\/(\d+)$/i.exec(contentRange);
    if (contentRangeMatch) {
        const size = Number(contentRangeMatch[1]);
        if (Number.isSafeInteger(size) && size > 0) {
            return size;
        }
    }

    const length = response.headers.get("Content-Length");
    const contentLength = length && /^\d+$/.test(length) ? Number(length) : undefined;
    if (response.status === 200 && contentLength === bodyLength) {
        return bodyLength;
    }
    if (requestedOffset > 0 && contentLength && Number.isSafeInteger(contentLength)) {
        return requestedOffset + contentLength;
    }

    try {
        const headResponse = await fetch(response.url, {method: "HEAD", signal, credentials: "same-origin"});
        if (headResponse.ok) {
            const headLength = headResponse.headers.get("Content-Length");
            if (headLength && /^\d+$/.test(headLength) && Number.isSafeInteger(Number(headLength))) {
                return Number(headLength);
            }
        }
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
    }
    return undefined;
};

const requestRange = async (url: string, start: number, end: number, signal: AbortSignal): Promise<FileRange | undefined> => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
        return undefined;
    }

    const response = await fetch(url, {
        headers: {Range: `bytes=${start}-${end}`},
        signal,
        credentials: "same-origin",
    });
    if (response.status !== 200 && response.status !== 206) {
        return undefined;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200) {
        return bytes.length > 0 ? {bytes, fileSize: bytes.length, isCompleteFile: true} : undefined;
    }

    const contentRange = response.headers.get("Content-Range");
    const match = contentRange && /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
    if (!match || Number(match[1]) !== start || Number(match[2]) < start ||
        Number(match[2]) > end || bytes.length !== Number(match[2]) - start + 1) {
        return undefined;
    }
    const fileSize = await findFileSize(response, start, bytes.length, signal);
    return fileSize ? {bytes, fileSize, isCompleteFile: false} : undefined;
};

const concatenate = (parts: Uint8Array[]) => {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
};

const getOriginalJpegURL = (source: string) => {
    try {
        const url = new URL(source, window.location.href);
        const path = decodeURIComponent(url.pathname).toLowerCase();
        if (url.origin !== window.location.origin || !path.startsWith("/assets/") ||
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

const readUnindexedVideo = async (
    url: string,
    firstRange: FileRange,
    signal: AbortSignal,
): Promise<MotionPhotoInfo | undefined> => {
    if (firstRange.isCompleteFile || firstRange.bytes.length === firstRange.fileSize) {
        const indexedVideo = parseMotionPhotoBytes(firstRange.bytes, firstRange.fileSize);
        if (indexedVideo) {
            return indexedVideo;
        }
        const jpegEnd = parseJpegEnd(firstRange.bytes);
        return jpegEnd < 0 ? undefined : findMotionPhotoVideo(firstRange.bytes, jpegEnd);
    }

    const knownFileSize = firstRange.fileSize;
    let tailLength = Math.min(JPEG_SCAN_RANGE_LENGTH, knownFileSize);

    while (tailLength > 0) {
        const tailStart = knownFileSize - tailLength;
        const range = await requestRange(url, tailStart, knownFileSize - 1, signal);
        if (!range) {
            return undefined;
        }
        if (range.isCompleteFile) {
            const indexedVideo = parseMotionPhotoBytes(range.bytes, range.fileSize);
            if (indexedVideo) {
                return indexedVideo;
            }
            const completeJpegEnd = parseJpegEnd(range.bytes);
            return completeJpegEnd < 0 ? undefined : findMotionPhotoVideo(range.bytes, completeJpegEnd);
        }
        if (range.fileSize !== knownFileSize || range.bytes.length === 0) {
            return undefined;
        }

        const tailBytes = range.bytes;
        const indexedVideo = parseMotionPhotoBytes(tailBytes, knownFileSize);
        if (indexedVideo) {
            return indexedVideo;
        }

        const localVideo = findMotionPhotoVideo(tailBytes, 0);
        if (localVideo) {
            return {...localVideo, videoOffset: tailStart + localVideo.videoOffset};
        }

        // MotionPhoto XMP can appear after the JPEG EOI (some Xiaomi cameras
        // place it beside their GainMap). A trailing moov box or an unfinished
        // XMP packet tells us that a wider suffix is worth checking. Ordinary
        // JPEGs stop here instead of loading the whole image just to find EOI.
        const hintText = new TextDecoder("latin1").decode(tailBytes);
        const hasMotionHint = /(?:MotionPhoto|MicroVideo)(?:Offset|Version)?\s*=|MotionPhoto\/\d/i.test(hintText);
        const hasTrailingMovieBox = (() => {
            for (let index = 8; index < tailBytes.length; index += 1) {
                if (tailBytes[index] !== 0x6d || tailBytes[index + 1] !== 0x6f ||
                    tailBytes[index + 2] !== 0x6f || tailBytes[index + 3] !== 0x76) {
                    continue;
                }
                const boxOffset = index - 4;
                const boxSize = ((tailBytes[boxOffset] << 24) | (tailBytes[boxOffset + 1] << 16) |
                    (tailBytes[boxOffset + 2] << 8) | tailBytes[boxOffset + 3]) >>> 0;
                if (boxSize >= 8 && boxOffset + boxSize <= tailBytes.length &&
                    tailStart + boxOffset + boxSize <= knownFileSize) {
                    return true;
                }
            }
            return false;
        })();

        if (!hasMotionHint && !hasTrailingMovieBox) {
            return undefined;
        }
        if (tailLength === knownFileSize) {
            const jpegEnd = parseJpegEnd(tailBytes);
            return jpegEnd < 0 ? undefined : findMotionPhotoVideo(tailBytes, jpegEnd);
        }
        tailLength = Math.min(knownFileSize, tailLength * 2);
    }
    return undefined;
};

export const fetchMotionPhotoVideo = async (source: string, signal: AbortSignal): Promise<Blob | undefined> => {
    const url = getOriginalJpegURL(source);
    if (!url) {
        return undefined;
    }

    const preview = await requestRange(url, 0, METADATA_RANGE_LENGTH - 1, signal);
    if (!preview) {
        return undefined;
    }

    const metadata = parseMotionPhotoBytes(preview.bytes, preview.fileSize);
    const info = metadata && metadata.videoLength > 0
        ? metadata
        : await readUnindexedVideo(url, preview, signal);
    if (!info || !Number.isSafeInteger(info.videoOffset) || !Number.isSafeInteger(info.videoLength) ||
        info.videoOffset < 0 || info.videoLength < 16 || info.videoLength > preview.fileSize - info.videoOffset) {
        return undefined;
    }

    if (preview.isCompleteFile) {
        const mp4Bytes = preview.bytes.subarray(info.videoOffset, info.videoOffset + info.videoLength);
        return parseMP4Boxes(mp4Bytes) ? new Blob([mp4Bytes.slice()], {type: "video/mp4"}) : undefined;
    }

    const videoRange = await requestRange(url, info.videoOffset, info.videoOffset + info.videoLength - 1, signal);
    if (!videoRange) {
        return undefined;
    }

    let mp4Bytes: Uint8Array;
    if (videoRange.isCompleteFile) {
        if (info.videoOffset + info.videoLength > videoRange.bytes.length) {
            return undefined;
        }
        mp4Bytes = videoRange.bytes.subarray(info.videoOffset, info.videoOffset + info.videoLength);
    } else {
        if (videoRange.bytes.length !== info.videoLength || videoRange.fileSize !== preview.fileSize) {
            return undefined;
        }
        mp4Bytes = videoRange.bytes;
    }

    return parseMP4Boxes(mp4Bytes) ? new Blob([mp4Bytes.slice()], {type: "video/mp4"}) : undefined;
};
