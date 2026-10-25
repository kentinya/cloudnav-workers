# Cloudflare Workers 网页部署教程

项目使用一个 Worker 同时提供 React 静态页面和 `/api/*` 接口，书签和配置存入 Workers KV，上传图标和图标缓存存入 R2。
部署通过 Cloudflare 网页控制台完成，无需在电脑上安装开发工具。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fkentinya%2Fcloudnav-workers)

### 1. 准备账号

- 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，准备一个 GitHub 账号。
- 在 Cloudflare 的 **R2 Object Storage** 中按页面提示开通 R2。仓库声明了 R2 绑定，首次部署前需要完成开通；存储桶由部署流程创建，无需提前手动创建。

### 2. 复制仓库并设置项目

点击上方 **Deploy to Cloudflare** 按钮，选择 Cloudflare 账号，按提示授权 GitHub，并选择新仓库的名称。
该流程会把 `kentinya/cloudnav-workers` 复制到你的 GitHub 账号，后续在自己的仓库维护代码。

在部署设置页确认：

| 设置项 | 填写内容 |
| --- | --- |
| Worker 名称 | 可保留 `cloudnav-worker`；按钮流程支持修改名称并同步到复制后的配置 |
| 生产分支 | `main` |
| 根目录 | 仓库根目录，保留默认值 |
| 构建命令（Build command） | `pnpm build` |
| 部署命令（Deploy command） | `pnpm exec wrangler deploy` |

以上命令填写在网页表单中，由 Cloudflare 在云端执行。
仓库提供了 `build` 和 `deploy` 脚本，页面可能自动填写 `pnpm deploy`；按表格修改可避免重复构建。
依赖由 Workers Builds 自动安装，版本来自 `.nvmrc` / `.node-version` 的 Node.js 22 和 `package.json` 的 pnpm 11.11.0。
如果构建日志显示版本不符，在 **Settings → Build → Build Variables and Secrets** 设置 `NODE_VERSION=22`、`PNPM_VERSION=11.11.0`，保存后重新构建。

### 3. 设置管理员密码并部署

仓库中的 `.dev.vars.example` 声明了必需的 `PASSWORD`，供一键部署页面识别。
在页面的 Secret 配置中，将 `PASSWORD` 的示例值替换为你自己的管理员密码，再点击 **Deploy / Save and Deploy**。

首次部署会根据 `wrangler.jsonc` 自动创建并绑定：

- **`CLOUDNAV_KV`**：保存分类、书签、站点配置和登录 Token。
- **`CLOUDNAV_R2`**：保存上传图标及缓存图标。无需开启存储桶公开访问。
- **`ASSETS`**：提供构建生成的 `dist` 静态页面，由 Workers Static Assets 配置。

如果页面没有显示 `PASSWORD` 输入项，或部署后登录提示“服务器未配置管理员密码”，在控制台补充：

1. 打开 **Workers & Pages → 你的 Worker → Settings → Variables and Secrets**。
2. 点击 **Add**，类型选择 **Secret**，变量名填写 **`PASSWORD`**，值填写自己的管理员密码。
3. 点击 **Deploy** 使配置生效，再返回网站登录。

`PASSWORD` 是运行时 Secret；**Build Variables and Secrets** 只用于构建，填在那里不会成为网站的登录密码。

### 4. 打开网站并验证

部署成功后打开 Worker 页面显示的 `https://<worker-name>.<subdomain>.workers.dev` 地址：

1. 确认首页可以正常浏览。
2. 使用 `PASSWORD` 登录，新增一个分类和书签。
3. 刷新页面，确认数据仍然存在。
4. 在图标上传选项中选择“上传到 Cloudflare R2”，确认上传后的图标正常显示。

## 手动通过网页导入 GitHub 仓库

如果已经 Fork 本仓库，或希望直接部署自己已有的仓库，可以使用此方式。

1. 在 GitHub 网页中 [Fork 本仓库](https://github.com/kentinya/cloudnav-workers/fork)。仓库所有者也可以直接选择 `kentinya/cloudnav-workers`。
2. 打开 Cloudflare 的 **Workers & Pages → Create application → GitHub**，按提示授权并选择仓库，创建 Workers 项目。
3. 使用上表中的根目录、构建命令和部署命令。Worker 名称填写 `cloudnav-worker`，与仓库 `wrangler.jsonc` 的 `name` 保持一致；如需改名，先在 GitHub 网页编辑该文件并提交。
4. 点击 **Save and Deploy**，等待构建和资源创建完成。
5. 按上文步骤在 Worker 的 **Settings → Variables and Secrets** 中添加运行时 Secret `PASSWORD`，点击 **Deploy**，然后验证网站。

手动导入使用同一份资源配置，首次部署也会自动创建 KV/R2。后续对这个 Worker 的部署会复用已有绑定，无需每次创建资源。

## 后续更新与自定义域名

部署流程会配置 Workers Builds。向连接的生产分支 `main` 提交代码后，Cloudflare 会自动构建并部署；一键部署复制出的仓库需要自行同步上游更新。
在 Worker 的 **Settings → Build** 中可以查看和修改连接仓库、分支及构建配置，在 **Deployments** 中查看部署状态和构建日志。

绑定域名：进入 Worker 的 **Settings → Domains & Routes → Add → Custom Domain**，输入 Cloudflare 账号中已托管的域名并按页面提示完成。

## 绑定与环境变量

| 名称 | 类型 | 用途及设置位置 |
| --- | --- | --- |
| `ASSETS` | 静态资源绑定 | 由 `wrangler.jsonc` 的 `assets` 自动配置 |
| `CLOUDNAV_KV` | KV 绑定 | 保存书签等数据，部署时自动创建；在 Worker 的 Bindings 中检查 |
| `CLOUDNAV_R2` | R2 绑定 | 保存图标，部署时自动创建；在 Worker 的 Bindings 中检查 |
| `PASSWORD` | 运行时 Secret（必填） | 一键部署时填写，或在 Settings → Variables and Secrets 中添加 |
| `ALLOWED_ORIGIN` | 可选普通变量 | 跨域来源限制，默认 `*`；需要限制时，在自己的仓库 `wrangler.jsonc` 的 `vars` 中添加 |

普通变量建议保存在自己仓库的 `wrangler.jsonc` 中，避免后续 Git 部署覆盖仅在控制台添加的普通变量。通过控制台设置的 Secret 会在后续部署中保留。
AI、天气和 WebDAV 等可选功能在网站的应用设置中配置。
旧版 JSON / WebDAV 备份中内嵌的图标文件统一恢复到 R2，已有的外部图标 URL 会保留。

如需复用已有资源，可在 GitHub 网页编辑 `wrangler.jsonc`：为 `kv_namespaces` 的对应项添加 `id`，为 `r2_buckets` 的对应项添加 `bucket_name`，然后提交触发部署。

## 常见问题

- **找不到 GitHub 仓库**：检查 Cloudflare 的 GitHub 授权是否包含该仓库，再回到创建页面刷新。
- **提示 Worker 名称不匹配**：手动导入时，控制台项目名称必须和 `wrangler.jsonc` 的 `name` 一致。
- **R2 创建失败**：先在账号中完成 R2 开通，再在部署页面重试；如日志提示权限不足，检查 Settings → Build 中构建 API Token 对 KV/R2 的权限。
- **提示找不到 `dist`**：确认构建命令是 `pnpm build`，根目录是仓库根目录，并检查构建日志是否成功。
- **登录提示未配置密码**：在 Worker 的运行时 Variables and Secrets 中添加 Secret `PASSWORD` 并点击 Deploy。
- **页面更新后书签丢失**：检查是否换了 Worker 或绑定了新的 KV。保留原来的 `CLOUDNAV_KV`，不要为了更新代码删除存储资源。

## 本地开发（可选）

本节仅供修改代码时使用。使用 Node.js 22 和 pnpm 11：

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置本地 PASSWORD。
pnpm dev:worker
```

打开 <http://127.0.0.1:8788>，可使用完整页面、登录、书签管理及本地图标存储。
KV 和 R2 在本地模拟，无需登录 Cloudflare；数据保存在 `.wrangler/state/`，不会写入线上资源。
`.dev.vars` 仅供本地使用，不会随部署上传。

需要前端热更新时，保持 `pnpm dev:worker` 运行，在另一个终端执行 `pnpm dev`，然后打开 <http://localhost:3000>。
Vite 将 `/api` 代理到 8788；8788 的页面来自 `dist`，修改前端后需重新构建。
已有 `dist` 时，可以用 `pnpm dev:api` 直接启动后端。

```sh
pnpm test:worker      # API、KV/R2、静态资源及旧版图标备份兼容性测试
pnpm deploy:dry-run   # 本地生产构建与 Worker 打包，不上传或创建云端资源
```

仓库已有 `pnpm type-check` 类型错误，以及 ESLint 9 不兼容 `.eslintrc.json` 的问题。

## 路由说明

- API 处理代码位于 `worker/api/`，由 `worker/index.js` 显式映射路由。
- `/api/auth`、`/api/storage`、`/api/link`、`/api/favicon`、`/api/upload`、`/api/migrate-icons`、`/api/webdav`、`/api/debug` 交给 Worker。
- 未定义的 `/api/*` 路径返回 JSON 404。
- 其他请求使用 Workers Static Assets；页面导航支持单页应用回退。

参考：[官方一键部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers Git 部署](https://developers.cloudflare.com/workers/ci-cd/builds/)、[构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[构建环境版本](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)、[运行时 Secret](https://developers.cloudflare.com/workers/configuration/secrets/)、[自动创建 KV/R2](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)。
