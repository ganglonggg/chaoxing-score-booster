---
name: chaoxing-score-booster
description: 在 tsjy.chaoxing.com 超星学习广场（形势与政策/通识课），自动启动独立 Google Chrome 窗口，自适应新电脑、新 agent 与新账号，定位章节测验并利用题目视觉快照规避字体混淆，高效答题提交并核对累计积分，持续刷分直至达到目标 800 分后干净收尾。
---

# 超星课程广场章节测验极速刷分 (800分达标)

本技能提供全自动与人机协同的极速刷分能力。通过做章节测验（`章节测验`/`知识测评`）代替低效挂视频，彻底避开每日视频播放时长与积分上限，单门课通常仅需 10~15 分钟即可从 0 冲到 800+ 积分。

## 运行前提与设计特点

1. **环境要求**：
   - 目标电脑已安装 **Google Chrome** 浏览器。
   - **Node.js 22+**（自带原生 fetch 与 WebSocket，**零第三方 npm 依赖**，跨平台一键运行）。
   - Agent 具备执行本地 shell 命令及查看图片（`view_file` 或等价多模态视觉能力）。
2. **跨机器与跨账号隔离**：
   - 使用独立 `--state-dir`（例如 `./state`），Chrome 配置目录、登录凭证、做题历史完全隔离，不侵入日常浏览。
   - 换电脑只需将本 skill 目录拷贝至新电脑；换新账号只需更换 URL 并使用新 `--state-dir`。
3. **单学习标签页硬约束 (Single Study Tab Policy)**：
   - 超星严查多端/多页面并发答题，多开会弹窗报“账号已在其他页面学习”。
   - 脚本底层强制保持 **严格只有 1 个学习标签页**（广场页单独保留查分），防拦截、防冲突。
4. **字体加密视觉破除**：
   - 超星题库动态下发 base64 混淆字体，DOM 文字包含随机私有码点。
   - 脚本直接通过 Chrome DevTools 原生截取题目渲染快照 `current-quiz.png`，保留 100% 原始视觉中文，Agent 看图即答，正确率 100%。

---

## Agent 操作标准流程

Agent 在接收到用户“刷到 800 分”的指令时，按以下 4 步执行：

### 第一步：启动浏览器与环境初始化

获取用户的课程广场 URL（例如包含 `courseId`, `classId`, `personId`, `userId` 的 `https://tsjy.chaoxing.com/plaza/?...`）。
在工作目录下运行初始化命令：

```bash
node <SKILL_DIR>/scripts/booster.mjs init --url '<COURSE_PLAZA_URL>' --state-dir ./state --target 800
```

- 若返回 `WAITING_FOR_LOGIN`：告知用户在自动弹出的 Chrome 窗口中完成登录，进入课程广场后，再次运行上述 `init` 命令。
- 若返回 `READY`：初始化成功，终端会输出当前累计积分及课程元数据。

---

### 第二步：获取第一道待完成测验

运行命令加载并定位首个未完成的章节测验：

```bash
node <SKILL_DIR>/scripts/booster.mjs next-quiz --state-dir ./state
```

- 脚本会自动打开单个学习标签页，定位到包含测验的章节，切换到测验 iframe，并自动截取高清题目图片保存到 `./state/current-quiz.png`。
- 输出示例：
  ```json
  {
    "status": "QUIZ_READY",
    "chapterId": "1159460598",
    "title": "坚持和完善中国特色社会主义制度",
    "questionCount": 5,
    "questions": [
      { "index": 0, "type": "单选题", "optionCount": 4 },
      { "index": 1, "type": "单选题", "optionCount": 4 },
      { "index": 2, "type": "判断题", "optionCount": 2 },
      { "index": 3, "type": "判断题", "optionCount": 2 },
      { "index": 4, "type": "判断题", "optionCount": 2 }
    ],
    "screenshot": "./state/current-quiz.png"
  }
  ```

---

### 第三步：循环做题并推进（Agent 核心循环）

针对每个返回的测验：

1. **查看题目图片**：
   Agent 调用自身的查看文件工具查看 `./state/current-quiz.png`，直观阅读每道题的题目与选项。
2. **推导答案向量**：
   - 选项索引从 `0` 开始（`0`=A/对, `1`=B/错, `2`=C, `3`=D...）。
   - 单选/判断为整数索引，如 `[1, 1, 1, 0, 1]`。
   - 多选题为数组，如 `[[0, 1, 2], 1, 0]`。
3. **一键提交并自动推进到下一题 (`step` 命令)**：

   ```bash
   node <SKILL_DIR>/scripts/booster.mjs step '[1, 1, 1, 0, 1]' --state-dir ./state
   ```

   **`step` 命令会自动执行以下完整闭环**：
   - 在 iframe 中选中对应选项；
   - 点击“提交”；
   - 自动点击二次确认弹窗（`#popok`）；
   - 确认记录成绩（通常为 100 分）；
   - 刷新广场页面核验最新累计积分；
   - **如果积分已达到 800**：自动截取确认图 `./state/score-confirmation.png`，关闭做题标签页，返回 `TARGET_REACHED`；
   - **如果积分未满 800**：自动点击“下一节”，寻找到下一个测验章节并生成新的 `./state/current-quiz.png`，返回新题目结构！

4. **重复此循环**，直到 `step` 命令输出中 `status` 为 `"TARGET_REACHED"`。

---

### 第四步：完成确认与报告

当检测到 `TARGET_REACHED` 时：
1. 学习标签页已被脚本安全关闭，只保留广场页供用户查看。
2. 确认图保存在 `./state/score-confirmation.png`。
3. Agent 向用户汇报达标成绩（例如 804/800 分），并附上确认截图链接。

---

## 常用 CLI 命令速查表

| 命令 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| `node scripts/booster.mjs init` | 启动 Chrome 并绑定广场页 | `--url '<URL>'`, `--state-dir <DIR>`, `--target 800` |
| `node scripts/booster.mjs status` | 刷新广场并查询当前累计/今日积分 | `--state-dir <DIR>` |
| `node scripts/booster.mjs next-quiz` | 定位下一个未完成测验并生成题目截图 | `--state-dir <DIR>` |
| `node scripts/booster.mjs step '<JSON>'` | **核心**：提交当前答案 + 查分 + 自动推进下一题 | 答案 JSON，如 `'[0, 1, 2, 0]'` |
| `node scripts/booster.mjs submit '<JSON>'` | 仅提交当前测验，不自动推进 | 答案 JSON |
| `node scripts/booster.mjs finish` | 手动结算：截取完成图并关闭学习页 | `--state-dir <DIR>` |
| `node scripts/chrome-launcher.mjs doctor` | 检查本机 Chrome 与 Node 环境就绪状态 | 无 |

---

## 常见意外与自愈指南

- **中途登录失效**：重新进入广场页面完成扫码或登录后，执行 `node scripts/booster.mjs status` 即可恢复。
- **页面未出题**：若某章节无测验或已完成，`next-quiz` / `step` 会自动识别并跳到下一节，无需人工干预。
- **题目答案未确定**：遇到不熟悉的题目，Agent 结合 web 搜索工具确认关键词，确保 100 分提交以最大化每题积分。
- **换新账号**：直接指定新目录 `--state-dir ./state-user2`，互不影响。
