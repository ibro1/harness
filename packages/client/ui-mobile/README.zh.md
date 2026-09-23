---
description: "Fork 自有的响应式层：一份移动端样式表，把仅为桌面设计的 web GUI 布局与设置弹窗适配到小屏。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile

## 目录

- [概述](#概述)
- [已知限制与待办](#已知限制与待办)
- [开发备注](#开发备注)

-----

## 概述

web GUI 只按桌面宽度出货——一个由 JavaScript 驱动、没有任何 CSS 断点的三列网格——所以在手机上侧边栏仍保持桌面窄轨，设置弹窗仍保持两列面板并被裁切。本插件注入一份全局样式表，在 768px 以下生效：让内容占满宽度，把展开的侧边栏变成覆盖式抽屉而不是挤压正文的一列，并让设置弹窗全屏且可滚动。

它不改动任何组件：它针对布局框架上稳定的 `data-*` 钩子（`data-shell-frame`、`data-shell-sidebar`、`data-shell-center`、`data-rightbar-col`）与设置面板（`data-settings-panel`、`data-settings-content`），覆盖基础布局设置的内联宽度。

## 已知限制与待办

- **折叠后的侧边栏窄轨在移动端仍在文档流中**，因此它原有的开关按钮仍可点到以打开抽屉。完全移出画布的窄轨加上自己的汉堡控件被推迟，因为那个控件需要本地化文案，而它不属于这个只有 CSS 的插件。
- **断点固定为 768px**，不可配置。
- **纯表现层**：插件只注入一份样式表，不持有状态、服务或文案。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

样式表按属性选中布局框架，因此上游重命名某个 `data-*` 钩子时，规则会静默失效而不是让构建失败。rightbar 的重命名就是先例：details 列变成了 `data-rightbar-col`，`data-details-collapsed` 变成了 `data-rightbar-collapsed`。

</details>

**运行时不变量：** 不发布伴生包。本包注入一份样式表且不持有状态，因此对它的两次观察不会分歧。
