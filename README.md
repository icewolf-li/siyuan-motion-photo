# SiYuan Motion Photo

Play Xiaomi, Redmi, Pixel, and other Android Motion Photos in the SiYuan image lightbox.

Motion photos remain regular JPEGs in the document. When you open a supported original in the lightbox, the plugin reads its embedded MP4 and XMP metadata, then tries to play it once with sound muted. After playback, the still photo appears again. You can enable sound, pause, replay, or deliberately export the video. Ordinary photos remain unchanged. The plugin reads a photo only when its lightbox opens and never rewrites the original image.

## Use

Extract `package.zip` into your workspace's `data/plugins/siyuan-motion-photo/` directory, then enable **SiYuan Motion Photo** in SiYuan's plugin settings. On Android, extract the same archive into the mobile workspace's plugin directory and enable it there too. For local development, place the source in the plugin directory and run `pnpm run dev`. Open a JPEG in the lightbox, then use its motion-photo toolbar button or the video control panel. Choosing **Export MP4** saves a new attachment in the current workspace's `data/assets` directory.

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
