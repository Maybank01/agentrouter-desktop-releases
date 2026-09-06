# AgentRouter Desktop 下载

AgentRouter 桌面客户端：登录 AgentRouter 或绑定 API 密钥，选择模型后使用 AI。
安装包内置 Codex 执行环境，无须另外安装 Node.js 或 Codex。

## 下载与安装

前往 [Releases 下载页面](https://github.com/Maybank01/agentrouter-desktop-releases/releases)，
选择 Windows x64 版本中的 `AgentRouter-<版本>-x64-Setup.exe`。
当前仅提供 Beta 内测版，不提供 macOS、Linux 或 Windows ARM64 专用安装包。

Beta **尚未进行代码签名**，Windows 可能显示未知发布者或安全提示。
请确认下载来源并核对同一 Release 的 `SHA256SUMS.txt`；校验值不等同于代码签名。
不要关闭系统安全防护来安装。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AgentRouter-0.1.0-beta.1-x64-Setup.exe'
```

## 数据与更新

- 客户端数据位于 `%APPDATA%/AgentRouter/`，Codex 使用独立 Home，
  不自动导入或修改个人 `.codex` 配置、登录信息和 Skills。
- 登录凭据经 Windows 系统加密后保存；本版本不提供额外的 Skills 管理。
- 客户端只检查本仓库的更新，下载和退出安装均需用户确认。
- 本仓库是独立的新下载通道，不迁移或覆盖旧 AgentRouter for DSH 下载通道。

## 关于本仓库

这里只存放下载说明、版本记录和发布资产，不存放客户端的源码开发工作区。
每个版本提供安装器、更新 blockmap、更新元数据、构建验收记录及 SHA-256 校验值。
安装包保留上游和第三方许可证及声明。

Beta 已进行构建、无头产品测试和临时 Windows 环境全新安装验收；
不代表全部模型、真实网关、跨版本升级或所有 Windows 策略场景均已验证。
反馈问题时请附版本号和复现步骤，**不要上传 API 密钥、登录凭据或个人配置**。
