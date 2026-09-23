# 社交发布

[English](social.md) | 中文

以操作者本人的名义对外发布，由 [social 包组](../../packages/social/README.md)持有：注册表合并每个已挂载提供方给出的目标——LinkedIn 个人主页、Facebook 主页、Instagram 商业账号、YouTube 频道——并把一次发布路由到持有该目标 id 的提供方。模型从不指名平台；它读取一份目标清单，然后发布到其中之一。

这是本 harness 中唯一以某个人的名义公开说话的能力，而且发出去的内容收不回来。因此 `social_post` 在执行中的操作内部——唯一能到达 `ctx.social.post()` 的代码路径——通过[审批接缝](approval.md)向人发问，于是没有任何其他调用方、也没有任何监听顺序能到达一次跳过了询问的发布。

## 归属

| 归属 | 职责 |
|---|---|
| [social](../../packages/social/social/README.md) | `ctx.social`：注册表、合并后的目标清单，以及把一次发布路由到持有它的提供方 |
| [social-linkedin](../../packages/social/social-linkedin/README.md) | LinkedIn 个人主页发布、其 OAuth 流程与应用凭据 |
| [social-meta](../../packages/social/social-meta/README.md) | Facebook 主页与 Instagram 商业账号，以及 Meta 上传所需的公开媒体地址 |
| [social-youtube](../../packages/social/social-youtube/README.md) | YouTube 频道上传及其背后的 Google OAuth 客户端 |
| [tool-social](../../packages/social/tool-social/README.md) | `social_targets` 与 `social_post`、审批闸门，以及设置卡片读取的 `/social/*` 路由 |
| [ui-social](../../packages/client/ui-social/README.md) | 插件页：已连接什么、哪些即将失效，以及应用凭据表单 |

## 目标、发布与凭据

一个 `SocialTarget` 就是一个可以发布到的位置：模型回引的 id、给人看的标签、该处平台接受哪些媒体，以及其背后的凭据是否仍然可用。`ctx.social.targets()` 合并每个已挂载提供方的回答；id 在提供方之间唯一，这正是 `post` 无需调用方指名平台就能路由的前提。

这里有两种东西都叫凭据，卡片把它们分开。**应用**——client id、client secret 与回调地址——向平台标识这个部署，属于配置：只设置一次，从插件页或环境变量给出，对每个账号都相同。**账号授权**是某个人登录后产生的令牌；它从不被填进表单。账号是通过让智能体去连接的：它走完提供方的授权流程，并通过[凭据接缝](credentials.md)保存该授权。

持有可用凭据的提供方仍然可以有话要说。`SocialTarget.state` 把 `ready` 与 `warning` 区分开——后者正是卡片存在的理由：今天还能用、但很快就要失效的令牌——并与 `blocked` 区分开；提供方自己的那句话原样送达读者，因为它说明了该做什么。

## 审批

`postWithoutApproval` 逐个豁免目标 id，而不是一个全局开关：为某个预发频道关掉询问，不会悄悄把操作者本人主页的询问也关掉。审批请求展示被审批的全部内容——目标标签、原样的正文，以及每个附件的文件名、种类与大小——因为隐藏了主体的审批不成其为审批。

源码：[`packages/social/social/src/types.ts`](../../packages/social/social/src/types.ts)、[`packages/social/tool-social/src/routes.ts`](../../packages/social/tool-social/src/routes.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsocial--socialregistry"></a>

### `ctx.social` — `SocialRegistry`

Registry of social-posting providers and the router in front of them.

`register()` files each provider into the calling context's fiber, so a disposed provider plugin removes its targets from every later listing. Reads re-ask every provider: `ready` is a live fact about a credential, and a cached "ready" would publish under someone's name on the strength of a stale observation.

```ts cordis-catalog
/**
 * Register one borrowed same-process provider. The name must be unique and
 * free of `:` and whitespace, because it is the prefix that makes every
 * target id this provider lists resolve to exactly this registration.
 * @param provider - the platform implementation to register.
 * @returns the exact Cordis effect disposer that unregisters it; disposing
 *   the registering fiber does the same.
 */
register(provider: SocialProvider): () => void

/**
 * Every target across every registered provider, ready or not.
 * @returns the merged targets, ordered by id so the catalog is stable.
 */
async targets(): Promise<readonly SocialTarget[]>

/**
 * Publish one post through the provider owning `request.target`.
 *
 * Every refusal happens here, before the provider is called: an unknown id
 * lists the ids that exist, an unready target carries the provider's own
 * reason, and an attachment or a body the target does not accept fails
 * naming the target rather than surfacing a platform error from inside a
 * provider.
 * @param request - the target id, the text to publish verbatim, and any attachments.
 * @returns what the owning provider created.
 * @throws when the target is unknown, unready, or does not accept what the
 *   request carries.
 */
async post(request: SocialPostRequest): Promise<SocialPostResult>
```

Source: [`packages/social/social/src/index.ts`](../../packages/social/social/src/index.ts)
<!-- END GENERATED cordis-surface -->
