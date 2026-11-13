# 桌面形态（PWA + 托盘启动器）

DSH 驾驶舱有三种桌面用法，按侵入性从低到高：

## 1. PWA 安装（推荐，零依赖）

把仪表盘"安装"成独立窗口应用（无地址栏、有任务栏/开始菜单图标）：

1. 启动服务：`node src/cli.mjs serve --port 7777`
2. 用 **Edge 或 Chrome** 打开 <http://127.0.0.1:7777/>
3. 地址栏右侧出现 **安装图标**（或菜单 → 应用 → 安装此站点）
4. 安装后从开始菜单/桌面打开即独立窗口；支持"今日/近 7 天"快捷方式

依赖：`web/manifest.webmanifest` + `web/sw.js` + `web/icons/*`（已内置）。

## 2. 系统托盘启动器（Windows）

双击 `desktop/启动驾驶舱.bat`：

- 常驻托盘图标，自动启动 7777 服务；
- 双击图标 → 以 app 窗口打开（Edge/Chrome `--app`）；
- 右键菜单：打开驾驶舱 / 启动网关(7891) / 重启服务 / 退出。

> 第一次运行若被 SmartScreen 拦，选择"仍要运行"（脚本未签名）。

## 3. Windows 桌面程序（已交付，推荐）

产物：`desktop/DSH-Cockpit-App/DSH-Cockpit.exe`（C# WinForms + WebView2），桌面快捷方式 **DSH 驾驶舱**。

- 双击：自动检测/启动 127.0.0.1:7777 服务 → 打开独立窗口（无地址栏）；退出时停止自己拉起的服务；
- 托盘：打开 / 启动网关(7891) / 退出；
- 依赖：.NET 9 Desktop Runtime + WebView2 Runtime（本机已有）；
- 重新构建：`cd desktop\DSHCockpit; dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=false -o ..\DSH-Cockpit-App`。

## 4. 其他安装包（Electron / Tauri，需要构建工具链）

当前环境检查：

| 工具 | 状态 | 用途 |
|---|---|---|
| Node/npm | ✅ | Electron 方案 |
| dotnet | ✅ | 可做 WebView2 壳（C# WinForms） |
| Rust/cargo | ❌ 未装 | Tauri 方案需先装 Rust |

**Electron 方案（推荐若要 .exe 安装包）**：

```powershell
npm create @quick-start/electron@latest cockpit-desktop -- --template react
# 或最小方案：npm i -D electron electron-builder
```

把窗口指向 `http://127.0.0.1:7777`，并随应用启动 `node src/cli.mjs serve` 子进程；`electron-builder` 产出 NSIS 安装包。体积约 100–150MB（Electron 运行时）。

**Tauri 方案**：体积小（~5MB），但需安装 Rust + MSVC Build Tools + WebView2（Win11 自带），首次构建约 10–20 分钟。

## 建议

- 自用：**PWA + 托盘启动器**（零依赖、5 分钟可用）；
- 分发给别人：再上 Electron/Tauri 安装包（需要签名/公证，另配 CI）。

## SmartScreen / 代码签名（Windows）

未签名的 `DSH-Cockpit.exe` 可能触发「Windows 已保护你的电脑」。已内置本地签名方案：

- 证书：`CN=DSH Cockpit (Local)`（自签名，RSA-3072/SHA-256，10 年）；
- 信任：已导入 **当前用户** 的「受信任的根证书颁发机构」与「受信任的发布者」；
- 签名脚本：`desktop/sign-app.ps1`（**每次重新 dotnet publish 后运行一次**）；
- 效果：本机运行不再显示「未知发布者」；exe 属性→数字签名可见发布者。

> 注意：自签名只在本机受信任。分发给他人需要正式代码签名证书（OV/EV），并可申请 SmartScreen 信誉。

## 小鲸鱼融合形态（v0.17+）

- **主窗口最小化 → 小鲸鱼挂件**：340×236 无边框圆角、置顶、可拖拽、贴边吸附、位置记忆；
- **双击挂件 / 双击鲸鱼 → 展开驾驶舱**；右键菜单：打开驾驶舱 / 刷新数据 / 退出程序；
- **挂件内容**：官方余额（滚动数字）、今日已用、峰谷状态、每轮消耗气泡（检测今日 token 增量触发）；
- **托盘**：鲸鱼图标，双击恢复主窗口；
- **图标**：exe / 桌面快捷方式 / PWA / 托盘均使用插件同款鲸鱼头像（素材授权见 `web/assets/whale/NOTICE.md`）；
- **DSH 插件**：同一服务器提供 `/dsh-cockpit/widget.html` 挂件页；
- 重新构建后：`desktop\sign-app.ps1` 重新签名（本地证书）。


## 大肥鱼女仆挂件（v0.18+）

- 挂件：400×300，无边框、置顶、可拖拽/吸附；双击展开驾驶舱；
- 动画：待机/张望/女仆礼/女仆舞/点击回应/思考/睡觉，随数据情绪切换；
- 情绪：余额低=担心，配额/压缩风险=紧张，每轮消耗=元气挥手+气泡，夜间=睡觉；
- 素材：web/assets/pet（署名与许可见 web/assets/pet/NOTICE.md）；
- 重建后运行 `desktop\sign-app.ps1` 重新签名。
