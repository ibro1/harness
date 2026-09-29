---
description: "dsh Web 客户端插件页面上的分支本地设置页：Dokploy、Cloudflare 和 Postgres 插件可操作的服务器、站点、账户和数据库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-operations

[English](README.md) | 中文

## 概述

在侧边栏打开 **Plugins**，在 Official 分组中选择 **Dokploy**、**Postgres** 或 **Cloudflare**，即可编辑该插件可操作的对象：Dokploy 服务器、Postgres 数据库，以及 Cloudflare 站点和账户。每一项都是一个 JSON 列表，输入时即校验，只在保存时写入。仅当 Host 提供该插件的命名空间时才会出现对应页面，因此未组合某个插件的部署不会显示它的页面。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

每个字段都是一个 JSON 数组，每项以两种方式之一提供其密钥：保存密钥的环境变量名（`apiKeyEnv`、`apiTokenEnv`、`dsnEnv`），密钥不写入设置；或直接填写值（`apiKey`、`apiToken`、`dsn`），将保存在设置中并显示在页面上。两者都没有的条目在输入时即被拒绝，因为它无法完成认证。插件不接受的草稿会禁用 **Save** 并说明问题；清空字段并保存即清除该字段。

- **Dokploy — 服务器：** `name`、`url` 和密钥。
- **Postgres — 数据库：** `name` 和连接串，以及可选的布尔值 `readOnly`（除非设为 false，否则为 true）和正数 `statementTimeoutMs`。
- **Cloudflare — 站点：** `name`、`zoneId`，以及限定于该站点的令牌。
- **Klipara Scout：** 每日外联班次的开关、开始时间与时区、样片与推介上限、搜索主题、频道限制、Klipara API 密钥、WhatsApp 提醒对象、班次模型与样片页文字，并有 **查看线索** 按钮，打开单独的 **Klipara Scout 线索** 页面，列出每条线索并每 15 秒刷新。
- **Cloudflare — 账户（可选）：** `name`、账户 `id`，以及作用于整个账户的令牌。配置后，Agent 可按域名访问账户下的每一个域名，因此**站点**只需列出应使用各自更窄令牌的域名。该令牌需要整个账户的 DNS 编辑与缓存清除权限；如需添加域名，还需 Zone 编辑权限。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

Host 端是一个空的 `apply`，仅用于让本包拥有一个 Loader 条目，客户端模块系统据此提供浏览器端。浏览器端通过 `ctx.configForms.get` 绑定 `dokploy`、`postgres` 和 `cloudflare` 命名空间，并在各自的控制器中基于 `ui-primitives` 共享的 `SettingsFormModel` 维护每个页面的暂存表单。每个字段的规格把草稿解析为 JSON，并执行与插件相同的条目规则，因此插件会在首次调用时拒绝的列表在这里就会被拒绝。页面通过 `ctx.configForms.whileServed` 注册到插件页面的 `plugins.item` 插槽，每个命名空间一个监听。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md) — 插件页面及页面注册所用的 `plugins.item` 插槽。
- [ui-settings](../ui-settings/README.zh.md) — 页面所依赖的设置作用域和已提供命名空间监听。
- [ui-primitives](../ui-primitives/README.zh.md) — 页面渲染所用的设置表单模型和字段。
- `dsh-host-dokploy`、`dsh-host-postgres`、`dsh-host-cloudflare` — 注册这些命名空间的插件，位于 `packages/host/`。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器端的设置界面，不注册任何模型可见的内容。

#### KV Cache 影响

无；本包既不组装也不发送任何提供商请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **每个字段一个 JSON 块** — 条目以 JSON 文本编辑，而非每项一个表单。
- **内联密钥可见** — 内联填写的密钥、令牌或连接串会保存在设置中并显示在页面上；环境变量形式则两者都不会。
- **运行时不变量：** 不发布配套模块。页面不持有自己的关联关系：显示内容来自设置镜像，写入内容由 Host 校验。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

这些页面原本位于 `ui-settings-plugins`，上游将其官方页面各自迁入独立的配套包后，它们迁移至此，以使该包与上游保持一致。Cloudflare 页面在插件已改用 `accounts` 列表后仍在编辑单个 `account` 对象，因此从该页面保存的账户从未到达插件；此次迁移修正了该字段。

</details>
