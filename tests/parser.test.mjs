import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import {
    findMotionPhotoVideo,
    parseJpegEnd,
    parseMP4Boxes,
    parseMotionPhotoBytes,
    parseMotionPhotoXmp,
} from "../src/motion-photo/parser.ts";

const box = (type, payload = new Uint8Array()) => {
    const result = new Uint8Array(8 + payload.length);
    new DataView(result.buffer).setUint32(0, result.length);
    result.set([...type].map(character => character.charCodeAt(0)), 4);
    result.set(payload, 8);
    return result;
};

const validMp4 = () => {
    const ftyp = box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]));
    const moov = box("moov");
    const mdat = box("mdat");
    return new Uint8Array([...ftyp, ...moov, ...mdat]);
};

const directoryXmp = (videoLength, suffixLength = 0) => `
  <x:xmpmeta>
    <rdf:Description GCamera:MotionPhoto="1"
      GCamera:MotionPhotoPresentationTimestampUs="998654">
      <Container:Directory><rdf:Seq>
        <rdf:li><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary"/></rdf:li>
        <rdf:li><Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="473340"/></rdf:li>
        <rdf:li><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLength}"/></rdf:li>
        ${suffixLength ? `<rdf:li><Container:Item Item:Mime="application/octet-stream" Item:Semantic="Data" Item:Length="${suffixLength}"/></rdf:li>` : ""}
      </rdf:Seq></Container:Directory>
    </rdf:Description>
  </x:xmpmeta>`;

test("parses Xiaomi/Android Motion Photo XMP and counts preceding GainMap and following items", () => {
    assert.deepEqual(parseMotionPhotoXmp(directoryXmp(506134, 128), 3361505), {
        videoOffset: 2855243,
        videoLength: 506134,
        presentationTimestampUs: 998654,
    });
});

test("reads actual Xiaomi 15 Pro metadata, offset, timestamp, and embedded HEVC video", async () => {
    const file = new Uint8Array(await readFile("motion (2).jpg"));
    const info = parseMotionPhotoBytes(file);
    assert.deepEqual(info, {
        videoOffset: 2855371,
        videoLength: 506134,
        presentationTimestampUs: 998654,
    });
    assert.deepEqual(parseMP4Boxes(file.subarray(info.videoOffset, info.videoOffset + info.videoLength)), {
        hasFileType: true,
        hasMovie: true,
        hasMediaData: true,
    });

    const mp4Bytes = file.subarray(info.videoOffset, info.videoOffset + info.videoLength);
    const payloadText = new TextDecoder("latin1").decode(mp4Bytes);
    assert.ok(payloadText.includes("hvc1"));
    assert.ok(payloadText.includes("mp4a"));
});

test("finds old MicroVideoOffset values measured from the end of the file", () => {
    const fileSize = 4096;
    assert.deepEqual(parseMotionPhotoXmp(
        '<rdf:Description GCamera:MotionPhoto="1" GCamera:MicroVideo="1" GCamera:MicroVideoOffset="1024"/>',
        fileSize,
    ), {videoOffset: 3072, videoLength: 1024, presentationTimestampUs: undefined});
});

test("rejects missing, malformed, zero-length, and out-of-bounds motion-photo data", () => {
    assert.equal(parseMotionPhotoBytes(new TextEncoder().encode("ordinary JPEG with no XMP or video")), undefined);
    assert.equal(parseMotionPhotoBytes(new TextEncoder().encode('<x:xmpmeta><rdf:Description GCamera:MicroVideoOffset="8"'), 80), undefined);
    assert.equal(parseMotionPhotoXmp(directoryXmp(1000), 900), undefined);
    assert.equal(parseMotionPhotoXmp(
        directoryXmp("999999999999999999999999999999999999999999999999999"),
        400,
    ), undefined);
    assert.equal(parseMotionPhotoXmp(
        '<rdf:Description GCamera:MotionPhoto="1" GCamera:MicroVideoOffset="wat"/>',
        400,
    ), undefined);
    assert.equal(parseMotionPhotoXmp(
        '<rdf:Description GCamera:MotionPhoto="1" GCamera:MicroVideoOffset="0"/>',
        400,
    ), undefined);
});

test("requires complete top-level MP4 boxes and does not trust stray ftyp text", () => {
    const mp4 = validMp4();
    assert.deepEqual(parseMP4Boxes(mp4), {hasFileType: true, hasMovie: true, hasMediaData: true});
    assert.equal(parseMP4Boxes(mp4.subarray(0, mp4.length - 1)), undefined);
    assert.equal(parseMP4Boxes(new TextEncoder().encode("photoftyp-not-an-mp4-box")), undefined);
    const result = new Uint8Array([1, 2, 3, ...mp4]);
    assert.deepEqual(findMotionPhotoVideo(result, 0), {
        videoOffset: 3,
        videoLength: mp4.length,
    });
    assert.equal(findMotionPhotoVideo(result.subarray(0, 12), 0), undefined);
});

test("recognizes JPEG scan markers while skipping stuffed FF bytes", () => {
    const image = new Uint8Array([
        0xff, 0xd8,
        0xff, 0xe0, 0, 4, 0x11, 0x22,
        0xff, 0xda, 0, 2,
        0x1f, 0xff, 0, 0x2a,
        0xff, 0xd9,
    ]);
    assert.equal(parseJpegEnd(image), image.length);
    assert.equal(parseJpegEnd(new Uint8Array([0, 1, 2, 3])), -1);
    assert.equal(parseJpegEnd(image.subarray(0, image.length - 2)), -1);
});
