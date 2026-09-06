# AgentRouter Desktop 下载

AgentRouter 桌面客户端：登录 AgentRouter 或绑定 API 密钥，选择模型后使用 AI。
安装包内置 Codex 执行环境，无须另外安装 Node.js 或 Codex。

## 下载与安装

**[下载 Windows x64 内测版 0.1.0-beta.3](https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v0.1.0-beta.3/AgentRouter-0.1.0-beta.3-x64-Setup.exe)**
｜[版本说明与校验文件](https://github.com/Maybank01/agentrouter-desktop-releases/releases/tag/v0.1.0-beta.3)

beta.3 支持关闭登录引导、稍后登录和未登录更新，并修复升级后重新进入上游
初始化向导的问题。beta.2 已撤回并保留原资产，不覆盖已有版本。
如果已经安装 beta.2 且卡在上游向导，请关闭客户端后使用 beta.3 安装器覆盖安装，
不要为此填写 DeepSeek 密钥，也不需要删除个人数据。

当前连接 **V3 测试站**，尚未切换正式站；AI 请求需要该站账户有对应模型权限
和可用额度。客户端持续更新与正式站切换分别进行。

前往 [Releases 下载页面](https://github.com/Maybank01/agentrouter-desktop-releases/releases)，
选择 Windows x64 版本中的 `AgentRouter-<版本>-x64-Setup.exe`。
当前仅提供 Beta 内测版，不提供 macOS、Linux 或 Windows ARM64 专用安装包。

Beta **尚未进行代码签名**，Windows 可能显示未知发布者或安全提示。
请确认下载来源并核对同一 Release 的 `SHA256SUMS.txt`；校验值不等同于代码签名。
不要关闭系统安全防护来安装。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AgentRouter-0.1.0-beta.3-x64-Setup.exe'
```

## 数据与更新

- 客户端数据位于 `%APPDATA%/AgentRouter/`，Codex 使用独立 Home，
  不自动导入或修改个人 `.codex` 配置、登录信息和 Skills。
- 登录凭据经 Windows 系统加密后保存；本版本不提供额外的 Skills 管理。
- 客户端只检查本仓库的更新，下载和退出安装均需用户确认。
- beta.1 若被登录弹窗挡住，可从系统托盘菜单选择“检查 AgentRouter 更新”。
- beta.3 可以直接关闭登录引导后使用主界面的更新入口；检查更新不需要 API 密钥。
- 本仓库是独立的新下载通道，不迁移或覆盖旧 AgentRouter for DSH 下载通道。

## 关于本仓库

这里只存放下载说明、版本记录和发布资产，不存放客户端的源码开发工作区。
每个版本提供安装器、更新 blockmap、更新元数据、构建验收记录及 SHA-256 校验值。
安装包保留上游和第三方许可证及声明。

beta.3 已进行构建、无头产品测试、临时 Windows 环境全新安装，以及公开
beta.1 → beta.3 的真实未登录更新、安装、重启和 Profile 保留验收。
自动验收对安装器使用静默模式，由测试驱动重启；AI 检查使用本地测试网关。
不代表全部模型、真实账户 AI 回复、人工安装界面或所有 Windows 策略均已验证。
反馈问题时请附版本号和复现步骤，**不要上传 API 密钥、登录凭据或个人配置**。
