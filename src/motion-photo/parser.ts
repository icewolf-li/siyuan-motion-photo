const HTML_ESCAPE_PATTERN = /&(lt|gt|quot|apos|amp);/g;

export interface MotionPhotoInfo {
    videoOffset: number;
    videoLength: number;
    presentationTimestampUs?: number;
}

export interface MP4BoxSummary {
    hasFileType: boolean;
    hasMovie: boolean;
    hasMediaData: boolean;
}

const decodeXMLAttribute = (value: string) => value.replace(HTML_ESCAPE_PATTERN, (_match, entity: string) => {
    switch (entity) {
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return "\"";
        case "apos": return "'";
        default: return "&";
    }
});

export const parseJpegEnd = (bytes: Uint8Array): number => {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return -1;
    }

    let position = 2;
    while (position < bytes.length) {
        if (bytes[position] !== 0xff) {
            position += 1;
            continue;
        }

        while (bytes[position] === 0xff) {
            position += 1;
        }

        if (position >= bytes.length) {
            return -1;
        }

        const marker = bytes[position];
        const markerStart = position - 1;
        position += 1;

        if (marker === 0xd9) {
            return position;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) {
            continue;
        }
        if (position + 1 >= bytes.length) {
            return -1;
        }

        const segmentLength = (bytes[position] << 8) | bytes[position + 1];
        if (segmentLength < 2 || position + segmentLength > bytes.length) {
            return -1;
        }
        position += segmentLength;

        if (marker !== 0xda) {
            continue;
        }

        // JPEG entropy-coded data escapes a literal FF byte as FF00. Skip stuffed
        // bytes and restart markers until a real marker ends the scan.
        while (position < bytes.length) {
            if (bytes[position] !== 0xff) {
                position += 1;
                continue;
            }
            const possibleMarkerStart = position;
            position += 1;
            while (bytes[position] === 0xff) {
                position += 1;
            }
            if (position >= bytes.length) {
                return -1;
            }
            const entropyMarker = bytes[position];
            position += 1;
            if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) {
                continue;
            }
            position = possibleMarkerStart;
            break;
        }

        if (position >= bytes.length) {
            return -1;
        }
        // Recover the marker start at the end of a scan, including any FF padding.
        position = markerStart + 2 + segmentLength;
        while (position < bytes.length && bytes[position] !== 0xff) {
            position += 1;
        }
    }
    return -1;
};

const collectDirectoryItems = (xmp: string) => Array.from(
    xmp.matchAll(/<(?:[\w.-]+:)?Item\b([^>]*)\/?>/g),
    ([, rawAttributes]) => {
        const attributes = new Map<string, string>();
        for (const [, name, value] of rawAttributes.matchAll(/([\w.-]+:[\w.-]+|[\w.-]+)="([^"]*)"/g)) {
            attributes.set(name, decodeXMLAttribute(value));
        }
        return attributes;
    },
);

const safeLength = (value: string | undefined) => {
    if (value === undefined || !/^\d+$/.test(value)) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const parseXmpTimestamp = (xmp: string) => {
    const match = /(?:GCamera:)?MotionPhotoPresentationTimestampUs="(\d+)"/.exec(xmp);
    if (!match) {
        return undefined;
    }
    const timestamp = Number(match[1]);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

export const parseMotionPhotoXmp = (xmp: string, fileSize: number): MotionPhotoInfo | undefined => {
    if (!Number.isSafeInteger(fileSize) || fileSize < 16) {
        return undefined;
    }

    const items = collectDirectoryItems(xmp);
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        const mime = (item.get("Item:Mime") ?? item.get("Mime") ?? "").toLowerCase();
        const semantic = (item.get("Item:Semantic") ?? item.get("Semantic") ?? "").toLowerCase();
        if (mime !== "video/mp4" || !["motionphoto", "microvideo"].includes(semantic)) {
            continue;
        }

        const videoLength = safeLength(item.get("Item:Length") ?? item.get("Length"));
        if (!videoLength) {
            return undefined;
        }

        let followingItemsLength = 0;
        for (const followingItem of items.slice(index + 1)) {
            const followingLengthText = followingItem.get("Item:Length") ?? followingItem.get("Length");
            if (followingLengthText === undefined || followingLengthText === "0") {
                continue;
            }
            const followingLength = safeLength(followingLengthText);
            if (!followingLength || followingItemsLength > fileSize - followingLength) {
                return undefined;
            }
            followingItemsLength += followingLength;
        }

        const videoOffset = fileSize - followingItemsLength - videoLength;
        if (videoOffset < 0 || videoOffset + videoLength > fileSize) {
            return undefined;
        }
        return {videoOffset, videoLength, presentationTimestampUs: parseXmpTimestamp(xmp)};
    }

    // Older Xiaomi/Google files record the video's distance from the end.
    const isMotionPhoto = /(?:GCamera:|Camera:)?(?:MotionPhoto|MicroVideo)="1"/i.test(xmp);
    const legacyOffsetMatch = /(?:GCamera:|Camera:)?MicroVideoOffset="(\d+)"/i.exec(xmp);
    if (!isMotionPhoto || !legacyOffsetMatch) {
        return undefined;
    }

    const legacyOffset = safeLength(legacyOffsetMatch[1]);
    if (!legacyOffset || legacyOffset > fileSize) {
        return undefined;
    }
    return {
        videoOffset: fileSize - legacyOffset,
        videoLength: legacyOffset,
        presentationTimestampUs: parseXmpTimestamp(xmp),
    };
};

export const parseMotionPhotoBytes = (bytes: Uint8Array, fileSize = bytes.length): MotionPhotoInfo | undefined => {
    const xmpBytes = new TextDecoder("latin1").decode(bytes);
    const xmpStart = xmpBytes.search(/<x:xmpmeta\b/i);
    if (xmpStart === -1) {
        return undefined;
    }
    const xmpEndMarker = /<\/x:xmpmeta\s*>/i.exec(xmpBytes.slice(xmpStart));
    if (!xmpEndMarker) {
        return undefined;
    }
    const xmp = xmpBytes.slice(xmpStart, xmpStart + xmpEndMarker.index + xmpEndMarker[0].length);
    return parseMotionPhotoXmp(xmp, fileSize);
};

export const parseMP4Boxes = (bytes: Uint8Array): MP4BoxSummary | undefined => {
    if (bytes.length < 16) {
        return undefined;
    }

    let position = 0;
    let boxCount = 0;
    let hasFileType = false;
    let hasMovie = false;
    let hasMediaData = false;

    while (position + 8 <= bytes.length && boxCount < 4096) {
        const boxStart = position;
        const declaredSize = ((bytes[position] << 24) | (bytes[position + 1] << 16) |
            (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
        const boxType = String.fromCharCode(bytes[position + 4], bytes[position + 5], bytes[position + 6], bytes[position + 7]);
        let boxSize = declaredSize;
        let headerSize = 8;

        if (declaredSize === 1) {
            if (position + 16 > bytes.length) {
                return undefined;
            }
            const upper = (bytes[position + 8] * 0x1000000) + (bytes[position + 9] << 16) +
                (bytes[position + 10] << 8) + bytes[position + 11];
            const lower = ((bytes[position + 12] << 24) | (bytes[position + 13] << 16) |
                (bytes[position + 14] << 8) | bytes[position + 15]) >>> 0;
            boxSize = upper * 0x100000000 + lower;
            headerSize = 16;
        } else if (declaredSize === 0) {
            boxSize = bytes.length - boxStart;
        }

        if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || boxStart + boxSize > bytes.length) {
            return undefined;
        }
        if (boxCount === 0 && boxType !== "ftyp") {
            return undefined;
        }

        hasFileType ||= boxType === "ftyp";
        hasMovie ||= boxType === "moov";
        hasMediaData ||= boxType === "mdat";
        position += boxSize;
        boxCount += 1;
    }

    if (position !== bytes.length || boxCount < 3 || !hasFileType || !hasMovie || !hasMediaData) {
        return undefined;
    }
    return {hasFileType, hasMovie, hasMediaData};
};

export const findMotionPhotoVideo = (bytes: Uint8Array, mediaStart: number): MotionPhotoInfo | undefined => {
    const start = Math.max(0, mediaStart);
    for (let offset = start; offset + 16 <= bytes.length; offset += 1) {
        if (bytes[offset + 4] !== 0x66 || bytes[offset + 5] !== 0x74 ||
            bytes[offset + 6] !== 0x79 || bytes[offset + 7] !== 0x70) {
            continue;
        }
        const leadingBoxSize = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
        if (leadingBoxSize < 16 || leadingBoxSize > bytes.length - offset) {
            continue;
        }
        const boxes = parseMP4Boxes(bytes.subarray(offset));
        if (boxes) {
            return {videoOffset: offset, videoLength: bytes.length - offset};
        }
    }
    return undefined;
};
