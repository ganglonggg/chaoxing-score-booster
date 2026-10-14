# Chaoxing Plaza 答题刷分故障排查与规范指南

## 1. 核心运行原则

### 1.1 唯一学习标签页原则 (Single Study Tab Policy)
- **现象**：超星学习端如果在两个标签页中同时打开章节，系统会立即弹出：“您的账号已在其他页面学习，请刷新后继续”。
- **原因**：超星服务器端维护心跳与单一活跃学习会话检测。
- **解决方案**：
  - `booster.mjs` 在执行 `next-quiz` 或进入章节时，会自动扫描所有标签页，严格保留**最多 1 个**学习页面（`studentstudy` 或 `nodedetailcontroller`）。
  - 学习广场页面（`/plaza/`）用于积分核对，可单独保留，不计入学习冲突。
  - 切勿手动或并行打开多个做题标签。

### 1.2 字体混淆（反爬字体）与视觉识别
- **现象**：在 HTML DOM 中提取的题目文字包含乱码或私有 Unicode 字符（如 `&#xe001;` 等）。
- **原因**：超星章节测验动态加载了 base64 混淆字体，将中文字符映射到随机 Unicode 编码。
- **解决方案**：
  - 浏览器原生引擎在渲染页面时，已经完美应用了该自定义字体。
  - `booster.mjs` 调用 Chrome DevTools Protocol 原生 `captureScreenshot`，将当前题目区域完整截取为 `current-quiz.png`。
  - Agent 通过视觉工具（如 `view_file`）直接查看该截图，题目和选项均为纯正中文，100% 准确无误差，完全免疫任何字体加密变种。

### 1.3 提交与二次弹窗确认
- **流程**：
  1. 在内部作业 iframe 中选中选项（单选 `role="radio"`, 多选 `role="checkbox"`）。
  2. 点击作业 iframe 内部的“提交”按钮。
  3. 顶层页面会弹出“确认提交”对话框（确认按钮 ID 为 `#popok`）。
  4. 必须点击 `#popok`，系统才会真正记录成绩！
  5. `booster.mjs` 的 `submit` 与 `step` 命令已封装全套流程，并自动轮询确认弹窗和成绩。

---

## 2. 常见问题排查

### 问题 A：`WAITING_FOR_LOGIN`
- **说明**：打开的 Chrome 窗口中尚未登录超星账号，或会话已过期。
- **操作**：
  1. 在弹出的 Google Chrome 窗口中，直接输入手机号/学号完成登录。
  2. 登录后进入目标课程的学习广场页面（URL 含 `tsjy.chaoxing.com/plaza/`）。
  3. 再次运行 `node scripts/booster.mjs init --url <URL>` 即可自动绑定并就绪。

### 问题 B：积分刷新延迟
- **说明**：有时提交章节测验后，广场页面的“累计积分”需要 1~2 秒同步。
- **操作**：`booster.mjs` 在读取积分前会自动触发 `location.reload()` 并等待 2.5 秒，确保读取到最新的服务端累计积分。

### 问题 C：换电脑或换账号迁移
- **新账号**：直接指定全新的 `--state-dir`（例如 `--state-dir ./state-user2`），独立管理 Chrome Profile，互不污染。
- **换电脑**：整个 `chaoxing-score-booster` 文件夹无全局 npm 依赖，只需本机装有 Node.js 22+ 及 Google Chrome，复制文件夹后立即可运行。
