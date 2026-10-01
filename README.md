# 电影取景灵感库（Film Location Inspiration Library）

> 收藏现实中发现的光线、建筑、色彩与构图，**并记下它什么时候、什么天气下才会再出现**。

这不是壁纸收藏夹，也不是地图打卡应用。它回答的是同一个问题的两头：

- **"我当时看到的那束光，是什么条件？"** —— 时间锚（相对太阳事件）+ 光位方位角 + 天气画像 + 机位朝向。
- **"我这周末能不能拍到它？"** —— 未来 7 天逐日窗口判定，**每条判定都给出可复算的理由**。

---

## 快速开始

```bash
# 0. 前置：Node.js ≥ 20（本项目在 Node 24 上验证通过）
node -v

# 1. 安装依赖（npm workspaces 会装上全部子包）
npm install

# 2. 环境变量（默认值即可直接运行）
cp .env.example .env

# 3. 建表 + 写入字典基线（四域标签 158 个；**不含任何虚构业务数据**）
npm run db:migrate
npm run db:seed

# 4. 同时启动前后端（server: 3000，web: 5173）
npm run dev

# 5. 打开 http://localhost:5173 ，注册第一个账号（自动成为库 owner）
```

### 生产模式（后端同端口托管前端产物）

```bash
npm run build      # 构建前端到 apps/web/dist
npm start          # 后端 3000 端口同时托管前端，SPA fallback 已配置
```

---

## 验证（这三条命令就是"真的能跑"的证明）

```bash
npm test                        # 76 个自动化测试：天文 / 几何 / geohash / 窗口判定 / API 闭环
npm run smoke                   # 69 项真实 HTTP 断言（需先启动服务端）
npm run test:e2e                # 2 个真实浏览器闭环用例（需先 npm run build && npm start）
```

`npm run test:e2e` 首次运行需要装浏览器：

```bash
npx playwright install chromium
```

---

## 发布质量门禁

四道门禁**按序自动执行，任一失败即阻断产物**（快速失败，后续门禁不再运行）：

| # | 门禁 | 命令 | 验证内容 |
| --- | --- | --- | --- |
| 1 | 类型检查 | `npm run typecheck` | shared / server / web 三个工作区 `tsc --noEmit` |
| 2 | 迁移回放 | `npm run db:replay` | 全新临时库重放全部迁移与基线种子：顺序、幂等、`_migration` 账本一致、35 张关键表、外键完整性、零业务数据（共 10 项检查） |
| 3 | 接口契约 | `npm test` + 真实 HTTP 冒烟 | 76 个 vitest 契约/单元测试；再用临时库+临时端口启动真实服务端跑 68 项 HTTP 断言 |
| 4 | 前端构建 | `npm run build` | `tsc --noEmit && vite build`，并校验 `dist` 非空 |

```bash
npm run release         # 完整发布：门禁全过才产出 release/flil-<版本>-<构建号>.tar.gz
npm run release:check   # 只跑门禁不出产物（PR / 推送检查）
npm run release:verify  # 复核产物 sha256 与发布清单一致（可独立复算）
```

**可追溯**：每次运行（无论成败）都在 `release/` 下留痕——

```
release/
├── manifest-<构建号>.json    # 版本、环境、各门禁耗时/退出码、迁移与产物 sha256
├── checklist-<构建号>.md     # 人可读的校验清单
├── logs/<构建号>/            # 每道门禁的完整日志
├── history.jsonl             # 全部发布历史的审计流水（含失败记录）
└── latest.json               # 最近一次成功发布的指针
```

CI 已内置同一套门禁（`.github/workflows/quality-gate.yml`）：推送/PR 跑 `release:check`，打 `v*` 标签跑完整 `release` 并上传产物。

---

## 它到底做了什么（核心闭环）

```
①发现 → ②采集 → ③四域打标 → ④定条件 → ⑤算窗口 → ⑥提醒 → ⑦出发 → ⑧回填 → ⑨校准
 现实    拍/上传   光线/场景   时间锚+光位   可拍判定   待办    出行计划   命中度   影响下一轮
                   色彩/构图  +天气画像                                          ▲
                                                                                 └── 反哺
```

几处**别处没有**的设计：

| 设计 | 为什么这么做 |
| --- | --- |
| **时间锚不用钟点，用太阳事件** | 固定钟点会随季节漂移。"下午四点半那种光"的真实含义是"日落前约 40 分钟、仰角 8°"。所以你设的是 `sunset_minus + 40`，系统每天算出今天对应几点。 |
| **光位 → 方位角约束** | 你在图上画一个光位箭头，加上机位朝向，系统就能算出"太阳必须出现在哪个方位"，从而判断另一天的光位对不对。 |
| **判定必须给理由** | 每条窗口都输出"云量 62%（目标 20%–50%）"这样的实际值 vs 目标值，可人工复算。 |
| **硬性项 vs 软性项** | 降水概率超限 = 不可拍（bad）；云量偏差 = 勉强（marginal）。不会因为一点云就把机会判死。 |
| **回填反哺判断** | 连续 3 次同因（天气不符/时间差了）未命中 → 系统自动收紧方位角容差或云量区间，并留下**可撤销**的校准记录。 |
| **地点模糊化不是"打个码"** | 用 geohash 网格中心做稳定输出（不是随机抖动——随机值可被多次请求平均反推）；`exact`/`g100` 在服务端被**强制降级**为 500m，不靠前端隐藏。 |
| **画册有缺口清单** | 画册不是文件夹：定主题 → 系统算出"还差什么" → 每条缺口给一键动作 → 必需缺口不闭合则**发布被拒（409）**。 |

---

## 目录结构

```
origin/
├── packages/shared/          # 前后端共享：枚举、类型、zod schema、天文/几何/geohash 纯函数
│   └── src/astro.ts          #   ↑ 自研太阳位置算法（无三方天文库）
├── apps/server/              # Node.js + Express + better-sqlite3 + sharp
│   ├── sql/0001_init.sql     # 建表 SQL（可读、可 diff）
│   └── src/
│       ├── services/         # 全部闭环逻辑集中在这里
│       │   ├── windowEngine.ts   # 窗口计算与判定理由
│       │   ├── weather.ts        # Open-Meteo 取数 + 缓存 + 降级 + 气候基线
│       │   ├── fuzzing.ts        # 地点模糊化（geohash 网格中心）
│       │   ├── calibration.ts    # 回填校准与收窄
│       │   ├── reminders.ts      # 9 条提醒规则 + 终态保证
│       │   ├── albums.ts         # 画册匹配 / 缺口 / 发布快照
│       │   └── serialization.ts  # ★ 精确坐标的唯一出口
│       └── routes/           # 8 个路由模块，约 70 个端点
└── apps/web/                 # React 18 + Vite + TypeScript + Ant Design
    ├── src/components/       # TagPicker / AnnotationEditor(Canvas 标注) / TimingEditor /
    │                         # WindowList / MapCanvas(自绘可换瓦片源) / ResultForm
    └── src/routes/           # 今日 / 收件箱 / 灵感卡 / 检索 / 计划 / 画册 / 地点 / 设置 / 分享页
```

---

## 外部依赖

只有一个可选的外部数据源，**完全免费、无需 API Key**：

- 天气与气候基线：Open-Meteo（`WEATHER_PROVIDER=open-meteo`）
- 地图瓦片：默认 OpenStreetMap，可通过 `VITE_MAP_TILE_URL` 换成自建或国内瓦片源

断网也能用：把 `WEATHER_PROVIDER=off` 打开降级模式，窗口判定只走天文条件并**明确标注"未含天气"**，最高只能判到"勉强"；地图退化为经纬网格。

---

## 数据与隐私

- 精确坐标**只存在你本机**（SQLite 的 `spot.lat/lng`），且只有 owner 能看到。
- 图片的 EXIF GPS **默认不入库**，只记录"这张图含 GPS"的标记位并提示你。
- 分享链接必带过期时间，可设密码，可随时撤销（**撤销即时生效**，图片令牌同步失效）。
- 分享图会另存一份并剥离全部 EXIF；分享页不展示距离向量，避免三角定位。
- 备份：`npm run backup`（SQLite 快照 + 图片目录），保留最近 14 份；还原前会自动备份当前状态。

---

## 环境变量

见 `.env.example`。最常改的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 后端端口 |
| `DATABASE_URL` | `./data/app.db` | SQLite 文件 |
| `WEATHER_PROVIDER` | `open-meteo` | 可设为 `off`（纯天文降级）或 `fixture`（自动化测试用） |
| `VITE_MAP_TILE_URL` / `MAP_TILE_URL` | OSM | 瓦片源模板 |
| `DEFAULT_FUZZ_LEVEL` | `g500` | 对外默认模糊级别（不允许设为精确） |
| `WINDOW_FORECAST_DAYS` | `7` | 窗口预计算天数 |

---

## 常见问题

**端口被占用？** 改 `.env` 里的 `PORT`，并用 `VITE_API_TARGET` 指向新的后端地址。

**窗口全是"不可拍"？** 先看理由里是哪一项卡住了（多半是降水概率或方位角）。编辑器里有"可满足性检查"，会直接告诉你未来 7 天有多少天在理论上可能成立，并建议放宽哪一项。

**地图不显示街道？** 未配置瓦片源时只会画经纬网格；在 `.env` 里填 `VITE_MAP_TILE_URL` 即可（自建瓦片也可以用）。

**天气源连不上？** 会自动降级：判定标注"未含天气"，并且最高只到"勉强"，不会假装能拍。

---

## 文档

完整的需求与设计基线见仓库上一级的 `项目文档.md`，其中第 22 章是这份代码的实现记录（含实现中发现并修复的真实缺陷）。
