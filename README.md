# 超星课程学习广场极速答题刷分 Skill (`chaoxing-score-booster`)

一个独立且通用的 AI Agent Skill：在 `tsjy.chaoxing.com` 超星学习广场（形势与政策/通识课），自动启动独立 Google Chrome 窗口，自适应新电脑、新 Agent 与新账号，定位章节测验并利用题目视觉快照规避字体混淆，高效答题提交并核对累计积分，持续刷分直至达到目标 800 分后干净收尾。
---

## 核心设计特性

1. **跨电脑与跨平台**：
   - 自动适配 macOS、Windows 和 Linux 下的 Google Chrome 默认安装路径。
   - 基于 Node.js 22+ 原生标准库（`fetch` + 原生 `WebSocket`），**零任何第三方 npm 依赖**，跨机器无需 `npm install`。
2. **跨 Agent 通用性**：
   - 包含完整的 [SKILL.md](SKILL.md) 提示词规范与标准化 CLI 工具链（`init` / `next-quiz` / `step` / `status` / `finish`）。
   - 兼容 Antigravity、Codex、Claude 3.5、GPT-4o、Cursor 等各类主流 Agent。
3. **新账号完全隔离**：
   - 动态从 URL 和 DOM 提取 `courseId`, `classId`, `personId`, `userId`，不硬编码任何个人信息。
   - 使用独立的 `--state-dir`（独立 Chrome 用户配置目录），与日常个人浏览器互不干扰，换账号只需换个状态目录。
4. **单学习标签页硬约束 (Single Study Tab Policy)**：
   - 超星严格限制多标签页/多端并发学习（多开会立即弹窗报错：“您的账号已在其他页面学习，请刷新后继续”）。
   - 底层脚本强制保证全局**严格只有 1 个学习页面**，全自动避开封锁与会话冲突。
5. **题目视觉快照规避字体混淆**：
   - 超星题库动态下发 base64 混淆字体，在 DOM 中提取的字符带随机加密码点。
   - 脚本通过 Chrome DevTools 原生截取题目渲染快照 `current-quiz.png`，保留 100% 原始视觉中文，Agent 看图直答，正确率 100%。

---

## 安装方法

直接克隆本仓库到你的 Agent Skill 目录：

### 安装至 Codex
```bash
git clone https://github.com/ganglonggg/chaoxing-score-booster.git ~/.codex/skills/chaoxing-score-booster
```

### 安装至 Antigravity / Gemini
```bash
git clone https://github.com/ganglonggg/chaoxing-score-booster.git ~/.gemini/config/skills/chaoxing-score-booster
```

---

## 运行条件

- **操作系统**：macOS / Windows / Linux
- **环境要求**：已安装 Google Chrome，已安装 Node.js 22+
- **Agent 能力**：支持执行本地 Shell 命令、具备多模态识图能力（如查看图片文件）

---

## 快速使用流程 (Agent 标准三步法)

### 第一步：初始化并拉起 Chrome

```bash
node scripts/booster.mjs init --url '<你的课程广场完整URL>' --state-dir ./state --target 800
```
> 若尚未登录，Chrome 窗口会自动打开，用户扫码/输入手机号完成登录后，重新执行一次上述命令即可。

### 第二步：获取测验题目

```bash
node scripts/booster.mjs next-quiz --state-dir ./state
```
脚本会自动定位到未完成的测验章节，并生成高清题目截图 `./state/current-quiz.png`。

### 第三步：提交答案并自动流转（核心循环）

Agent 查看题目截图并推断出答案向量后，执行：
```bash
node scripts/booster.mjs step '[1, 0, 2, 0, 1]' --state-dir ./state
```
`step` 命令会自动完成：**自动点击选项 -> 提交 -> 点击二次确认弹窗 -> 核实成绩 -> 刷新广场查分 -> 若满 800 分自动生成截图并关闭标签页 / 若未满 800 分自动跳转下一节测验并生成新题目截图**。

重复执行此步骤，直到输出结果显示 `"status": "TARGET_REACHED"` 即可！

---

## CLI 命令速查表

| 命令 | 说明 | 示例 |
| :--- | :--- | :--- |
| `doctor` | 检查本机 Chrome 与 Node.js 运行环境 | `node scripts/chrome-launcher.mjs doctor` |
| `init` | 启动专用 Chrome 窗口并绑定广场 | `node scripts/booster.mjs init --url '<URL>'` |
| `status` | 刷新广场并获取当前累计/今日积分 | `node scripts/booster.mjs status` |
| `next-quiz` | 定位下一个待完成测验并生成题目快照 | `node scripts/booster.mjs next-quiz` |
| `step` | 提交当前答案 + 查分 + 自动推进下一题 | `node scripts/booster.mjs step '[0, 1, 2]'` |
| `finish` | 手动完成：保存最终确认截图并关闭做题页 | `node scripts/booster.mjs finish` |

---

## 目录结构

```
chaoxing-score-booster/
├── SKILL.md                          # Agent 专属技能指导文件
├── README.md                         # 项目使用说明
├── package.json                      # 项目元信息
├── references/
│   └── troubleshooting.md            # 常见问题、单标签原则与字体加密排障
└── scripts/
    ├── chrome-launcher.mjs           # 跨平台 Chrome 进程启动与管理
    ├── cdp-client.mjs                # 零依赖 Chrome DevTools Protocol 原生客户端
    └── booster.mjs                   # 测验答题、多重 iframe 穿透与积分自动化引擎
```

---

## 许可证

MIT License
