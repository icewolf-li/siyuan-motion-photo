# SiYuan Motion Photo

Play Xiaomi, Redmi, Pixel, and other Android Motion Photos in the SiYuan image lightbox.

Motion photos remain regular JPEGs in the document. When you open a supported original in the lightbox, the plugin reads its embedded MP4 and XMP metadata, then by default tries to play it once with sound muted. After playback, the still photo appears again; visible **Replay motion photo** and **Motion photo settings** buttons remain in the native toolbar. You can enable sound, pause, replay, or deliberately export the video. Ordinary photos remain unchanged. The plugin reads a photo only when its lightbox opens and never rewrites the original image.

## Use

Extract `package.zip` into your workspace's `data/plugins/siyuan-motion-photo/` directory, then enable **SiYuan Motion Photo** in SiYuan's plugin settings. To update, overwrite the previous files and disable/re-enable the plugin or restart SiYuan. On Android, extract the same archive into the mobile workspace's plugin directory and enable it there too. For local development, place the source in the plugin directory and run `pnpm run dev`. Open a JPEG in the lightbox, then use its motion-photo toolbar button or the video control panel.

In 0.1.3, open the native settings dialog from the plugin's gear icon or **Motion photo settings** in the lightbox. Both entries share one dialog.

- **Autoplay** defaults to on. Turn it off to start with the still photo and a **Play motion photo** button.
- **Mute by default** defaults to on. Turn it off to start new photos with sound; the playback controls can still toggle sound. If the system blocks audible autoplay, press Play manually.

**Save** commits the settings and closes the dialog only after a successful write. They apply to the next photo you open or switch to. **Cancel** or Escape discards unsaved changes. Failed saves keep the draft and display an error so you can retry. Controls and cancellation are disabled while saving to prevent duplicate writes. Configuration is stored in the workspace at `data/storage/petal/siyuan-motion-photo/settings.json`; missing or corrupt data uses the defaults.

Opening settings pauses playback without resetting its position and suspends the underlying lightbox's keyboard handling. Closing settings leaves the video paused; use the video panel's Play button to resume. After playback ends or you select **View still photo**, the toolbar's **Replay motion photo** starts from the beginning. Native image navigation, thumbnails and Close remain available.

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

Automated tests cover parsing, the supplied Xiaomi sample, Range reading, playback fallbacks, lifecycle cleanup, native export handoff, cancellation, errors, and Android temporary-file expiration and recovery. Version 0.1.3 also tests all four settings combinations, persistence, failed and canceled saves, unloading during load or save, the actual toolbar DOM hierarchy, replay, pause position and keyboard restoration.

An isolated local browser fixture has checked desktop and 360px layouts using SiYuan 3.8.5's Viewer.js, desktop/mobile styles and Dialog source. Plugin storage, Dialog helpers and native exports use isolated implementations in this fixture. These checks are separate from acceptance inside an installed SiYuan client: Windows, Android devices and other desktop systems still require that acceptance. See `VALIDATION.zh-CN.md` in the source directory for actual results and pending checks. The user photo is excluded from the installation package; sample tests require the supplied `motion (2).jpg` in the source root.

Settings integration follows SiYuan [3.8.5's Plugin API](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/plugin/index.ts) and [native Dialog](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/dialog/index.ts).

Native integration follows SiYuan [3.8.5's saveExportFile helper](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/protyle/util/compatibility.ts), [kernel file API](https://github.com/siyuan-note/siyuan/blob/v3.8.5/kernel/api/file.go), and [Android 3.8.5's openExternal bridge](https://github.com/siyuan-note/siyuan-android/blob/v3.8.5/app/src/main/java/org/b3log/siyuan/JSAndroid.java).
