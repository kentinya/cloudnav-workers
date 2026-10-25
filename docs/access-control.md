# 公开首页、私密分类与管理员编辑

首页始终允许访客浏览、搜索和访问公开书签。管理员密码继续使用 Worker 的 `PASSWORD` Secret；分类密码在分类管理中独立设置。

## 使用方法

1. 管理员登录后打开“分类管理”，新增或编辑分类，选择“公开”或“私密”。
2. 私密分类必须设置独立分类密码。编辑已有私密分类时，密码留空表示保留原密码；改为公开会移除分类密码。
3. 访客点击私密分类，在原有密码弹窗中输入该分类密码。Worker 验证成功后才返回相应书签。
4. 私密父分类的公开子分类继承父分类的限制；私密子分类还需要验证自己的密码。
5. 管理员登录后可以编辑全部书签、分类和设置。退出后，只显示公开内容和该浏览器此前单独解锁的分类。

分类授权使用独立的 HttpOnly Cookie，有效期一小时，不能用于管理员写操作。修改分类密码后，旧分类授权不再匹配新密码版本。
新密码以加盐 PBKDF2 校验值保存到 KV。旧版分类的 `password` 自动按私密分类处理，在管理员下次保存时转换成校验值。
管理员备份可保留密码校验值，方便恢复；访客接口不返回明文密码或校验值。

## 数据边界

- `/api/storage?getConfig=true`、`getConfig=links` 和按分类读取统一检查授权，`readOnly=false` 不会绕过验证。
- 搜索和置顶继续使用原有前端逻辑，输入数据仅包含服务端允许访问的书签。
- 任意 KV Key 读取、写入、WebDAV 备份，以及上传、图标迁移和调试接口均需要管理员身份。
- 私密书签的自定义图标及域名缓存同样检查分类权限。
- API 响应设置 `Cache-Control: private, no-store`；本地导航缓存只保存公开书签，不保存分类密码草稿、密码校验值或私密子分类书签。进入页面时先从服务端确认当前可见数据，避免展示旧的管理员缓存。
- 私密分类的名称及锁定状态仍公开展示，方便访客点击解锁。

访问级别、密码和书签的跨地区同步遵循 [Cloudflare Workers KV 一致性机制](https://developers.cloudflare.com/kv/concepts/how-kv-works/)，不保证修改后所有地区立即一致。本次沿用现有 Workers + KV 架构。

## 修改文件

| 文件 | 修改内容 |
| --- | --- |
| `worker/api/_access.js`（新增） | 分类权限、密码校验值、分类授权和图标访问检查 |
| `worker/api/category-auth.js`（新增） | Worker 验证分类密码，签发分类授权 Cookie |
| `worker/api/storage.js` | 过滤私密书签、分类密码脱敏、管理员配置读写 |
| `worker/api/auth.js`、`worker/api/_kvAdapter.js` | 管理员会话 Cookie、退出撤销及认证检查 |
| `worker/api/link.js`、`upload.js`、`migrate-icons.js`、`debug.js`、`webdav.js` | 沿用管理员认证，补齐同一会话的认证入口和备份权限 |
| `worker/api/favicon.js` | 图标读取权限检查 |
| `worker/index.js` | 分类认证路由及 API 禁止缓存响应头 |
| `types.ts` | 分类可见性、锁定状态和管理员备份校验值类型 |
| `components/CategoryManagerModal.tsx` | 公开/私密选项、密码设置和保存错误提示 |
| `components/CategoryAuthModal.tsx` | 复用密码弹窗，改为等待服务端验证 |
| `src/contexts/AuthContext.tsx` | 启动时验证管理员会话，退出时撤销会话 |
| `src/contexts/CategoriesContext.tsx` | 获取分类授权后重新读取服务端数据，分类保存不覆盖书签 |
| `src/contexts/LinksContext.tsx`、`src/hooks/useDataSync.ts` | 身份变化时清理旧数据，按身份重新加载并防止过期请求覆盖结果 |
| `src/utils/navigationCache.ts`（新增） | 仅缓存公开书签和不含密码的分类元数据 |
| `src/components/layout/AppLayout.tsx`、`Sidebar.tsx`、`MainContent.tsx` | 管理入口限制及私密分类解锁回调 |
| `src/components/category/CategorySection.tsx` | 使用原版样式显示私密分类的解锁入口 |
| `components/SettingsModal.tsx`、`BackupModal.tsx`、`services/webDavService.ts` | 设置和备份请求携带管理员身份 |
| `worker/index.test.js` | 公开读取、分类隔离、密码变更、备份恢复、图标和管理员退出回归测试 |
| `README.md`、`docs/access-control.md` | 功能入口、修改文件清单和验收步骤 |

没有新增依赖，也没有修改部署方式或替换页面布局。

## 测试方法

自动化验证：

```sh
pnpm test:worker
pnpm deploy:dry-run
```

`test:worker` 包含 23 项测试；`deploy:dry-run` 只进行本地生产构建和 Worker 打包。

浏览器验收：

1. 启动 `pnpm dev:worker`，用管理员密码登录，准备一个公开分类和两个使用不同密码的私密分类。分别添加书签，并将其中一个私密书签置顶。
2. 使用无痕窗口访问首页：公开书签可浏览，私密书签不出现在置顶或搜索结果中。
3. 在开发者工具 Network 中检查 `getConfig=true`、`getConfig=links`、`getConfig=categories`：无私密书签、明文分类密码或密码校验值。尝试 `readOnly=false` 和 `?key=links:<私密分类ID>`，仍不能获取私密书签。
4. 点击第一个私密分类：错误密码被拒绝，正确密码只解锁该分类；第二个私密分类仍锁定。分类密码不能用于添加、修改、删除书签或分类。
5. 管理员登录后检查新增、编辑、删除及设置入口。编辑私密分类时密码留空仍可用；修改密码后，原分类授权失效。
6. 管理员退出后，未单独解锁的私密书签立即从页面、搜索和置顶中消失。刷新页面后不应从旧本地缓存恢复私密书签。
7. 如有父子分类，验证私密父分类不能通过公开子分类绕过；如使用图标上传和备份，再验证图标访问及管理员备份恢复。

项目原有的 React 类型声明、搜索类型及本地 Vite 配置等类型检查错误仍需单独处理，不属于本次权限修改。
