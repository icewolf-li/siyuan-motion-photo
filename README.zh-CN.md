# 思源动态照片

在思源笔记图片灯箱中播放小米、Redmi、Pixel 等设备拍摄的 Android Motion Photo。

正文中图片仍以普通 JPG 展示。点开支持的动态照片后，插件从 JPG 原片读取 Motion Photo/XMP 元数据和 MP4，默认静音自动播放一次。播放结束会回到静态照片，原生工具栏保留带文字的「重播动态照片」和「动态照片设置」按钮；也可以开启声音、暂停或主动导出 MP4。普通图片无需更改。照片只在用户打开灯箱后读取，插件不会改写原片。

## 使用

将 `package.zip` 解压到工作空间 `data/plugins/siyuan-motion-photo/`，再在思源「集市 → 下载 → 插件」中启用「思源动态照片」。更新时覆盖旧插件文件，再停用、启用插件或重启思源。本地调试时，也可以把源码放在该目录并运行 `pnpm run dev`。Android 移动端需要把同一个 ZIP 解压到移动端工作空间的相同插件目录，并在插件设置中启用。点开笔记中的 JPG，再用灯箱工具栏的动态照片按钮或视频控制面板切换播放。

0.1.3 新增设置弹窗。可从插件列表中本插件的齿轮，或动态照片灯箱中的「动态照片设置」按钮打开；两个入口共用同一个思源原生弹窗。

- **自动播放**：默认开启。关闭后先显示照片，点击「播放动态照片」才播放。
- **默认静音**：默认开启。关闭后新照片从有声状态开始，播放时仍可通过「静音／开启声音」按钮切换。系统阻止有声自动播放时，点击播放按钮继续。

点击「保存」成功后关闭弹窗，设置对后续打开灯箱或切图生效；当前照片的声音状态不会被修改。「取消」或 Escape 丢弃草稿。保存失败会保留草稿并显示错误，可重试。保存期间暂时禁用开关和取消操作，防止重复写入。配置保存到工作空间 `data/storage/petal/siyuan-motion-photo/settings.json`，随工作空间共享；未找到或损坏时使用默认值。

打开设置会暂停当前视频并保留播放位置，同时暂停底层灯箱的键盘响应。关闭后不会自行恢复播放，点击视频面板中的「播放动态照片」从暂停处继续。播放结束或点击「查看静态照片」后，点击原生工具栏中的「重播动态照片」从头播放；原生上一张、下一张、缩略图和关闭操作继续可用。

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

自动化测试包含解析器、MP4 结构校验、实际的小米样本、Range 请求、服务器不支持 Range、XMP 缺失时的容器扫描，以及中断和资源边界场景。0.1.3 增加设置的四种组合、持久化、保存失败、取消、加载或保存期间停用，以及真实工具栏层级下的重播、暂停位置和键盘恢复测试。导出测试继续覆盖桌面系统保存调用、取消和失败、Android 临时附件打开、延迟清理和重启后清理。

本地浏览器已使用思源 3.8.5 自带 Viewer.js、桌面／移动样式及 Dialog 源码验证桌面和 360 像素窄屏交互。测试页面的插件存储、Dialog 辅助依赖和原生导出接口使用隔离实现；这些检查不代表安装到思源后的真机验收。Windows 思源内的实际操作、Android 真机及其他桌面系统仍需在对应设备上确认。源码目录的 `VALIDATION.zh-CN.md` 记录完成的检查和待验收项。样本照片不包含在安装包中；运行样本测试时，需在源码根目录保留本次使用的 `motion (2).jpg`。

设置接入依据思源 [3.8.5 的 Plugin 接口](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/plugin/index.ts)和 [Dialog 实现](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/dialog/index.ts)。

原生导出接入依据思源 [3.8.5 的 saveExportFile 实现](https://github.com/siyuan-note/siyuan/blob/v3.8.5/app/src/protyle/util/compatibility.ts)、[内核文件 API](https://github.com/siyuan-note/siyuan/blob/v3.8.5/kernel/api/file.go)及 [Android 3.8.5 的 openExternal 实现](https://github.com/siyuan-note/siyuan-android/blob/v3.8.5/app/src/main/java/org/b3log/siyuan/JSAndroid.java)。
