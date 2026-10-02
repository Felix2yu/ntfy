# ntfy 项目指令

前端位于 `web/`：React + MUI + Vite 8 + PWA（workbox），后端为 Go + chi + GORM，前端经 `go:embed` 打进单文件二进制。

## 包管理器（强制）

本项目前端统一使用 **pnpm 12.8.1**，不使用 npm / yarn：

- `web/package.json` 已声明 `"packageManager": "pnpm@12.8.1"`，锁文件为 `web/pnpm-lock.yaml`
- CI（`.github/workflows/docker.yaml`）与 Docker 构建（`Dockerfile-build`）同样锁定 `pnpm@12.8.1`
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
