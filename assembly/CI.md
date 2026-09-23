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

4. 确认 run 中所有 job 全部成功：Ubuntu 源码边界，以及并行的四个 Windows job——
   适配器事务测试与 pnpm store 迁移、原生更新下载/重启、旧 Profile 迁移、
   全新安装后的运行文件/凭据恢复。任一 job 失败、跳过或取消都不构成完整验收；
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


## 2026-09-20: change-scoped checks

`ci.yml` always checks source boundaries/provenance. `assembly/ci-scope.mjs`
compares the actual PR merge-base diff or push before/after diff. Documentation,
website/public observation and private plugin execution do not require another
installation of the unchanged Desktop. Native adapter/product inputs, signing,
build code and unknown code still run Windows transactions, store migration and
installed update/legacy acceptance. Manual dispatch always runs the complete path.
A skipped Windows job means unchanged product inputs, not newly accepted bytes.

The private plugin now has Dev integration, with fast source checks per module
and a frozen Windows candidate per release batch. This repository's executor
admits a fixed commit already on private dev/main, while its own workflow and
environment remain main-only. See the private source's docs/INTEGRATION.md.

New coordinated publication compares its locked plugin with npm next before
expensive acceptance. An intentional older-plugin maintenance release supplies
retain_plugin_reason; this is retained with source/version/digest in the release
receipt. Signed recovery preserves original input without chasing a newer tag.

## Verified Dev handoff (2026-09-20)

- [Adapter CI 35498309915](https://github.com/Maybank01/agentrouter-desktop-releases/actions/runs/35498309915)
  passed source tests and complete Windows transactions, store reconciliation,
  installed native update and legacy migration for executor PR #23. The merged
  main tree is byte-identical to the tested PR tree; its duplicate Windows run
  was cancelled after confirming `git diff --exit-code` between both commits.
- [Dev execution 35499077643](https://github.com/Maybank01/agentrouter-desktop-releases/actions/runs/35499077643)
  completed in 39 seconds including startup. It admitted an immutable reviewed
  private Dev commit, checked the current DSH channel and delivered a successful
  private receipt with `sourceBranch: dev` and `sourceAuthorization: dev-ancestor`.
  DSH was unchanged, so this did not run or claim a new plugin candidate acceptance.
- Local tests cover stale-plugin detection before publication, main/dev identity,
  rejected task/PR refs and scope selection. Actual new-version signing remains
  the existing product release workflow, not a consequence of this CI change.

This follow-up is documentation only. Its CI should run source/provenance tests
and skip the unchanged installer. A 39-second unchanged-host check is not a claim
that the full signed release now meets the 600-second delivery objective.

## 2026-09-23: parallel installed scenarios

The former single Windows job (about 16.5 minutes) is split into jobs that run
in parallel on separate disposable `windows-2025` workers, all gated by the
same `ci-scope` output:

| Check name | Command |
| --- | --- |
| Adapter transactions and pnpm store migration | `npm test`, `node assembly/coordinated/test.mjs`, `store-migration-acceptance.mjs` |
| Installed native update and restart | `node assembly/coordinated-candidate.mjs --scenario=native-updater` |
| Installed legacy Profile migration | `node assembly/coordinated-candidate.mjs --scenario=legacy-migration` |
| Installed fresh install with runtime and credential recovery | `node assembly/coordinated-candidate.mjs --scenario=fresh-install-recovery` |

Each installed job builds the exact exported target itself. `native-updater`
also builds the baseline and packages both installers concurrently.
`legacy-migration` installs the target fresh, so it no longer depends on the
native update's state. `fresh-install-recovery` runs the single-install path
used by signed installed acceptance (runtime recovery, credential recovery and
external browser navigation) before any version is signed. Each receipt names
its scenario and `coordinated-candidate.mjs` rejects a receipt for another
scenario. The matrix uses `fail-fast: false`; acceptance still requires every
job to succeed. Test installers remain on each disposable worker.

`release.yml` is unchanged: it calls `coordinated-candidate.mjs` without a
scenario and keeps the full sequential native update followed by legacy
migration on the same installation, and signed native update acceptance keeps
`--signed-installer`. `assembly/ci-identity.mjs` writes the source/executor
identity summary in every Windows job. Branch protection is not configured on
main; if it is added, require the four Windows check names above plus
`Source boundaries and provenance`.
