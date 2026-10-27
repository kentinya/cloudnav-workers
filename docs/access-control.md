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

网站设置和旧数据的首次读取仍遵循 [Cloudflare Workers KV 一致性机制](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。导航首次保存后通过 R2 原子版本指针读取 KV 快照；快照暂未可见时返回 503，避免把滞后数据当作最新数据。部署继续使用已有的 Worker、KV 和 R2 绑定。

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

`test:worker` 包含 39 项测试；`deploy:dry-run` 只进行本地生产构建和 Worker 打包。

浏览器验收：

1. 启动 `pnpm dev:worker`，用管理员密码登录，准备一个公开分类和两个使用不同密码的私密分类。分别添加书签，并将其中一个私密书签置顶。
2. 使用无痕窗口访问首页：公开书签可浏览，私密书签不出现在置顶或搜索结果中。
3. 在开发者工具 Network 中检查 `getConfig=true`、`getConfig=links`、`getConfig=categories`：无私密书签、明文分类密码或密码校验值。尝试 `readOnly=false` 和 `?key=links:<私密分类ID>`，仍不能获取私密书签。
4. 点击第一个私密分类：错误密码被拒绝，正确密码只解锁该分类；第二个私密分类仍锁定。分类密码不能用于添加、修改、删除书签或分类。
5. 管理员登录后检查新增、编辑、删除及设置入口。编辑私密分类时密码留空仍可用；修改密码后，原分类授权失效。
6. 管理员退出后，未单独解锁的私密书签立即从页面、搜索和置顶中消失。刷新页面后不应从旧本地缓存恢复私密书签。
7. 如有父子分类，验证私密父分类不能通过公开子分类绕过；如使用图标上传和备份，再验证图标访问及管理员备份恢复。

React 类型声明、搜索类型及本地 Vite 配置的类型检查问题已修复，可运行 `pnpm type-check` 检查。


## 登录与数据保存保护

登录、会话检查、读取首页与配置均不会写入书签、分类或网站设置。认证接口只更新管理员会话记录。

- 管理员读取导航时携带 `admin=true`，Worker 验证会话后返回 `isAdmin: true`。Token 失效或尚未可读时返回 401，不会将访客过滤后的数据交给管理员编辑。
- 完整管理员导航加载成功前，书签和分类保存入口拒绝写入；切换身份后必须重新加载。云端为空时不再填充示例书签。
- 普通书签编辑只提交 `links`，分类管理只提交 `categories`；导入和恢复备份仍可显式提交两者。空站点首次保存书签时才创建默认收件分类。
- 设置弹窗每次打开都重新读取云端；读取失败或格式无效时禁用保存。云端配置同时更新本地配置缓存，避免继续使用旧缓存。
- 独立配置项覆盖旧配置中的同名部分，同时保留 WebDAV、偏好等其他字段；滚动信息优先采用最新独立配置。管理员会话有效期也优先读取独立网站配置。

本次涉及 `worker/api/storage.js`、`worker/api/auth.js`、`worker/index.test.js`、`src/hooks/useDataSync.ts`、`src/contexts/LinksContext.tsx`、`CategoriesContext.tsx`、`ConfigContext.tsx`、`src/components/layout/AppLayout.tsx` 和 `components/SettingsModal.tsx`。

登录回归验收（使用本地测试 KV）：

1. 准备公开和私密书签、分类密码及网站设置，记录 KV 中 `cate_config`、`links:*`、`config` 和 `config:*` 的原始值。
2. 将浏览器本地缓存换成旧数据，依次执行访客浏览、管理员登录、刷新和退出。Network 中不应出现 `POST /api/storage`；上述业务 KV 值应保持一致，只有认证记录改变。
3. 模拟管理员导航请求 401，确认页面不会使用访客数据进入编辑状态；恢复接口后刷新，应加载完整数据。
4. 模拟设置读取 500，确认有错误提示且“保存设置”禁用。关闭弹窗，恢复接口后重新打开，应显示云端设置并允许保存。
5. 修改公开书签的置顶状态，确认保存请求只有 `links`，私密书签仍包含在管理员提交数据中，分类密码和设置保持不变。
6. 用空 KV 登录，确认没有示例书签被自动写入；手动添加第一条链接后刷新，应只显示手动保存的数据。

新增自动化测试覆盖登录/退出不改动业务 KV、管理员完整读取校验、旧新配置合并、空库首次保存和书签编辑不覆盖分类/设置。浏览器验证使用隔离测试数据，不连接生产 KV；无法据此还原此前线上数据变化的具体请求。


## 配置脱敏、版本冲突、退出与分类删除修复

### 公开组件与凭据

公开配置使用字段白名单：天气只返回启用状态、提供方和单位；Memos 不返回 Token 或带凭据的服务地址；图标配置不返回 Key、请求头或真实自定义服务 URL。管理员读取仍保留完整配置，兼容独立配置项和旧 `config` / `ticker`。

`/api/public-data?kind=weather|memos|icon` 使用服务端保存的配置请求上游，仅返回显示需要的结果或图标内容，失败不回传上游 URL/错误详情。今日诗词天气仍由浏览器获取以保留访客地区信息；其他已有天气提供方改由 Worker 请求。Memos 对访客仅返回 PUBLIC 条目，服务端会再次过滤上游响应；管理员可按现有设置读取。图标代理只接受当前访客可读书签的目标地址或 ID，不提供任意目标代理；书签中的自定义图标配置和带凭据的图标 URL 也不会直接返回访客。

### 写入版本与 KV 限制

[Workers KV 不支持原子读改写](https://developers.cloudflare.com/kv/concepts/how-kv-works/)，所以单纯在 KV 中比较版本、进程内锁或写后再读，都无法保证跨地区并发安全。本次复用已有 R2 的[原子条件写入](https://developers.cloudflare.com/r2/reference/consistency/#conditional-writes)，没有增加部署绑定或依赖：

1. 管理员读取完整导航得到 `version`，前端保存书签、分类、导入和恢复时必须提交该版本。
2. 服务端先在 KV 的唯一 `navigation_snapshot:<版本>` Key 中写入完整分类/书签快照，再以 R2 `onlyIf` / ETag 原子发布 `__cloudnav/navigation-head` 指针。首次发布使用 `If-None-Match: *`。
3. 同一旧版本的并发写入只能有一个发布成功。旧版本返回 **409**，缺少版本返回 **428**；客户端提示刷新，不会换一个新版本自动重放旧数据。
4. 读取先获取 R2 指针，再读取它指定的不可变 KV 快照。某地区暂时读不到快照时返回 **503**，不会退回旧桶或空数组。会话检查独立于导航快照可见性。
5. 原有 `cate_config` 和 `links:*` 继续作为兼容镜像保存，其同步延迟、写入失败或乱序不影响版本判定和导航读取。被取代的快照保留一天供进行中的请求使用，当前快照不设过期时间。
6. 扩展 `/api/link` 的追加和图标迁移也通过同一提交入口进行条件写入，不能绕过版本保护。原始 `key=links:*` / `cate_config` 写入同样受保护，内部快照不能通过任意 Key 写接口修改。

首次升级前应让已有 KV 写入完成传播，再刷新管理页面；首次保存前尚无 R2 指针，旧 KV 数据的传播限制仍存在。升级后不要用旧部署或控制台直接修改兼容镜像；备份/恢复使用应用入口。新增导航快照仍受 KV 单值大小限制，写入失败不会推进 R2 指针。旧版客户端缺少 `version` 会被拒绝，需要刷新。

### 管理员退出

设置窗口和顶部工具栏都调用 `AuthContext.logout()`：等待 `/api/auth` 成功后，才清除本地 Token、缓存和管理员状态。服务端同时撤销请求头和 Cookie 携带的会话，并发送 `Max-Age=0` 清除管理员 Cookie。

会话创建及撤销记录放在现有 R2 的 `__cloudnav/session/` 下；撤销标记优先于 KV，即使某副本仍读到旧 `valid` 也无法恢复权限。旧 KV 会话兼容读取，但退出后同样会有 R2 撤销标记。内部记录不能通过图标 API 读取或删除。R2 不可用时 Token 认证失败关闭；退出失败不显示成功。分类密码和分类授权仍与管理员会话独立。

### 删除分类

服务端从当前版本读取被删分类的书签，在同一个导航快照中将其移动到“常用推荐”，保留书签 ID、URL、图标、置顶等内容，并移除原分类桶。迁移使用“常用推荐”的公开/私密权限，删除确认文字明确说明这一点。

存活的子分类改挂到仍存在的祖先或顶级；继承了被删私密父分类的公开子分类会保留该父分类的密码校验值，避免删除父分类意外公开其内容。已有独立密码的子分类继续使用自己的密码。分类删除与旧书签保存竞争时，同样只能成功一个提交。

### 本次文件与验证

| 文件 | 作用 |
| --- | --- |
| `worker/api/_config.js`、`public-data.js` | 公开配置白名单、服务端组件请求 |
| `worker/api/_navigation.js`、`worker/index.js` | KV 快照与 R2 原子提交，统一覆盖所有导航读写入口 |
| `worker/api/_sessions.js`、`auth.js`、`_kvAdapter.js` | 会话创建/撤销、强一致撤销检查 |
| `worker/api/storage.js`、`_access.js` | 配置/书签脱敏、版本返回、删除父分类后保留子分类权限 |
| `worker/api/link.js`、`migrate-icons.js`、`debug.js`、`upload.js`、`favicon.js` | 使用同一会话验证，保护内部 R2 记录 |
| `src/contexts/LinksContext.tsx`、`CategoriesContext.tsx`、`src/hooks/useDataSync.ts` | 加载版本、共享保存版本、冲突后禁止旧数据继续保存 |
| `src/contexts/AuthContext.tsx`、`src/components/layout/Header.tsx`、`components/SettingsModal.tsx` | 统一退出流程和失败提示 |
| `components/WeatherDisplay.tsx`、`MastodonTicker.tsx`、`services/iconService.ts` | 复用原组件显示服务端返回的数据 |
| `components/CategoryManagerModal.tsx` | 删除确认说明目标分类权限 |
| `worker/index.test.js` | 脱敏、代理、并发、KV 延迟、退出重放及分类迁移测试 |
| `README.md`、`docs/workers.md`、本文档 | 存储用途、版本限制和复测说明 |

运行 `pnpm test:worker`（39 项）及 `pnpm deploy:dry-run`。测试包括首次/后续同时提交、缺失/旧版本、原始 Key 写入、扩展/迁移竞争、KV 旧副本和快照不可见、会话撤销故障、请求头与 Cookie 分别重放、父子分类迁移和私密密码保持。还使用 Wrangler 本地 KV/R2 验证实际条件写入返回一成功一冲突。

浏览器复测：打开两个管理页面，在其中一个保存后，用旧页面保存应提示版本冲突，刷新后显示已保存内容；分别从设置窗口和顶部退出，确认管理员入口和私密书签消失，旧 Token 通过请求头或 Cookie 重放均不再有管理员权限；删除含书签分类后刷新，确认书签在“常用推荐”且数量未减少。原有 UI、导航/搜索、私密分类验证和管理员编辑入口保持不变。
