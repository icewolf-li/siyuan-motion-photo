# 思源动态照片

在思源笔记图片灯箱中播放小米、Redmi、Pixel 等设备拍摄的 Android Motion Photo。

正文中图片仍以普通 JPG 展示。点开支持的动态照片后，插件从 JPG 原片读取 Motion Photo/XMP 元数据和 MP4，静音自动播放一次。播放结束会回到静态照片；也可以开启声音、暂停、重播或主动导出 MP4。普通图片无需更改。照片只在用户打开灯箱后读取，插件不会改写原片。

## 使用

将 `package.zip` 解压到工作空间 `data/plugins/siyuan-motion-photo/`，再在思源「集市 → 下载 → 插件」中启用「思源动态照片」。更新时覆盖旧插件文件，再停用、启用插件或重启思源。本地调试时，也可以把源码放在该目录并运行 `pnpm run dev`。Android 移动端需要把同一个 ZIP 解压到移动端工作空间的相同插件目录，并在插件设置中启用。点开笔记中的 JPG，再用灯箱工具栏的动态照片按钮或视频控制面板切换播放。

桌面端选择「导出 MP4」会弹出系统保存窗口，可以选择任意允许写入的位置。插件先将视频暂存到工作空间 `temp/export/siyuan-motion-photo/`，再调用思源 `saveExportFile`，由内核复制到所选位置。完成、取消或失败后清理临时视频；文件不会自动保存为 assets 附件。系统保存窗口已经打开后，关闭灯箱不会取消你在该窗口中选择的保存操作。

Android 端第四个按钮为「用其他应用打开」。思源 3.8.5 的原生打开接口要求文件位于 assets，因此插件仅在点击后将 MP4 暂存到 `data/assets/siyuan-motion-photo-temp/`，然后调用 Android 原生打开方式，由系统选择播放器或其他支持 MP4 的应用；已设置默认应用时可能直接打开。分享或永久保存可在接收应用或系统文件管理器中操作。导出前会暂停灯箱视频。

Android 临时文件保留约 30 分钟，供其他应用读取，不立即随灯箱关闭而删除。如果思源退出或插件停用期间超过保留时间，下次启用插件会清理过期文件。只清理该子目录中插件生成的临时 MP4，不删除原片或其他附件，也不在笔记正文中插入链接。这些临时文件仍在 assets 中，可能参与工作空间同步；需要永久保留的视频请及时复制或保存到设备的其他位置。插件没有 Android 接收应用读取完毕的回调，因此「已交给系统打开方式」表示已发起原生调用，不代表其他应用已成功播放。

插件以思源 3.8.5 为最低版本，提供桌面端和 Android 移动端前端。浏览器和系统必须支持对应的 MP4 视频编码。小米 15 Pro 样本使用 HEVC/H.265 和 AAC；无法解码时，图片继续显示，插件提示编码不受支持，并允许导出原始 MP4。插件不转码，也不上传照片到外部服务。

## 开发与构建

安装 Node.js 24 或更高版本及 pnpm，然后在插件目录执行：

```powershell
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Webpack 会在项目根目录生成 `package.zip`，其中包含安装所需的文件。将 ZIP 内容解压到思源工作空间 `data/plugins/siyuan-motion-photo/` 后，在思源的插件设置中启用。直接在该目录开发时，先运行 `pnpm run dev`，由 Webpack 在根目录生成 `index.js`、`index.css` 和本地化文件。

自动化测试包含解析器、MP4 结构校验、实际的小米样本、Range 请求、服务器不支持 Range、XMP 缺失时的容器扫描，以及中断和资源边界场景。导出测试覆盖桌面系统保存调用、取消和失败、读取中关闭或停用、Android 临时附件打开、延迟清理和重启后清理。原生接口在测试中使用模拟实现，Windows 系统保存窗口和 Android 真机打开方式仍需在对应设备上验收。

原生导出接入依据思源 [3.8.5 的 saveExportFile 实现](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/protyle/util/compatibility.ts)、[内核文件 API](https://github.com/siyuan-note/siyuan/blob/v3.8.5/kernel/api/file.go)及 [Android 3.8.5 的 openExternal 实现](https://github.com/siyuan-note/siyuan-android/blob/v3.8.5/app/src/main/java/org/b3log/siyuan/JSAndroid.java)。
