# iOS Actions 与 GitHub Release

本配置不会立即发布版本，也不会在每次 main 更新时创建正式 Release。

## 触发与权限

| 触发 | 构建 | GitHub Release |
| --- | --- | --- |
| push 到 `main` | 自动构建，上传 Actions artifact | 不创建 |
| push 有效的 `v*` tag | 自动构建 | 成功后创建/更新该 tag 的 Release |
| workflow_dispatch，无 `release_tag` | 构建所选 ref | 不创建 |
| workflow_dispatch，填写 `release_tag` | 构建所选 ref | 仅当现有 tag 的 commit 等于所选 workflow SHA 时发布 |
| PR | 此 workflow 不触发 | 不发布 |

顶层 token 为 `contents: read`。只有独立 `publish` job 获得 `contents: write`，并且必须等待 build 成功。构建不持有发布权限，checkout 不保存 token credentials。发布使用当前运行的 artifact，不能选择任意其他 run 的 IPA。

发布目标来自 `GITHUB_REPOSITORY`，即运行 workflow 的当前仓库，不硬编码上游 `gyc-12/Cymusic`。检查更新入口需要使用同一仓库并对齐下面的 tag 规则。

环境版本不变：macOS 26、Xcode 26.6、Node 24.19.0、Yarn 1.22.22、CocoaPods 1.16.2；继续 frozen Yarn 与 `pod install --deployment`。

## Tag 与应用版本

接受以下严格格式（数字无前导零）：

- `v1.2.1`：正式版；必须与实际构建 `.app/Info.plist` 的 `CFBundleShortVersionString` 一致。
- `v1.2.1-build2`：正式版，并要求实际 `CFBundleVersion` 为 `2`。
- `v1.2.1-rc.1`、`v1.2.1-build2-beta.3`、`v1.2.1-alpha.1`：预发布，自动设置 `prerelease=true`。
- 只有 `alpha.N`、`beta.N`、`rc.N` 被视为预发布，N 和 build 必须为正整数。任意其他 suffix、空格、换行、路径、shell 字符、`+metadata` 均拒绝。

本流程不修改版本号。先更新应用/native 版本和详细 CHANGELOG，再由维护者自行创建、推送 tag。推荐显式 `-buildN`，例如 `v1.2.1-build2`；同一个 tag 不用于另一份 IPA。

manual 的 `release_tag` 必须已经存在，并解析到所选 workflow 的同一 commit（支持 annotated tag）。选择 main 而 tag 指向旧 commit 时会失败；应选择对应 tag/ref。输入通过 `env` 传递给 Node，所有 git/gh 调用使用参数数组，没有 shell 拼接。流程不会自动创建 tag。

## 详细 release notes：CHANGELOG.md 契约

仓库根目录的 `CHANGELOG.md` 必须包含唯一的对应 **应用版本** 章节，例如：

```markdown
## [1.2.1] - 2026-11-12

### 修复
- 详细描述本版本修复的播放问题、影响范围和验证情况。
- 详细描述封面、配置迁移、搜索或其他本版本变动。

### 安装与限制
- 列出本版本已知限制与必要操作。
```

也支持 `## 1.2.1` / `## v1.2.1` / `## [v1.2.1]`。提取直到下一个 `##`，保留 `###` 子章节。build 和预发布 tag 共用 `1.2.1` 的详细章节；不是 `[Unreleased]`、上一版或自动生成的提交列表。正文至少 80 个字符和两行非空内容；缺失、重复、空章节会在构建前失败。

Release 正文追加实际 app/build 版本、commit SHA、IPA 文件名、校验命令、unsigned 提示及机器身份标记。不要删改 `<!-- cymusic-release:TAG:SHA -->`；它用于识别重试是否对应同一提交。

## Artifact / Release 附件

每次构建的 Actions artifact 包含：

- `CyMusic-1.2.1-build2-unsigned.ipa`（文件名来源于实际构建 Info.plist）
- `SHA256SUMS`（IPA 的 SHA-256）
- `release-manifest.json`（tag、commit、app/build、文件名、校验值、预发布标志）
- 仅发布构建还包含 `release-notes.md`。

publish 下载上述 artifact，重新核对 SHA/tag/version、IPA 内容哈希、校验文件、从当前 commit CHANGELOG 重建的 notes；再通过 `gh` 检查远端 tag commit。Release 附件上传 IPA、SHA256SUMS、manifest。notes 作为 Release 正文，不使用 `--generate-notes`。

首次发布先创建 draft，上传附件成功后再公布；失败可能留下 draft。相同 tag 的发布 job 串行执行，不取消正在发布的任务。重复运行时，只允许同 commit 的身份标记，以及已存在附件的逐字节相同内容；缺少的附件可补传。**不使用 `--clobber`，不同内容直接失败，不会静默覆盖。**

如果 build 成功而 publish 失败，优先 Re-run failed jobs 复用原 artifact。重跑 build 可能产生不同 ZIP 时间戳或其他字节，即使 commit 相同也不能覆盖原 Release；需要新的 build tag。旧的手工 Release 若没有身份标记，会拒绝更新，须维护者核实后另选发布 tag。建议启用 tag ruleset，禁止已发布 tag 被移动；API 检查不能替代服务端 tag 保护。

下载后在附件目录验证：

```sh
shasum -a 256 -c SHA256SUMS
```

IPA 未签名，不等于 App Store 可安装/已签名包；LiveContainer 真机安装仍需单独验收。

## 本地检查与边界

```sh
node scripts/check-release-workflow.mjs
```

检查 YAML 触发/权限/工具版本、tag 语法、详细 notes、ref/Info.plist 输入匹配、文件名与校验、draft/upload/edit 顺序、重复 tag 的不同 commit/附件拒绝。测试使用临时假 IPA 与 git/gh mock，不创建 commit/tag/Release、不上传文件、不访问发布 API。它不代替 macOS 构建或 GitHub Actions/Release 权限的真实验收。
