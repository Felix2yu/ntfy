# ntfy 项目指令

前端位于 `web/`：React + MUI + Vite 8 + PWA（workbox），后端为 Go + chi + GORM，前端经 `go:embed` 打进单文件二进制。

## 包管理器（强制）

本项目前端统一使用 **pnpm 11.28.3**，不使用 npm / yarn：

- `web/package.json` 已声明 `"packageManager": "pnpm@11.28.3"`，锁文件为 `web/pnpm-lock.yaml`
- CI（`.github/workflows/docker.yaml`）与 Docker 构建（`Dockerfile-build`）同样锁定 `pnpm@11.28.3`
- 安装依赖：`pnpm install`
- 添加 / 移除依赖：`pnpm add <pkg>` / `pnpm remove <pkg>`
- 运行脚本：`pnpm run <script>`
- **禁止使用 `npm install` / `npm ci` / `npm run` / `npx` 安装依赖或运行脚本**——锁文件是 pnpm 格式，
  npm 会生成 `package-lock.json` 并破坏 pnpm 的依赖树结构，还会让 CI 与本地构建结果不一致。

## 开发命令（均在 `web/` 下执行）

| 命令 | 说明 |
|------|------|
| `pnpm start` | 启动 Vite 开发服务器（带 source-map） |
| `pnpm build` | 构建前端产物 |
| `pnpm serve` | 预览构建产物 |
| `pnpm lint` | ESLint 检查 `src/` |
| `pnpm format` | Prettier 格式化 |
| `pnpm format:check` | Prettier 检查 |
| `pnpm test` | 运行 Vitest |

## 上游合并流程（强制）

fork 的 `main` **必须保留上游提交历史**。PR 合并时一律用 **Create a merge commit**，
禁止 Squash / Rebase：一旦 squash，`main` 与上游的最近共同祖先会退回到好几个版本之前，
下次合并时三方合并的 base 失真，会产出大量伪冲突，甚至把同一段代码插入两次
（曾导致 `server/server_test.go` 出现重复的 `TestServer_PublishAttachmentWithEmail`）。

每次合并上游的步骤：

1. `git fetch upstream --tags`
2. `git switch main && git pull --ff-only`
3. `git switch -c merge/upstream-vX.Y.Z`
4. `git merge vX.Y.Z`（不要加 `--squash`）
5. 解决冲突：逐个按内容判断，**不要盲目 `--ours`/`--theirs`**。取舍原则见下
6. 验证：`go build ./...`、`go vet ./...`、`go test ./...`、`gofmt -l .`，
   以及 `web/` 下的 `pnpm lint`、`pnpm test`、`pnpm format:check`、`pnpm build`
7. 推送 `merge/upstream-vX.Y.Z` 并开 PR 到 `main`
8. **合并该 PR 时选择 "Create a merge commit"**（`gh pr merge <n> --merge`）

冲突取舍原则：

- 双方都改同一处时，保留 fork 定制 + 采纳上游改动，而不是二选一
- 有意排除的上游内容：Playwright e2e（`web/e2e`、`playwright.config.js`、`@playwright/test`、
  `make web-e2e` 及其文档）与 `web/package-lock.json`（fork 用 pnpm）
- 上游测试若断言了 fork 已改掉的行为（默认 `CacheDuration=0`、`since="12h"`、
  `addNotifications` 写 `new: 0`、只保留 en/zh_Hans 语言包），改测试去适配 fork，
  不要反过来改 fork 行为
- fork 专属测试放 `*.fork.test.js`，让上游的测试文件保持原样，后续才能自动合并
- `web/eslint.config.mjs` 中 `import/ignore: ["react-router-dom"]` 与 `no-alert`/`no-new`
  是 fork 必须保留的调整，上游文件里没有
