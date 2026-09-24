---
description: "Fork 自有的响应式层：一份移动端样式表与抽屉遮罩，把仅为桌面设计的 web GUI 布局与设置弹窗适配到小屏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile

[English](README.md) | 中文

## 概述

web GUI 只按桌面宽度出货——一个由 JavaScript 驱动、没有任何 CSS 断点的三列网格——所以在手机上侧边栏仍保持桌面窄轨，设置弹窗会被裁切。本插件注入一份全局样式表，在 768px 以下生效：让内容占满宽度，把展开的侧边栏变成覆盖式抽屉，并让设置弹窗全屏且可滚动。它还挂载一个遮罩，使抽屉在被点击外部、或在其中打开某个会话之后关闭。

## 目录

- [理解实现](#understand-the-implementation)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="understand-the-implementation"></a>
## 理解实现

样式表不改动任何组件：它针对布局框架上稳定的 `data-*` 钩子（`data-shell-frame`、`data-shell-sidebar`、`data-shell-center`、`data-rightbar-col`）与设置面板（`data-settings-panel`、`data-settings-content`），覆盖基础布局设置的内联宽度。

遮罩是本包唯一渲染的元素，注册到 `shell.overlay`。CSS 只在手机打开抽屉时显示它，而它以两种方式关闭抽屉：点击遮罩本身，以及主视图转而持有另一个会话。后者跟随的是结果而不是某一次行点击，因为一行只是会话成为当前会话的若干途径之一。两者都调用布局开关，因此都先确认侧边栏处于展开状态——在折叠窄轨上触发该开关会打开抽屉而不是关闭它。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **折叠后的侧边栏窄轨在移动端仍在文档流中**，因此它原有的开关按钮仍可点到以打开抽屉。完全移出画布的窄轨加上自己的汉堡控件被推迟，因为那个控件需要本地化文案。
- **断点固定为 768px**，不可配置；遮罩在 TypeScript 中重复了这个值，因为媒体查询无法从它所属的样式表中读出。
- **纯表现层**：本包不持有自己的文案，也不持有任何持久状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

样式表按属性选中布局框架，因此上游重命名某个 `data-*` 钩子时，规则会静默失效而不是让构建失败。rightbar 的重命名就是先例：details 列变成了 `data-rightbar-col`，`data-details-collapsed` 变成了 `data-rightbar-collapsed`。

</details>

**运行时不变量：** 不发布伴生包。本包注入一份样式表，并在布局服务持有的状态之上渲染一个遮罩，因此对它的两次观察不会分歧。
