# Desktop 适配器 CI

私有 `Maybank01/agentrouter-desktop` 是适配器源码仓库；本公共发行仓库的
`.github/workflows/ci.yml` 独立运行 Desktop 适配器 CI。公共标准 Ubuntu/Windows
运行器不使用私有仓库的 Actions 分钟额度。私有仓库调用公共 reusable workflow
仍按私有调用方计费，因此不保留这种转发器。

## 从源码到验证

1. 在私有源码仓库的隔离工作树运行 `npm test` 和 `git diff --check`。
   原生实现变更还要按 `assembly/coordinated/README.md` 做相应本地验证。
2. 代码审阅合并后，从干净的当前 main 运行：

   ```text
   node assembly/coordinated/export-release-adapter.mjs <本公共发行仓库的隔离工作树>
   ```

   导出器只复制 allow-list 中的已提交 Git 字节，生成
   `assembly/coordinated/adapter-source.json`，记录私有源提交及每个文件的长度和 SHA-256。
   不复制整个私有仓库、凭据、会话、日志或未发布插件包。功能仍在源码仓库开发。
3. 在公共工作树运行 `npm ci --ignore-scripts --prefix assembly/coordinated`、
   `npm test`、`git diff --check`，提交导出结果并通过 PR 审阅。
   PR 和 main push 自动运行 CI；需要独立复验时使用：

   ```text
   gh workflow run ci.yml --repo Maybank01/agentrouter-desktop-releases --ref main
   gh run list --repo Maybank01/agentrouter-desktop-releases --workflow ci.yml --branch main
   gh run view <run-id> --repo Maybank01/agentrouter-desktop-releases
   ```

4. 确认 Ubuntu 和 Windows 两个 job 全部成功。Windows 必须完成适配器事务测试、
   pnpm store 迁移、真实 NSIS 安装、原生更新下载/重启和旧 Profile 迁移。
   已排队、运行器启动或仅边界检查通过，均不是完整验收。

CI 的 summary 记录源提交、导出清单摘要、执行仓库提交、workflow 提交、run 和 attempt；
安装验收步骤记录测试安装器摘要及迁移结果。记录验收时保留 run URL 与这些身份，
并核对导出的文件与所声称的私有源提交一致。只有文档或边界变更、适配器字节未变时，
可以保留已有导出，但必须分别报告本地边界检查与该导出的公共 CI 结果。
公共 CI 不会读取或验证未导出的私有源码。

## 凭据与产物

该 CI 只需要本公共仓库的只读 `GITHUB_TOKEN`，checkout 不持久化凭据。
不需要 Desktop 私有源码读取凭据，也不使用插件验证的 `AGENTROUTER_CI_TOKEN`。
测试安装器只使用回环 feed，留在一次性 Windows 运行器上，不上传 artifact 或 Release。
CI 结果不授权 npm 发布、正式安装器签名/发布或公开 feed 切换。

插件私有源码的公共执行器是另一个入口 `plugin-validation.yml`，沿用其私有候选存储及
受保护的 npm 发布器；不要把插件的跨仓库凭据或发布机制移入本适配器 CI。
