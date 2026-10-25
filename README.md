# 菜鸟销退单助手

## 安装与更新

在 Chrome 安装 Tampermonkey，再打开固定地址，点击“安装”或“重新安装”：

https://raw.githubusercontent.com/grin-gitx/cainiao-returns-assistant/main/cainiao-returns.user.js

刷新菜鸟页面后使用。其他电脑也用同一地址；后续可在 Tampermonkey 中检查更新。每台电脑的批次进度独立，同一批次不要在多台电脑同时运行。

## 1.6.8 等待优化

- 地址、货品和物流信息完整且持续稳定时，合并重复等待。
- 页面就绪后开始处理，保留每次操作间隔和单间隔。
- 缺市区、页面变化或信息尚未完整时，使用原有等待流程。
- 原批次继续使用原等待方式；重新选择表格的新批次默认启用优化。
- 勾选“使用原版等待节奏”后，再重新选择表格，下一批使用原有等待方式。
- 批次完成后可在助手中查看填写、补查、结果核对及单间等待的耗时。计时为本机经过时间，包含页面跳转等待；不上传耗时或业务数据。

本地测试用于验证逻辑与等待变化；实际生产速度取决于页面加载和补查比例，需要用后续正常业务批次测量。

## 完整回退到 1.6.7

1. 停止当前处理；若刚提交过订单，先核实该单的创建结果。
2. 打开以下回退专用地址，确认覆盖安装旧版，再刷新菜鸟页面：

https://raw.githubusercontent.com/grin-gitx/cainiao-returns-assistant/main/releases/1.6.7/cainiao-returns.user.js

回退包的运行代码与原 1.6.7 相同，只把更新信息设为 `none`，关闭更新检查。脚本身份和批次存储名称保持不变；刷新、接管和提交状态不明时仍按原有流程核实，不能因切换版本重复提交。

恢复新版时，重新打开本文顶部的固定安装地址并覆盖安装。相关元数据说明见 [Tampermonkey 文档](https://www.tampermonkey.net/documentation.php?q=update_url)。
