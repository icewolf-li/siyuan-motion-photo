# 思源动态照片

在思源笔记图片灯箱中播放小米、Redmi、Pixel 等设备拍摄的 Android Motion Photo。

正文中图片仍以普通 JPG 展示。点开支持的动态照片后，插件从 JPG 原片读取 Motion Photo/XMP 元数据和 MP4，静音自动播放一次。播放结束会回到静态照片；也可以开启声音、暂停、重播或主动导出 MP4。普通图片无需更改。照片只在用户打开灯箱后读取，插件不会改写原片。

## 使用

将 `package.zip` 解压到工作空间 `data/plugins/siyuan-motion-photo/`，再在思源「集市 → 下载 → 插件」中启用「思源动态照片」。本地调试时，也可以把源码放在该目录并运行 `pnpm run dev`。Android 移动端需要把同一个 ZIP 解压到移动端工作空间的相同插件目录，并在插件设置中启用。点开笔记中的 JPG，再用灯箱工具栏的动态照片按钮或视频控制面板切换播放。选择「导出 MP4」会在当前工作空间 `data/assets` 下保存一个 MP4 附件。

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

自动化测试包含解析器、MP4 结构校验、实际的小米样本、Range 请求、服务器不支持 Range、XMP 缺失时的容器扫描，以及中断和资源边界场景。Windows 和 Android 真机验收须在已连接对应设备的思源实例中完成。
