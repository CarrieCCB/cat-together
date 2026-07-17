# 🐱 线上小猫 · 双人养猫 Web 应用

一个**点开即玩、零输入**的双人实时协作养猫小游戏。两位好友一起照顾同一只**纯 CSS 绘制的二次元橘猫**，从幼猫一路养到大猫～

> 技术栈：**Node.js + Express + Socket.io**，实时同步、可部署到 Render，支持微信内直接打开。

---

## ✨ 核心玩法

| 模块 | 说明 |
| --- | --- |
| 👥 固定双人 | 第一个打开的人自动成为 **用户A🟢**，第二个成为 **用户B🔵**；最多 2 人同时在线，第三人提示"已满员"并断开 |
| 🔁 身份记忆 | 同一设备刷新保持原身份（localStorage 记住 `clientId`），不同设备按连接顺序分配 |
| 🐈 二次元橘猫 | **纯 CSS 绘制**（非 emoji、非图片）：圆脸、尖耳、大眼高光、胡须、粉鼻、金铃铛、虎斑纹、白肚皮、摆动尾巴，坐在猫窝里 |
| 🌱 成长系统 | 5 个阶段（幼猫→小猫→少年→成猫→大猫），按**总互动次数**自动升级，体型 `scale()` 变大，升级弹全屏彩带庆祝 |
| 📊 四项属性 | 饱腹 / 快乐 / 清洁 / 精力（0-100），服务端每 5 秒自动衰减；精力<20 进入睡觉（衰减减半） |
| 😺 表情联动 | 任一属性<20→难过；全部>70→开心；精力<20→睡觉；其余→正常 |
| 🎮 四个操作 | 喂食 / 逗猫 / 洗澡 / 抚摸，每人每操作独立 **8 秒冷却**，配浮动反馈 + 猫咪动画 |
| 📖 喂养记录 | 底部列表倒序展示（最多 100 条），A 绿 / B 蓝 / 里程碑金色加粗 |
| 💾 数据持久化 | 每 30 秒写入 `data.json`，重启自动恢复；两人都离线状态保留 |

### 成长阶段一览

| 阶段 | 互动次数 | 体型 | 初始属性 | 食物 |
| --- | --- | --- | --- | --- |
| 幼猫期 | 0–9 | scale(0.5) | 50 | 猫奶 🍼 |
| 小猫期 | 10–29 | scale(0.7) | 55 | 猫粮 🥣 |
| 少年期 | 30–59 | scale(0.9) | 60 | 猫罐头 🥫 |
| 成猫期 | 60–99 | scale(1.1) | 65 | 三文鱼 🐟 |
| 大猫期 | 100+ | scale(1.3) | 75 | 海鲜大餐 🦐 |

---

## 📁 文件结构

```
cat-app/
├── server.js          # 服务端：状态管理 / 角色分配 / 衰减 / 成长 / 冷却 / 持久化 / socket 广播
├── public/
│   └── index.html     # 前端：纯 CSS 橘猫 + 全部 UI + 动画 + socket 客户端（微信适配）
├── package.json       # 依赖与启动脚本（start / engines）
└── README.md          # 本文档
```
> 运行后会自动生成 `data.json`（状态存档）与 `node_modules/`（依赖），无需手动创建。

---

## 🚀 本地运行

```bash
cd cat-app
npm install
npm start
```

浏览器打开 <http://localhost:3000>。想体验双人效果，用**两个不同浏览器**（或一个正常窗口 + 一个隐身窗口）各打开一次即可分别成为 A、B。

---

## ☁️ 部署到 Render（生成公网链接）

Render 通过 Git 仓库自动构建部署，步骤如下：

1. **推送代码到 GitHub**（仅需 `cat-app` 目录内容，`node_modules`、`data.json` 不必提交）：
   ```bash
   cd cat-app
   git init && git add . && git commit -m "init online-cat"
   # 在 GitHub 新建空仓库后：
   git remote add origin https://github.com/<你的用户名>/online-cat.git
   git push -u origin main
   ```
2. 打开 [Render 控制台](https://dashboard.render.com/) → **New +** → **Web Service** → 关联上一步的 GitHub 仓库。
3. 关键配置（大多会被自动识别）：
   - **Runtime / Environment**：`Node`
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`（即 `node server.js`）
   - **Instance Type**：Free 即可
4. 点击 **Create Web Service**，等待构建完成，Render 会分配一个形如 `https://online-cat-xxxx.onrender.com` 的**公网 HTTPS 链接**。

> 本项目已满足 Render 部署要求：
> - `package.json` 含 `"start": "node server.js"` 与 `"engines": { "node": ">=16.0.0" }`
> - 端口使用 `process.env.PORT`，监听地址 `0.0.0.0`
>
> ⚠️ Render 免费实例的磁盘是**临时的**，重启后 `data.json` 可能被清空；如需长期存档，可在 Render 挂载 **Persistent Disk** 并将数据目录指向该磁盘。

---

## 💬 微信内打开

- 已加入 `viewport`（禁止缩放）与 `apple-mobile-web-app-capable` / `mobile-web-app-capable` 等 meta 标签，适配微信内置浏览器。
- 操作按钮 ≥ 60px，充分适配手指触控。
- 将 Render 生成的公网链接（`https://...onrender.com`）直接发送到微信会话中，点击即可打开开玩，**无需任何输入**。

---

## 🛠 技术要点

- **实时同步**：所有状态变更通过 Socket.io 广播给全部在线用户，两端画面一致。
- **服务端权威**：属性衰减、冷却、升级判定全部在服务端计算，前端仅负责渲染，避免作弊 / 不同步。
- **纯 CSS 猫咪**：橘猫由 `div` + 渐变 + `clip-path` + `border-radius` + `@keyframes` 绘制，表情（开心/正常/难过/睡觉）与动作动画（吃/跳/蹭/抖）通过切换 class 实现。

祝养猫愉快，喵呜~ 🐾
