# Cloudflare Workers 部署

项目使用一个 Worker 同时提供 React 静态页面和 `/api/*` 接口，数据存入 Workers KV，上传图标和图标缓存存入 R2。
`worker/index.js` 复用 `functions/api/` 的业务逻辑，不需要部署 Pages 项目。

## 本地开发

使用 Node.js 22 和 pnpm 11。`.nvmrc`、`.node-version` 和 `packageManager` 已声明版本。

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置本地 PASSWORD。
pnpm dev:worker
```

打开 <http://127.0.0.1:8788>，可使用完整页面、登录、书签管理及本地图标存储。
KV 和 R2 在本地模拟，无需登录 Cloudflare；数据保存在 `.wrangler/state/`，不会写入线上资源。
`.dev.vars` 仅供本地使用，不会随部署上传。

需要前端热更新时，保持 `pnpm dev:worker` 运行，再在第二个终端执行：

```sh
pnpm dev
```

打开 <http://localhost:3000>，Vite 将 `/api` 代理到 8788。
Worker 和 Functions 修改由 Wrangler 监听；前端源码由 Vite 热更新。
8788 的页面来自 `dist`，修改前端后需要 `pnpm build` 才能更新该页面。
已有 `dist` 时，可以用 `pnpm dev:api` 直接启动后端。

## 首次部署

1. 在 `wrangler.jsonc` 中设置 Worker 名称，默认是 `cloudnav-worker`。
2. 登录 Cloudflare，并设置线上管理员密码：

   ```sh
   pnpm exec wrangler login
   pnpm exec wrangler secret put PASSWORD
   ```

   首次设置 Secret 时，如果提示创建 Worker，按提示创建同名 Worker。
   线上密码通过 Secret 配置，与 `.dev.vars` 的本地密码独立。

3. 如果使用图标上传和缓存，在 Cloudflare 控制台开通 R2。
4. 检查打包结果，再执行部署：

   ```sh
   pnpm test:worker
   pnpm deploy:dry-run
   pnpm deploy
   ```

   `deploy:dry-run` 仅在本地构建和打包，不上传、不创建云端资源。
   首次 `deploy` 时，Wrangler 会为未指定资源 ID 的 `CLOUDNAV_KV` 和 `CLOUDNAV_R2` 绑定创建资源；按提示确认。
   创建后将 Wrangler 写回的资源配置保存到版本控制，后续部署复用相同数据。

5. 打开命令输出的 `workers.dev` 地址，验证访客访问、管理员登录、书签保存和图标上传。

如果使用已有资源，在 `kv_namespaces` 的对应项填写 `id`，在 `r2_buckets` 中填写 `bucket_name`。
项目尚未上线时可直接使用默认的自动创建流程，无需迁移旧数据。

## 绑定与环境变量

| 名称              | 类型         | 用途                                                             |
| ----------------- | ------------ | ---------------------------------------------------------------- |
| `ASSETS`          | 静态资源绑定 | 提供 `dist` 中的页面、JS、CSS 和图片                             |
| `CLOUDNAV_KV`     | KV 绑定      | 分类、书签、配置及登录 Token                                     |
| `CLOUDNAV_R2`     | R2 绑定      | 图标上传和缓存，存储桶不需要开启公开访问                         |
| `PASSWORD`        | Secret       | 线上管理员密码，通过 `wrangler secret put PASSWORD` 设置         |
| `UPLOAD_PLATFORM` | 普通变量     | 配置为 `cloudflare`，使用 R2                                     |
| `ALLOWED_ORIGIN`  | 可选变量     | 跨域来源限制，未设置时为 `*`；使用跨域浏览器扩展前确认允许其来源 |

上传图标时在应用中选择“上传到 Cloudflare R2”。
AI、天气和 WebDAV 等可选功能仍在应用设置中配置。

## 路由

- `/api/auth`、`/api/storage`、`/api/link`、`/api/favicon`、`/api/upload`、`/api/migrate-icons`、`/api/webdav`、`/api/debug` 交给 Worker。
- 未定义的 `/api/*` 路径返回 JSON 404，包括直接在浏览器中打开的请求。
- 其他请求使用 Workers Static Assets；页面导航支持单页应用回退。
- `public/.assetsignore` 排除 Pages 专用的 `_routes.json`，该文件不参与 Workers 路由。

## Git 自动部署

在 Cloudflare 控制台创建 Workers 项目并连接本仓库，根目录使用仓库根目录：

- 安装：`pnpm install --frozen-lockfile`
- 构建：`pnpm build`
- 部署：`pnpm exec wrangler deploy`

提前设置运行时 Secret `PASSWORD`，并确认 KV/R2 绑定已创建并写入配置。
如使用自定义域名，在部署后的 Worker 的 Settings → Domains & Routes 中绑定。

## 验证与现有问题

`pnpm test:worker` 验证 API 路由、认证、KV 读写、R2 图标上传/读取/删除、CORS 预检和静态资源转发。
`pnpm deploy:dry-run` 验证前端生产构建和 Worker 打包。

仓库迁移前已有 `pnpm type-check` 类型错误，以及 ESLint 9 不兼容 `.eslintrc.json` 的问题；本次未改动这些业务类型和 lint 配置。

参考：[Workers 静态资源](https://developers.cloudflare.com/workers/static-assets/)、[从 Pages 迁移](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)、[自动创建资源](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)。
