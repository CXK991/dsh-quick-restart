# Changelog

本插件的版本记录。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 1.0.1 — 2026-11-03

- README：安装说明改为以 npm 为主（本插件未收录进 dsh-market 社区目录，市场搜索找不到）；
  Discover 索引源改用不带版本号的地址（`.../dsh-quick-restart/index.json`）。
- 仓库补 `dsh-plugin` topic、GitHub Release v1.0.0。

## 1.0.0 — 2026-11-03

首个公开版本。

**功能**

- 侧边栏左下角（设置按钮上方）新增「重启 DSH」按钮：点一下 → 确认框 → DSH 自动关闭并重新启动。
- 确认框走 `shell.overlay` 浮层，`Esc` / 点背景 / 「取消」都可退出；重启中允许关掉浮层（POST 已发出，重启不会取消）。
- 中英双语（`locale/zh.json`、`locale/en.json`），跟随 DSH 的语言设置。
- 接口协议握手（`protocol: 2`）：插件代码更新后如果宿主还跑着旧代码，前端会**拒绝触发**并提示先手动重开一次 DSH。

**重启机制（Windows 桌面版）**

- 按**进程名**结束 DSH（不按进程树杀，避免把助手自己带走），等进程真正退出后再启动同一个 exe。
- 助手进程链：`node --(detached)--> cmd.exe --> powershell.exe`（`detached` 直起 `powershell.exe` 会静默空转）。
- 新实例用 .NET `ProcessStartInfo(UseShellExecute=false)` 启动（`Start-Process` 在无窗口站的助手里会直接失败）。
- 启动前显式移除 `ELECTRON_RUN_AS_NODE`：否则 Electron 会以 Node 模式运行、**不建窗口**，表现为"DSH 关了不回来"。
- 助手把 `--- / targets= / killed / launched` 写到 `%TEMP%\dsh-quick-restart.log`，便于排障。
- 20 秒冷却窗口防止连点；冷却过后允许重试。

**已知限制**

- 只在 Windows 桌面版自动重启；`dsh web` 命令行版有兜底逻辑但未实测。
- 重启会中断正在跑的任务（会话记录落盘）。
- 重新拉起时**不带启动参数**（当前桌面版就是空参数启动）。
- 桌面版宿主使用随机端口，重启后端口会变：桌面窗口会自己重开，浏览器里的旧标签页连不回去。
