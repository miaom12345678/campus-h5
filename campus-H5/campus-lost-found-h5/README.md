# 校园失物招领 H5 版（uni-app/Taro 风格 dist + Vercel Serverless）

原项目是**原生微信小程序**（无法直接编译成 H5），本项目将其完整迁移为 **H5 网站**，并把 7 个微信云函数改写为 **Vercel Serverless API**，前后端已打通，可直接部署到 Vercel。

## 功能对照

| 小程序页面 | H5 路由 | 说明 |
|---|---|---|
| pages/index（广场） | `#/` | 搜索 + 类别/校区/位置/颜色筛选 + 分页列表 |
| pages/publish（发布） | `#/publish` | 失物/招领表单、地点多选、时间段、证件号隐私、图片压缩上传（base64） |
| pages/message（消息） | `#/message` | 匹配提醒 / 认领申请 / 处理结果，红点未读数 |
| pages/mine（我的） | `#/mine` | 积分卡片、我的帖子、收到/发出的申请、通知设置、积分补发 |
| pages/detail（详情） | `#/detail?id=xxx` | 认领申请、结束帖子、联系方式解锁 |
| pages/coupon（餐券） | `#/coupon` | 积分兑换餐券、核销码生成与核销 |

后端接口（`api/handler.js`，catch-all）完整复刻了 `searchPosts / publishPost / getMessages / claimPost / reward / seedDemo` 的逻辑，匹配打分引擎 `match.js` 与小程序端**逐字一致**（类别 30 + 颜色 15 + 地点 20 + 时间 15 + 描述 20，阈值 60）。

用户身份：微信 openid 在 H5 中不存在，改为浏览器 `localStorage` 生成的随机 uid，通过请求头 `x-user-id` 传给后端（演示级方案）。

## 本地运行

```bash
cd campus-lost-found-h5
npm run dev          # 零依赖，Node >= 18
# 打开 http://localhost:3000
```

数据落盘到 `.data/db.json`；首次打开会自动灌入演示数据（含匹配提醒、待处理认领、3 积分与 2 张餐券），换浏览器身份即换"用户"。

## 部署到 Vercel

1. 把 `campus-lost-found-h5` 目录推到 GitHub 仓库
2. [vercel.com/new](https://vercel.com/new) 导入该仓库，直接 Deploy（零构建、零依赖，静态站 + Serverless 自动识别）
3. **打通持久化数据（重要）**：Serverless 实例的内存/文件不持久，需要配一个 Vercel KV（底层 Upstash Redis）：
   - Vercel 项目 → Storage → Create Database → **KV (Upstash)**，创建后点 **Connect to Project**，环境变量 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 会自动注入
   - 重新部署一次即可。后端检测到这组变量就自动把数据存进 Redis（见 `api/_lib/store.js`）
   - 不配置也能跑，但每次冷启动数据会清空（仅适合临时演示）

## 目录结构

```
campus-lost-found-h5/
├── api/
│   ├── handler.js        # 全部后端逻辑（原 7 个云函数）
│   └── _lib/
│       ├── match.js      # 匹配打分引擎（与小程序 utils/match.js 一致）
│       └── store.js      # 数据层：Vercel KV / 本地 JSON / 内存 三模式
├── public/               # H5 前端（编译产物风格，可直接静态托管）
│   ├── index.html
│   ├── css/app.css
│   └── js/{app.js, api.js, util.js, categories.js}
├── dev-server.mjs        # 本地开发服务器（npm run dev）
├── vercel.json           # /api/* 路由重写
└── package.json
```

## 后端接口一览

`POST/GET /api/<name>`，需带请求头 `x-user-id: <uid>`：

```
login · unread-count · messages · message-read · message-read-post · message-read-all · profile
search · post-detail · publish
claim-create · claim-accept · claim-reject · close-post · my-posts · incoming · outgoing · repair-points
reward-summary · reward-coupons · reward-exchange · reward-verify · reward-grant
seed · clear
```
