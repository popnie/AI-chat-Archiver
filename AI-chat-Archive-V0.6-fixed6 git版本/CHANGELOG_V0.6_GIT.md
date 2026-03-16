# V0.6 Git 更新日志

## 1. Popup 插件弹窗优化
- 删除6大AI平台按钮下方灰色公司信息（OpenAI/Anthropic/Google等）
- 调整平台按钮大小更紧凑美观
- 取消/关闭平台后整个卡片（文字、图标、圆点）变为灰色，视觉区分更明显

## 2. Timeline 时间线 & 思维导图
- 重要消息标记从🍓更换为🌟
- 聊天记录面板右侧小圆点在标记后也同步显示红色
- 思维导图按钮图标从🧠更换为🗺️
- 思维导图按钮样式改为浅橙色底+黑色字体，更柔和

## 3. Prompt 库增强
- Prompt 面板支持拖动（可从标题栏拖拽）
- Prompt 面板支持八方向缩放（边角/边缘均可拖拽）
- 新增 .md 文件导入功能（支持 --- 分隔的多 prompt 格式）
- 新增 .md 文件导出功能

## 4. Timeline 圆点美化
- 移除类似 Google Map 的微信气泡图标
- 更换为带光晕的浅色橙色圆点，简洁优雅
- 聊天记录面板按钮从地图 pin 改为聊天气泡图标

## 5. DeepSeek 侧边栏修复
- 修复侧边栏激活后覆盖 DeepSeek 原始页面的问题
- 改为通过 CSS margin-left 推动 #root，保留原版页面完整性
- 不再使用 transform 避免层叠上下文问题

## 6. ChatGPT 拖拽收藏修复
- 修复 ChatGPT 左侧侧边栏聊天记录无法拖拽到收藏夹的问题
- 放宽拖拽标题匹配限制，即使标题提取不完美也允许拖拽
- 拖拽到目标文件夹时重新提取最新标题，确保数据准确
- 原生 draggable 绑定不再因标题为空而跳过

## 版本号
- 全局版本升级到 V0.6 Git

## 7. Gemini / Kimi 时间线修复
- 修复 Gemini 时间线悬停不自动弹出文本框的问题
- 增强 Gemini `user-query / model-response` 结构识别，适配更稳
- 修复 Kimi 因消息节点识别失败导致 timeline 不显示的问题
- 为 Kimi 增加更宽松的用户/助手消息匹配与回退识别逻辑
- 保持版本号不变，仍为 V0.6 Git

## 8. V0.6fixed 二次修复
- Gemini 时间线新增更稳的 hover 触发链路：`mouseover / mouseenter / pointermove / pointerenter`
- 为时间线增加全局指针兜底检测，靠近时间线区域时也会自动激活预览文本框
- 悬停预览改为优先读取 `nodeText()`，避免 Gemini 自定义节点文本提取不稳定
- ChatGPT 拖拽收藏改为更稳的 pointer-drag 流程，补上点击拦截，避免拖拽过程中被原站点点击/跳转打断
- 收藏夹命中检测改为 `elementsFromPoint()`，提升拖到 bookmarks 时的目标识别成功率
- 版本号继续保持 V0.6 Git
