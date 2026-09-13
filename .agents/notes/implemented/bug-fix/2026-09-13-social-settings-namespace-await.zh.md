# Agent Note：social 设置卡片需要等待 settings 作用域，而不是取样一次

Status: implemented

[English](2026-09-13-social-settings-namespace-await.md) | 中文

## 问题

`tool-social` 发布时，它在 Settings → Plugins 中的卡片无法访问。插件已激活，两个 `/social/*` 路由都能应答，浏览器侧也已组合，但卡片在任何部署中都不出现。

Settings → Plugins 标签页只在某个卡片的 key 同时是 Host 所提供的 settings 命名空间时才派发它 —— 这是两个账册的交集，由 `ConfigurablePluginsTabController` 计算。`tool-social` 这样提供它那一半：

```ts
ctx.get('settings')?.register('social', z.object({}) …, { base: {} })
```

settings 服务以文件为后端，其 `Service.init` 从磁盘解析，因此当与它一同组合的插件 apply 时，它并不在服务存储中。`ctx.get` 在每次启动时都读到 `undefined`，这个可选调用什么也没有注册。没有失败，没有日志，唯一可见的症状就是卡片缺失 —— 而这正是该 seam 自己的列举规则所说的、比大声拒绝更糟的失败方式。

在构建产物中插入探针，并通过发布的 Web profile 配合 `deploy/plugins/social.cordis.yml` 启动，在 `apply` 处打印出 `settings = UNDEFINED`。

## 决定

在一个作用域中等待该服务，而不是对服务存储取样一次：

```ts
ctx.inject(['settings'], (settingsCtx: Context) => {
  settingsCtx.settings.register('social', z.object({}) …, { base: {} })
})
```

`settings` 仍然不进入 `inject`。当初为之选择它的那条性质依然正确 —— 没有 settings 服务的组合应当失去卡片，而不是失去工具和目录 —— 作用域 inject 恰好保留了这条性质，同时是等待服务而不是与之竞争。`bash-local`、`pwsh-local`、`agent-presets` 和 `ui-theme` 对同一个服务已经在用这个写法。

`approval` 与 `credentials` 保留 `ctx.get`，对它们而言这依然正确：两者都在某个操作内部读取，而该操作可以当着人的面拒绝，那已远在激活完成之后。

### 验证

`tests/settings-card.spec.ts` 组合一个真实的 `Context`，在没有 settings 服务时 apply 插件，断言工具已注册而命名空间未注册，然后提供该服务并断言命名空间到达。它在 `ctx.get` 形式下失败，在作用域 inject 下通过；另外两个套件中的桩 context 无法表达这个区别，因为"`apply` 运行时就已持有该服务"的桩，恰恰是任何真实启动都不处于的那一种状态。

## 考虑过的替代方案

**在 `inject` 中声明 `settings`。** 这是 `deploy/plugins/whatsapp.mjs` 的做法，其注释称这个依赖是承重的。在那里是对的 —— 该插件的全部目的就是卡片。在这里，它会把面向模型的工具绑到它们从不触碰的服务上，于是省略 settings 的组合会连同卡片一起失去 `social_post`。

**由浏览器侧注册该命名空间。** 已提供集合按构造就是 Host 的事实；由客户端包来断言它，会让卡片在并未组合其插件的部署中把自己列出来。

## 后果

- settings 服务加载完成后卡片即被列出，与其他每个设置界面变为可用是同一时刻。
- 没有 settings 服务的组合仍然得到工具和路由，并且没有卡片。这现在是失去卡片的唯一途径。
- 只要有插件在 `apply` 处对一个异步初始化的服务取样，这个一般性隐患就依然存在：该 seam 按构造是静默的，只有服务在其后才落位的 context 才能捕获它。`ctx.get` 对使用点读取仍然正确，对激活期注册则不正确。
