# 本机开发环境

项目已经改为 Cloudflare Workers + Static Assets + KV + R2。

- 目录：`/Users/songzhidong/CloudNav-Worker`
- 前端热更新：<http://127.0.0.1:3000>
- 完整 Worker：<http://127.0.0.1:8788>
- 本地密码：`.dev.vars` 中的 `PASSWORD`，文件权限 600。
- 本地 KV / R2 数据：`.wrangler/state/`

## 一起启动前后端

```sh
cd /Users/songzhidong/CloudNav-Worker
./dev.local.sh
```

该本机脚本会构建前端并同时启动 Wrangler 和 Vite，Ctrl+C 停止。
`dev.local.sh` 和 `vite.local.config.ts` 仅在本机保留，由 `.git/info/exclude` 排除。

## 仓库标准命令

```sh
pnpm dev:worker       # 构建前端并启动完整 Worker
pnpm dev              # 第二个终端：Vite 热更新，API 代理到 Worker
pnpm test:worker      # 8 项 Worker 测试
pnpm deploy:dry-run   # 本地构建和打包，不部署
```

页面和静态资源、API 404、八个 API 的预检、登录、KV 读写、R2 上传/读取/删除及 Vite API 代理均已在本地 Workers 运行时验证。
尚未创建云端资源或部署。原仓库已有的类型检查错误和 ESLint 配置不兼容问题仍保留。

正式部署与资源创建请参阅 [Workers 部署说明](docs/workers.md)。
