# SiYuan Motion Photo

Play Xiaomi, Redmi, Pixel, and other Android Motion Photos in the SiYuan image lightbox.

Motion photos remain regular JPEGs in the document. When you open a supported original in the lightbox, the plugin reads its embedded MP4 and XMP metadata, then tries to play it once with sound muted. After playback, the still photo appears again. You can enable sound, pause, replay, or deliberately export the video. Ordinary photos remain unchanged. The plugin reads a photo only when its lightbox opens and never rewrites the original image.

## Use

Extract `package.zip` into your workspace's `data/plugins/siyuan-motion-photo/` directory, then enable **SiYuan Motion Photo** in SiYuan's plugin settings. To update, overwrite the previous files and disable/re-enable the plugin or restart SiYuan. On Android, extract the same archive into the mobile workspace's plugin directory and enable it there too. For local development, place the source in the plugin directory and run `pnpm run dev`. Open a JPEG in the lightbox, then use its motion-photo toolbar button or the video control panel.

On desktop, **Export MP4** opens the native Save dialog. The plugin stages the video in `temp/export/siyuan-motion-photo/` and calls SiYuan's `saveExportFile`; the kernel copies it to the location you choose. Temporary videos are removed after saving, cancellation, or failure. Desktop exports do not create assets attachments. Once the native dialog opens, closing the lightbox does not cancel a save you confirm in that dialog.

On Android, the fourth button is **Open with another app**. SiYuan 3.8.5 requires an assets file for native opening, so the plugin creates a temporary MP4 in `data/assets/siyuan-motion-photo-temp/` only after a click, then calls Android's native open action. The system selects an MP4-capable application, or uses an existing default. Use the recipient application or system file manager to share or save a permanent copy. Lightbox playback pauses before exporting.

Android temporary videos remain available for approximately 30 minutes so other apps can read them. Closing the lightbox does not delete them immediately. If the app exits or the plugin is disabled, overdue files are cleaned up on the next plugin load. Cleanup only touches plugin-generated MP4s in this dedicated directory; original images and other attachments are preserved, and no link is inserted into the note. Temporary assets may be included in workspace synchronization. Save any video you want to keep elsewhere before it expires. Android exposes no recipient-completed callback, so the UI confirms the native handoff rather than successful playback in the receiving app.

The plugin requires SiYuan 3.8.5 or later and supports desktop and Android mobile frontends. Playback depends on the video codecs available in the application and operating system. The supplied Xiaomi 15 Pro sample uses HEVC/H.265 and AAC. If the client cannot decode the video, the original still photo remains visible and the plugin reports that the codec is unsupported. You can still export the original MP4. This plugin does not transcode images or send them to an external service.

## Build

Install Node.js 24 or later and pnpm, then run these commands in the plugin directory:

```powershell
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Webpack generates the installable archive at `package.zip`. Extract the archive's contents into `data/plugins/siyuan-motion-photo/` and enable the plugin in SiYuan's plugin settings. For development, run `pnpm run dev` in that directory; Webpack writes the runtime files beside `plugin.json`.

Automated tests cover parsing, the supplied Xiaomi sample, Range reading, playback fallbacks, lifecycle cleanup, native export handoff, cancellation, errors, and Android temporary-file expiration and recovery. Native interfaces are mocked in these tests; desktop Save dialogs and Android recipient apps still require validation on actual devices.

Native integration follows SiYuan [3.8.5's saveExportFile helper](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/protyle/util/compatibility.ts), [kernel file API](https://github.com/siyuan-note/siyuan/blob/v3.8.5/kernel/api/file.go), and [Android 3.8.5's openExternal bridge](https://github.com/siyuan-note/siyuan-android/blob/v3.8.5/app/src/main/java/org/b3log/siyuan/JSAndroid.java).
