# AgentRouter Desktop 下载

> 2026-09-08 仓库整理说明：本仓库继续只承载下载说明和二进制资产。
> 下一条客户端构建线是“原版 DSH Desktop + 预装公开 npm 插件”，功能更新由
> 通用 DSH 插件提供。该预装候选尚未公开发布，**当前下载仍是下述 beta.5**；
> 不代表旧版已经迁移，也没有切换现有安装器或组件更新源。

AgentRouter 桌面客户端：登录 AgentRouter 或绑定 API 密钥，选择模型后使用 AI。
安装包内置 Codex 执行环境，无须另外安装 Node.js 或 Codex。

## 下载与安装

**[下载 Windows x64 内测版 0.1.0-beta.5](https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v0.1.0-beta.5/AgentRouter-0.1.0-beta.5-x64-Setup.exe)**
｜[版本说明与校验文件](https://github.com/Maybank01/agentrouter-desktop-releases/releases/tag/v0.1.0-beta.5)

安装包约 **265 MB**。beta.5 把更新提示改成客户端内的独立界面插件，可显示
下载进度、关闭面板后后台下载、稍后重启。新版发起安装时使用静默覆盖，
保留原目录和安装范围，并请求安装后自动打开客户端；AI 执行期间禁止重启更新。
本次不升级 Codex、DSH 或 Electron，继续支持未登录更新和按需组件下载。
**从旧版升级到 beta.5 时，仍可能最后显示一次旧提示和安装向导。**
新流程从 beta.5 生效，无须为更新额外登录或填写 API 密钥。
beta.2 已撤回并保留原资产，不覆盖已有版本。
如果已经安装 beta.2 且卡在上游向导，请关闭客户端后使用 beta.5 安装器覆盖安装，
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
Get-FileHash -Algorithm SHA256 -LiteralPath '.\AgentRouter-0.1.0-beta.5-x64-Setup.exe'
```

## 数据与更新

- 客户端数据位于 `%APPDATA%/AgentRouter/`，Codex 使用独立 Home，
  不自动导入或修改个人 `.codex` 配置、登录信息和 Skills。
- 登录凭据经 Windows 系统加密后保存；本版本不提供额外的 Skills 管理。
- 客户端只检查本仓库的更新，下载和退出安装均需用户确认。
- beta.5 的更新界面可作为组件单独更新；新增组件 ABI 2 使用独立入口，
  保留 beta.4 的 ABI 1 入口，不向旧客户端发送不兼容清单。
- 从 beta.4 开始，插件只下载改变的插件包，Codex 只下载相应原生内核包，
  不连带更新 Electron 或其他未变化组件；重启生效，启动失败可回退。
- 客户端壳变化时使用安装包更新并尝试差分下载。首次升级到 beta.4 仍可能
  下载整包，之后才能复用修正后的安装器缓存；检查版本清单不等于下载组件。
- beta.1 若被登录弹窗挡住，可从系统托盘菜单选择“检查 AgentRouter 更新”。
- beta.3 及后续版本可关闭登录引导后使用主界面的更新入口；检查更新不需要 API 密钥。
- 本仓库是独立的新下载通道，不迁移或覆盖旧 AgentRouter for DSH 下载通道。

## 关于本仓库

这里只存放下载说明、版本记录和发布资产，不存放客户端的源码开发工作区。
每个版本提供安装器、更新 blockmap、更新元数据、构建验收记录及 SHA-256 校验值。
安装包保留上游和第三方许可证及声明。
标为“组件存储（非安装包）”的 Release 仅供客户端自动读取；请勿将其中的
`.tgz` 作为安装器下载。组件仍须经过兼容性测试后显式发布，不追随上游 latest。

beta.4 已进行构建、无头产品测试、临时 Windows 环境全新安装，以及公开
beta.3 → beta.4 的真实未登录更新、安装、重启和 Profile 保留验收。
独立组件 CI 已在公开安装包上通过原生 Codex 和桌面检查；首次组件清单与
安装包内置版本一致，不会要求已安装 beta.4 的用户重复下载相同内容。
自动验收对安装器使用静默模式，由测试驱动重启；AI 检查使用本地测试网关。
beta.5 已通过干净构建、真实桌面隐藏窗口测试，以及当前用户／所有用户安装的
真实静默覆盖、目录和安装范围保留验收。更新提示未使用原生消息弹窗。
公开 beta.4 → beta.5 更新实际传输了约 **2.02 MB** 安装器差分数据（另有元数据），
并验证了校验值、Profile 保留和新版运行。该旧版兼容测试仍由驱动控制重启。
beta.5 的 ABI 2 组件入口已启用，首个清单与内置组件一致；原生运行环境和桌面
均已验证，无须重复下载相同组件。原有 beta.4 组件入口保持不变。
可见窗口的真实自动重启仍是单独的待执行验收，不与安装参数检查混为一谈。
不代表全部模型、真实账户 AI 回复、人工安装界面或所有 Windows 策略均已验证。
反馈问题时请附版本号和复现步骤，**不要上传 API 密钥、登录凭据或个人配置**。
