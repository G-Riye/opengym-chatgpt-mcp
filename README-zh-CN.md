# openGym × ChatGPT 聊天模式双向连接器

> 目标：ChatGPT **聊天窗口**里生成/调整训练计划 → 直接写进本机 openGym；在 openGym 里练完 → ChatGPT 下次对话能读到结果并据此更新建议。
> 全程**不使用 GPT 的 Codex 能力**：走的是 ChatGPT 原生的「自定义 MCP 服务器 / 插件」工具调用，不是 Codex CLI、不是代码代理。

安装位置：`C:\Users\46951\Documents\Codex\2026-10-16\c\outputs\openGym-1.4.1\chatgpt`

---

## 0. 先说结论：调研到的同类方案能不能套用

| 方案 | 能力 | 结论 |
|---|---|---|
| [openGym 官方 `mcp/`](https://github.com/DuarteSantos8/openGym/tree/v1.4.1/mcp) | 只读、stdio、给 Claude Desktop / Cursor 用 | **不能直接给 ChatGPT 用**：ChatGPT 需要远程 HTTPS 的 Streamable HTTP，且官方 MCP 没有写工具 |
| [openGym MCP Bridge（社区）](https://github.com/Nirvana-Z777/opengym-mcp-bridge) | 读写、预览后确认、版本校验、自动备份、Docker、面向 Secure MCP Tunnel | **最接近，可套用**。已借鉴它的「预览 → 确认写入 → 备份 → 版本冲突拒绝」安全模型；但没有直接部署它的 Docker 版：本机没有 Docker，且它的计划字段只覆盖 `sets/reps/weight`，会丢掉你现有计划里的 `mode/time、repsMin、side、bodyweight、assisted、dbLoad、超级组、备注` |
| [GymCoach 的 ChatGPT 接法](https://github.com/julien-au/gymcoach/blob/main/docs/chatgpt-mcp.md) | Streamable HTTP MCP + ChatGPT 开发者模式连接器 + 无认证（令牌放在 URL 里） | **交互方式可套用**：已经按这条路线实现「ChatGPT 连接器 = 私有 URL + 路径令牌」 |
| [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) | 官方出站隧道，本机 MCP 不用暴露公网 | **已留好接入方式**，见 §5.3；需要 OpenAI Platform 组织、Tunnel 权限和 `tunnel-client` |
| 本项目的连接器 | 读计划/历史/体重/1RM、写计划（富字段）、更新游标、预览/确认、Windows 自启 | **已实现并实测**（见 §12） |

因此：**同类方案可以套用，但直接套会丢字段/要 Docker**。这里保留它们的思路，落成一个零依赖、Windows 原生、字段完整的连接器。

---

## 1. 它到底怎么工作

```
┌──────────────────────┐         HTTPS（公网或 Secure Tunnel）        ┌──────────────────────────┐
│  ChatGPT 聊天窗口      │  ───────────────────────────────────────▶  │  chatgpt/src/main.mjs     │
│  （插件 @openGym）     │   工具调用：get_plan / plan_preview ...     │  127.0.0.1:8787/mcp/<token>│
└──────────────────────┘  ◀───────────────────────────────────────  └────────────┬─────────────┘
                                                                                  │ 读：data/state-<uid>.json
                                                                                  │ 写：PUT /api/data
                                                                        ┌─────────▼──────────┐
                                                                        │ openGym API :30347 │
                                                                        │ （现有 Windows 部署）│
                                                                        └────────────────────┘
```

- **读**：直接读 openGym 的 `data/state-<uid>.json`（原子写入，永远是最新），所以不会丢 `mode/repsMin/side/bodyweight` 等字段。
- **写**：走 openGym 自己的 `PUT /api/data`，带 `baseRev/baseWid` 条件写，服务端负责 `_rev/_wid/_ts` 和网页端合并逻辑；写入前自动备份。
- **鉴权**：连接器用 `data/secret` 按 openGym 的 `makeSession()` 同款算法派生一个长期 Bearer 令牌（等价于一台已配对手机），不碰密码/通行密钥。
- **ChatGPT 侧**：URL 里的 64 位令牌就是凭证，连接器认证方式选「无」。

---

## 2. 已实现的工具（12 个）

| 工具 | 作用 |
|---|---|
| `get_status` | 连通性、账号、rev、写入开关、待同步数 |
| `get_training_context` | **主上下文**：档案、体重趋势、全部模板（含组数/次数/重量/休息/备注）、周排期、未来 7 天、最近 5 次训练逐组数据、待同步数 |
| `get_plan` | 只要计划；拿准确的 `routine_id` 和动作下标 |
| `search_exercises` | 中文/英文搜 5,632 个内置动作 + 自定义动作；返回 `exercise_id`、部位、器械、是否自重/助力 |
| `get_exercise_history` | 单个动作的最近训练、最好重量/次数、Epley 估算 1RM |
| `get_results` | 日期区间内的已完成训练，逐组实际重量/次数/RIR/左右侧/组类型（递减组 `drops`、爆发组 `bursts`、`max`），完成率、容量、PR |
| `get_measurements` | 体测：19 个内置围度/体脂 + 自定义项，最新一次、逐项曲线、历史记录 |
| `get_updates` | **只返回上次之后新完成的训练**，并推进游标；对话开始时调用即可「更新到当前对话」 |
| `plan_preview` | 只预览不写入：校验修改、返回中文变更清单 + 15 分钟有效的 `proposal_id` |
| `plan_apply` | 用户确认后写入：必须 `confirmation:"确认写入"`，校验 rev、自动备份、冲突拒绝 |
| `log_bodyweight` | 记录/覆盖某天体重 |
| `reset_updates_cursor` | 维护：重置「已读到哪次训练」 |

计划写入支持的动作：`create_routine`、`update_routine`、`delete_routine`、`set_exercise`、`add/remove/move/replace_exercise`、`set_superset`、`clear_superset`、`assign_weekday`、`override_date`、`set_progression`、`add_bodyweight`。

### 2.1 一个动作能写到多细（1.1.0 起）

openGym 编辑器里能存的字段，MCP 现在都能写、也能读回来：

| 字段 | 含义 |
|---|---|
| `sets` / `reps` / `reps_min` / `reps_max` | 平铺的组数、次数、次数区间 |
| `weight` / `mode` / `seconds` / `rest_sec` | 重量、次数/计时、组间休息 |
| `warmup_sets` / `warmup_rest_sec` | **热身组数（0–5，App 自己递增重量）和热身组间休息** |
| `pyramid` / `pyramid_weight` / `pyramid_rest` | **逐组次数 / 逐组重量 / 逐组休息**，例：`[12,10,8,"max",12]` + `[40,50,60,0,40]` |
| `inc` / `deload_factor` / `backoff` | 进阶加重步长、减载百分比、退让组 |
| `last_to_failure` / `intensifier` | 末组力竭；递减组 `{type:"dropset",count,pct}` / 休息暂停 `{type:"restpause",total_reps,rest_sec}` |
| `progression` | 单个动作覆盖模板的进阶规则（off/linear/greyskull/double/triple/time） |
| `side` / `bodyweight` / `assisted` / `db_load` | 单侧、自重、助力、哑铃「每只/合计」 |
| `note` / 超级组（`sg`/`sgName`/`sgRest`） | 备注、超级组分组与组内休息 |
| `mode:"cardio"` + `minutes` + `speed` + `incline` | **有氧写进计划**：分钟、速度、坡度（坡度只对跑步机/走跑/椭圆等有效） |

**关键**：openGym 里没有「第 1 组 40kg、第 2 组 45kg」这种独立字段，逐组配置就是 `pyramid`
（每组次数）+ `pyramid_weight`（每组重量）+ `pyramid_rest`（每组休息）。给了 `pyramid`，
`sets` 自动等于数组长度、`reps` 自动取第一个数值目标，所以「12/10/8/Max/12」能一比一还原。

### 2.2 三个容易搞混的点（这版之前确实踩过）

**① 热身组数 vs 热身组重量**
`warmup_sets` 是**计划字段**（这个动作要铺几组热身，0–5）。**每组热身用多重不是计划字段**：
openGym 在你开始训练那一刻按正式重量算递增（3 组时 50% / 75% / 87.5%，2 组时 50% / 75%，
且不低于空杆），生成的是**本次训练的行**，不写回计划。所以截图里「热身 1 = 5kg×8、热身 2 = 7.5kg×4」
是 App 按 10kg 工作重量算出来的，MCP 能指定「2 组热身」，不能指定「热身第 1 组 5kg」。

**② 备注（note）**
`get_plan` 和 `get_training_context` **一直返回**每个动作的 `note`（真机实测：25 条）。
1.2.0 起又补齐了两处：训练记录里每个动作自己的 note（以前只带计划目标上的 note）、
`get_exercise_history` 每次训练的 note。如果你问 ChatGPT「备注呢」它说没有，多半是：
- 它调的是 `get_updates`/`get_results` 的旧版本 → 现在也会带；
- 或者上下文太长被模型自己截断了 → 让它直接读某个模板（`get_plan`）再看那一条。

**③ 有氧 + 体测走同一套写入流程**
有氧：`mode:"cardio"`、`minutes`、`speed`（+ `incline`），非有氧动作不能设 cardio。
体测：读用 `get_measurements`；写用 `plan_preview` 里的 `log_measurement`（值用厘米，`bodyFat` 用 %，
自定义项用 `custom:{"左小腿":36}`）或 `set_measurement_fields`（开关字段/新增自定义项），
确认后同样 `plan_apply`，rev 冲突照样拒绝、写前照样备份。

自检：`node scripts/fields-test.mjs`（72 项，纯内存，不写任何数据）、`node scripts/mcp-smoke.mjs`。

### 2.3 读「实际练了什么」：每组都有类型（1.3.0 起）

以前训练记录只有一组 `weight/reps/done`，所以你实际做的**递减组**、**爆发组（休息暂停）**、
**AMRAP 组**、热身组在 MCP 里读出来全是普通组。现在 `get_results` / `get_updates` /
`get_training_context` 返回的每一组是：

```json
{
  "weight": 60, "reps": 16, "done": true, "rir": 1,
  "type": "restpause",
  "bursts": [{ "reps": 10, "rest_sec": 15 }, { "reps": 4, "rest_sec": 15 }, { "reps": 2, "rest_sec": 15 }],
  "burst_reps": 16
}
```

| 字段 | 含义 |
|---|---|
| `type` | `straight` 普通组 / `dropset` 递减组 / `restpause` 休息暂停＝App 里的「爆发组」/ `warmup` 热身 |
| `drops` | `[{weight, reps}]`，主组之后每一档递减 |
| `bursts` / `burst_reps` | 爆发组的每一段（次数 + 秒数）与合计次数 |
| `max` | `true` 表示 AMRAP（「Max」）组 |
| `sides.L` / `sides.R` | 单侧动作左右各自同一套字段 |

两个配套字段：动作上的 `set_summary` 是各类组的计数（`{straight:2, dropset:1, restpause:1, warmup:1, burst_reps:16}`），
`prescribed` 是计划里写的强度技巧（`intensifier` / `warmup_sets`），用来区分「计划是休息暂停」和「实际做了休息暂停」。

**别把爆发组当额外组数**：rest-pause 行的 `reps` 已经是「10+4+2=16」的和，爆发组是拆解，不是加组。
`get_exercise_history` 里每次训练也多给了 `drop_sets`、`rest_pause_sets`、`burst_reps`。

**注意「爆发组」这个词**：openGym 中文界面里的「⚡ + 爆发组」就是 Rest-pause（休息暂停）的 burst，
数据层存成 `type:"restpause"` + `clusters`（MCP 里叫 `bursts`）。计划端写法是
`intensifier: { type:"restpause", total_reps, rest_sec }`，App 开始训练时会按 `10+4+2+1` 这种次序自动拆段。

---

## 3. 快速开始（本机已验证）

### 最省事的四步

1. 双击 `Start.cmd`（启动 openGym + 连接器 + 打开面板）。
2. 双击 `Tunnel-Tailscale.cmd`（稳定公网地址；或先用 `Tunnel-Quick.cmd` 测试）。
3. 双击 `Show-Connection.cmd`，复制 `public :` 那一行的完整 URL。
4. 到 ChatGPT → Plugins → Add custom MCP server，粘贴 URL，认证选「无」。

长期使用再双击 `Install-Autostart.cmd`，以后登录 Windows 就自动全部启动。

### 3.1 启动

```bat
cd /d "C:\Users\46951\Documents\Codex\2026-10-16\c\outputs\openGym-1.4.1\chatgpt"
Start.cmd
```

`Start.cmd` 会：
1. 如果 openGym 没跑，先跑 `windows\Start-openGym.ps1 -NoBrowser`；
2. 启动连接器（`127.0.0.1:8787`）；
3. 打开本机面板（URL 带令牌）。

也可以手动：

```bat
C:\Users\46951\Documents\Codex\2026-10-16\c\outputs\openGym-1.4.1\windows\runtime\node.exe src\main.mjs
```

### 3.2 自检

```bat
C:\Users\46951\Documents\Codex\2026-10-16\c\outputs\openGym-1.4.1\windows\runtime\node.exe src\main.mjs doctor
```

正常会看到：`auth : ok`、`exercises : 5632`、`routines : ...`。

本机面板：`http://127.0.0.1:8787/?token=<secrets\mcp-token 的内容>`
（直接运行 `Start.cmd` 会自动打开。）

### 3.3 给 ChatGPT 一个公网地址

ChatGPT 在云端，**不能访问 `127.0.0.1`**。四种方式，按推荐顺序：

#### A. Tailscale Funnel（推荐，稳定、免费、无需域名）

这台机器已装 Tailscale。运行：

```bat
cd /d "...\openGym-1.4.1\chatgpt"
Tunnel-Tailscale.cmd
```

它按顺序处理两件一次性的事：

1. **登录**：如果 Tailscale 显示 `Logged out` / `NoState`，脚本会启动一个**不会超时**的
   `tailscale up`，把 `https://login.tailscale.com/a/...` 用默认浏览器打开，同时写入
   `store\tailscale-login-url.txt` 并复制到剪贴板；你登录完成后脚本会**自动继续**（不会让你重跑）。
2. **启用 Funnel**：如果 tailnet 还没开 Funnel，脚本会打印并打开
   `https://login.tailscale.com/f/funnel?node=...`，你点 **Enable Funnel**，脚本会自己重试到成功。

成功后它会：

1. 确认 Tailscale 是 Running；
2. 确保 MagicDNS / HTTPS 可用；
3. `tailscale funnel --bg 8787`；
4. 写出 `https://<节点名>.<tailnet>.ts.net/mcp/<token>`，并保存到 `store\public-url.txt`。

停止：`Tunnel-Stop.cmd` 或 `scripts\tunnel.ps1 -Mode stop`。
重新登录（换账号/被踢出）：`scripts\tunnel.ps1 -Mode tailscale -Reauth`。

**本机 2026-10-27 实测可用地址：**

```text
https://riye-pc.tail86ab0.ts.net/mcp/f3657e40f36d948071b4993e2c5705a80de72261b4072fdf92e26b1eba8ecaea
```

随时用 `Show-Connection.cmd` 打印当前地址（没有公网地址时它会提示先开隧道）。

> 重新登录后节点名可能从 `riye-pc` 变成 `riye-pc-1`，Funnel 也可能要重新 Enable；一切以脚本输出为准。
> Funnel 是公网入口，但 URL 里带 64 位令牌；不知道令牌只能拿到 401。

**两个容易误判的坑（都踩过）：**

- **`tailscale up --timeout=20s` 会取消登录**：CLI 超时退出后，你再去点那个登录链接，
  tailscaled 那边已经不认了，于是“明明登录成功但一直是 Logged out”。脚本已去掉 `--timeout`。
- **本机浏览器打不开 `https://riye-pc.tail86ab0.ts.net` 不代表隧道坏了**：这台机器开着
  Clash Verge（TUN + fake-ip），`ts.net` 会被解析成 `198.18.x.x` 走进代理，TLS 握手必失败；
  公开 DNS 查询还会被劫持成同一个假 IP。验证要用真实入口 IP：

  ```powershell
  curl.exe -sS --resolve riye-pc.tail86ab0.ts.net:443:208.111.34.11 `
    https://riye-pc.tail86ab0.ts.net/healthz
  ```

  手机蜂窝网络、ChatGPT 服务器走的是正常 DNS，不受影响。
- 托盘图标：`Tunnel-Tailscale.cmd` 会顺带拉起 `tailscale-ipn.exe`（Tailscale 的托盘程序），
  并且已经写进 `HKCU\...\Run`，下次登录自动出现。没有托盘图标 ≠ Tailscale 没在跑。

#### A2. 手机在 5G 上直接打开 openGym（手机不装 VPN）

iPhone 同时只能开一个 VPN。ChatGPT App 需要代理 VPN，所以手机端**不能**再跑 Tailscale；
openGym App 必须用「完全不依赖 VPN」的公网地址。做法是再把 PWA 自己发布到第二个 Funnel 端口：

```text
https://riye-pc.tail86ab0.ts.net:8443/    ← openGym App 本体（公网、带令牌）
https://riye-pc.tail86ab0.ts.net/         ← ChatGPT 连接器（只有 MCP）
```

- **第一次打开要带令牌**（`secrets/app-token`）：
  `https://riye-pc.tail86ab0.ts.net:8443/?t=<64位令牌>`，打开一次就写成 HttpOnly Cookie，
  之后直接进，可以「添加到主屏幕」当 App 用。
- 最快的方式：电脑上双击 [`App-QR.cmd`](<App-QR.cmd>)，扫二维码即可（含令牌，等同密码，别外传）。
- 想换令牌：删掉 `chatgpt\secrets\app-token`，运行 `Stop.cmd` 再 `Start.cmd`（新令牌自动生成），
  然后重新 `Tunnel-Tailscale.cmd` + `App-QR.cmd`。
- 没令牌时公网只看到一个「需要访问令牌」页面，拿到令牌才能进 openGym 自身的登录。

为什么不是把 LAN 地址映射出去：openGym 用内部 CA 的 HTTPS 且 `RP_ID = 192.168.50.47`，
所以公网入口只能换域名 + 自己代理一份明文 HTTP 给 Funnel。实现见 `src/app-proxy.mjs`
（只监听 `127.0.0.1:8081`，代理 `/api/*`、`/exercise-media/*` 和 `frontend/dist`，不额外暴露端口）。

已知限制：走 `*.ts.net:8443` 时**通行密钥（passkey）不可用**（WebAuthn 的 RP ID 绑的是 LAN IP），
用密码登录即可；家里用 `https://192.168.50.47:8443` 一切照旧。

#### B. Cloudflare Named Tunnel（有域名时最稳）

```powershell
# 一次性
chatgpt\tools\cloudflared.exe tunnel login
chatgpt\tools\cloudflared.exe tunnel create opengym
chatgpt\tools\cloudflared.exe tunnel route dns opengym gym.example.com

# 每次启动
powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Mode named -Name opengym -PublicUrl https://gym.example.com
```

#### C. OpenAI Secure MCP Tunnel（不暴露公网，最安全）

适合有 OpenAI Platform 组织/工作区权限的账号：

1. Platform → **Tunnels** → 新建 tunnel，拿到 `tunnel_id` 和 runtime API key；
2. 下载 `tunnel-client`（[openai/tunnel-client](https://github.com/openai/tunnel-client/releases)）；
3. 让它指向本机 HTTP MCP：

```powershell
tunnel-client init --tunnel-id <tunnel_id> `
  --mcp-server-url "http://127.0.0.1:8787/mcp/<secrets\mcp-token 的内容>" `
  --profile opengym
tunnel-client doctor --profile opengym --explain
tunnel-client run --profile opengym
```

4. ChatGPT → Plugins → Add custom MCP server → Connection 选 **Tunnel** → 选这个 tunnel。

> 官方要求：创建/编辑 tunnel 需要 `Tunnels Read + Manage`；运行/在 ChatGPT 里选用需要 `Tunnels Read + Use`；还要把 tunnel 关联到你的 ChatGPT workspace。详见[官方文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

#### D. Cloudflare Quick Tunnel（只用于当场测试）

```bat
powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Mode quick
```

会下载便携版 `cloudflared.exe`，给出一个 `https://xxx.trycloudflare.com` 地址。
**每次重启都会换 URL**，只适合验证连通性，不适合长期用。

---

## 4. 在 ChatGPT 里配置

> UI 名称会随账号/版本略有差异；看到 **Plugins / 插件 / 连接器 / Developer mode** 都是同一件事。

1. 确认账号是 **Plus / Pro / Business / Enterprise / Education**（自定义 MCP 服务器需要开发者模式能力）。
2. 打开 **ChatGPT → Plugins（插件）→ 加号 → Add custom MCP server（添加自定义 MCP 服务器）**。
3. 填写：
   - **Name**：`openGym 教练`
   - **Description**：`读取我的 openGym 计划和训练记录，并在确认后写入新计划`
   - **Connection**：`Public endpoint`（公网 HTTPS）→ 粘贴  
     `https://<你的公网地址>/mcp/<64位令牌>`
   - **Authentication**：`No authentication`（无身份验证）
     —— 令牌已经在路径里，64 位随机值本身就是凭证。
     - 如果这个版本的 UI 没有「无」，就选 **API key / Bearer**，把同一个令牌填进去；服务端同时接受 `Authorization: Bearer <token>`。
     - 如果连接器只接受以 `/mcp` 结尾的地址，可以用 `https://<公网地址>/mcp?token=<64位令牌>`，效果一样。
4. 勾选风险提示 → **Create as a plugin**。
5. 新开对话，输入 `@`，选择 `openGym 教练`，然后说：
   - `先读一下我的训练情况`
   - `给我做一个 4 天上下肢分化，写进 Gym`
   - `我今天练完了，看看怎么样`

如果找不到入口：**Settings → Connectors → Advanced → Developer mode**，或直接问 ChatGPT「如何添加自定义 MCP 服务器」。

---

## 5. 开机自启（电脑开着就可用）

```bat
cd /d "...\openGym-1.4.1\chatgpt"
Install-Autostart.cmd
```

本机实测：计划任务被系统拒绝（需要管理员），脚本自动退回**启动文件夹**方案：
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\openGym-ChatGPT.vbs`

登录 Windows 后会自动：
1. 启动 openGym（如果没跑）；
2. 启动连接器；
3. 按 `store\tunnel-mode.txt` 里保存的方式启动隧道（quick / named / tailscale）。

日志：`chatgpt\logs\autostart.log`。

卸载自启：

```bat
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
```

> 注意：这是「登录后」启动，不是「开机未登录」启动。重启后登录一次即可；锁屏不影响。
> 如果希望合盖也不睡：`powercfg /change standby-timeout-ac 0`（按需）。

---

## 6. 在 ChatGPT 里怎么用（示例）

### 6.1 生成计划并写入

你：
> 根据我最近 4 周的训练，给我做一个 4 天上下肢分化，周一/二/四/五练，直接写进 Gym。每个动作给组数、次数、重量和休息。

ChatGPT 会：
1. `get_training_context` + `search_exercises` + `get_exercise_history`；
2. `plan_preview`，把变更清单原样给你看；
3. 问「确认写入吗？」；
4. 你说「确认」→ `plan_apply`；
5. 告诉你刷新 App 查看。

> 这是**两步**：预览 + 确认。这是故意的安全设计；不会出现模型擅自改计划。

### 6.2 练完后更新到对话

你：
> 我练完了，看看今天。

ChatGPT：
1. `get_updates` 只拉上次之后新完成的训练；
2. 复述实际组数/重量/完成率；
3. 对照原计划给下一场建议，必要时 `plan_preview` 调整下一次。

### 6.3 其他常用说法

- `把周三改成休息日` → `override_date`
- `以后周二固定成 Pull` → `assign_weekday`
- `卧推下次加到 65kg` → `set_exercise`
- `上周总容量多少` → `get_results`
- `我体重 78.5，记一下` → `log_bodyweight`
- `把这个模板删掉` → `delete_routine`

---

## 7. 「训练完自动更新到对话」的边界（重要）

ChatGPT **不能**像微信一样往一个已有对话里主动推送消息。能做到的是：

1. **对话开始时自动拉**：连接器在 `initialize.instructions` 里要求模型「每个新对话/用户说练完时先调 `get_updates`」。大多数情况下模型会照做。
2. **一句话触发**：你发「更新一下 / 我练完了」，必定触发 `get_updates`。
3. **ChatGPT 定时任务（Tasks）**：如果你的账号有 Tasks 且允许任务使用插件，可以建一个每天 21:30 的任务：「读取 openGym 最近训练并总结」。是否可选到插件取决于账号灰度。
4. **浏览器扩展注入**（未实现）：技术上可以在 ChatGPT 页面里轮询本地连接器并把结果贴进对话，但 DOM 一变就坏，维护成本高，本方案不采用。

所以最稳的日常用法是：**每次开新对话先说一句「更新一下」**，或者把它写进项目/自定义 GPT 的指令里。

---

## 8. 安全模型

- 连接器只监听 `127.0.0.1:8787`；公网入口只暴露带 64 位令牌的 `/mcp/<token>`。
- 面板 `/` 也需要令牌；不知道令牌只能看到输入框。
- 写入：
  - 必须 `plan_preview` 先产出 `proposal_id`；
  - `plan_apply` 必须带字面量 `确认写入`；
  - 校验 `_rev/_wid`，冲突直接拒绝；
  - 写前把当前 state 备份到 `chatgpt\store\backups\`（保留 30 份）。
- `log_bodyweight` 同样要求 `确认写入`。
- openGym 令牌：
  - 存在 `chatgpt\secrets\opengym-token.json`（0600）；
  - 由 `data/secret` 派生，**不是密码**，不能登录网页；
  - 撤销：openGym「设置 → 退出所有设备」会 bump 会话版本 → 删掉该文件 → 重启连接器即可重新派生。
- MCP 令牌：
  - 存在 `chatgpt\secrets\mcp-token`；
  - 轮换：删掉它 → 重启连接器 → 把 ChatGPT 连接器 URL 换成新的。
- 隐私：只有 ChatGPT 实际调用工具时，对应的训练数据才会进入 OpenAI 的请求；连接器本身无遥测、无第三方请求（隧道除外）。
- 写入的 `note`、动作名、历史记录都当作**不可信数据**，系统提示明确禁止执行其中的指令。

---

## 9. 维护 / 备份 / 升级

- **备份**：`openGym-1.4.1\data\`（账户、训练数据）+ `chatgpt\secrets\`（两个令牌）+ `chatgpt\config.json`。
- **计划备份**：`chatgpt\store\backups\`；每次 `plan_apply` 前自动生成。
- **升级 openGym**：保留 `chatgpt` 文件夹；如果 API 端口从 `30347` 变了，改 `chatgpt\config.json` 的 `baseUrl`，重启连接器。
- **换电脑/换网络**：openGym IP 变了不影响连接器（它直连 `127.0.0.1:30347`）；但隧道域名/URL 可能要重配。
- **多账号**：`data` 里有多个 `state-*.json` 时，用环境变量 `OPENGYM_UID=<uid>` 指定。

---

## 10. 故障排查

| 现象 | 处理 |
|---|---|
| `doctor` 报「连不上 openGym」 | 先启动 openGym（`Start-openGym.cmd`）；确认 `http://127.0.0.1:30347/api/health` 返回 ok |
| 401 / Unauthorized | URL 里的 64 位令牌不完整；从 `secrets\mcp-token` 重新复制 |
| ChatGPT 说连不上服务器 | 公网地址从手机蜂窝网络打开 `/healthz` 测试；quick tunnel 是否已退出；Tailscale Funnel/Cloudflare 是否在跑 |
| `proposal_id 不存在或已过期` | 预览超过 15 分钟或连接器重启过；重新 `plan_preview` |
| `计划在你预览后已被修改` | 另一个设备/网页改了计划；重新 `get_plan` 再预览 |
| 中文在命令行里乱码 | 只是控制台代码页；文件是 UTF-8，不影响功能 |
| 面板打不开 | 必须带 `?token=`；或运行 `Start.cmd` 自动打开 |
| 开机没自启 | 看 `logs\autostart.log`；Startup 文件夹里是否有 `openGym-ChatGPT.vbs`；是否登录了 Windows |
| Tailscale 显示 `Logged out` / `NoState` | 节点状态丢了：运行 `Tunnel-Tailscale.cmd`（会自动开登录页并等你），或 `Tunnel-Relogin.cmd` 强制重新登录 |
| 登录页明明登录成功，状态还是 `Logged out` | 旧脚本用 `tailscale up --timeout=20s`，CLI 超时退出会取消登录；已改为不超时。用 `Tunnel-Relogin.cmd` 重来一次 |
| 浏览器打不开 `https://xxx.ts.net` | 本机 Clash Verge 的 fake-ip 把 `ts.net` 解析成 `198.18.x.x`，是本地代理问题，不是隧道坏了；用 `--resolve` 指真实入口 IP 验证，见 3.3 |
| 托盘里没有 Tailscale 图标 | 托盘程序 `tailscale-ipn.exe` 没启动；`Tunnel-Tailscale.cmd` 会拉起它，也已加入 `HKCU\...\Run` |
| 登录后 openGym 没起来 | 早期版本 `Start-Gym-AI.ps1` 少算了一层目录（已修复）；看 `autostart.log` 是否有 `openGym is not running`，也可直接运行 `Start.cmd` |
| 手机打开 `:8443` 只看到「需要访问令牌」 | 用带 `?t=` 的完整链接（`App-QR.cmd` 扫码），令牌在 `secrets\app-token` |
| 扫码后仍然反复要令牌 | 无痕/私密浏览不保存 Cookie；Safari 设置里关掉「阻止所有 Cookie」；iCloud 私密代理一般不影响 |
| `:8443` 502 / 打不开 | 先确认 `http://127.0.0.1:8081/__healthz` 正常；`Stop.cmd` 后 `Start.cmd` 会拉起 App 代理；再 `Tunnel-Tailscale.cmd` |
| 家里 LAN 打开 `192.168.50.47:8443` 需要令牌吗 | 不需要，那是 Caddy 直连；令牌只加在公网 `:8443` 这一层 |
| 想临时关掉 | `Stop.cmd`；只关隧道：`scripts\tunnel.ps1 -Mode stop` |

---

## 11. 文件清单

```
chatgpt\
  Start.cmd                 启动 openGym + 连接器 + 打开面板
  Stop.cmd                  停止连接器/隧道
  Install-Autostart.cmd     安装登录自启
  Tunnel-Tailscale.cmd      稳定隧道（推荐）
  Tunnel-Relogin.cmd        强制重新登录 Tailscale（换账号/被踢出时用）
  Tunnel-Quick.cmd          临时隧道（测试用，URL 会变）
  Tunnel-Stop.cmd           关闭隧道
  Show-Connection.cmd        打印本机/公网 MCP 地址与令牌（含 App 地址）
  App-QR.cmd                生成手机扫码用的二维码（含 App 令牌）
  config.example.json       配置模板（端口/baseUrl/时区/写入开关）
  src\
    main.mjs                入口（start / doctor / test / token）
    server.mjs              MCP Streamable HTTP + 面板 + 认证
    app-proxy.mjs           把 openGym PWA 发布到 127.0.0.1:8081 给 Funnel（令牌 Cookie 保护）
    tools.mjs               11 个工具的定义与描述
    state.mjs               读模型（计划/训练/历史/体重/更新游标）
    plan.mjs                计划修改校验、预览、写入、备份
    exercises.mjs           5,632 个动作 + 中文别名搜索
    opengym.mjs             openGym API 客户端 + 令牌派生
    config.mjs              路径/环境配置
  scripts\
    tunnel.ps1              quick / named / tailscale / secure / stop / status
    Start-Gym-AI.ps1        自启主编排（openGym + 连接器 + App 代理）
    install-autostart.ps1   计划任务，失败退回启动文件夹
    Stop-Gym-AI.ps1         停止
    make-app-qr.mjs         生成 store\app-qr.png
    mcp-smoke.mjs           MCP 协议自检（只读 + 预览）
    write-test.mjs          写入自检（只能对临时副本跑）
  secrets\                  运行后生成（不要提交/外传）
    mcp-token               ChatGPT 连接令牌
    app-token               openGym App 公网访问令牌（Cookie）
    opengym-token.json      openGym Bearer 令牌
  store\
    updates.json            「读到哪次训练」游标
    backups\                写计划前自动备份（30 份）
    public-url.txt          当前公网地址（隧道脚本写入）
    app-url.txt             openGym App 公网地址（:8443）
    app-qr.png              手机扫码图
    tunnel-mode.txt         当前隧道方式
  logs\                     connector / tunnel / app-proxy / autostart 日志
  GPT-INSTRUCTIONS.md       可直接粘贴到项目/自定义 GPT 的指令
```

---

## 12. 已验证（本机实测）

- `doctor`：读取到账号 `日夜`、rev 80、2 个模板、5,632 个动作；`/api/me` Bearer 校验通过。
- MCP：`initialize`、`tools/list`（11）、`get_status`、`get_training_context`（约 16 KB）、`search_exercises("卧推")`、`get_updates` 全部通过。
- 鉴权：无令牌 401；路径令牌 200。
- 公网：Cloudflare Quick Tunnel 临时地址实测 `/healthz` 200、无令牌 401、`initialize` 200；通过隧道调用 `get_training_context` 返回 34 KB 中文数据正常；测试后已关闭。
- Tailscale：已登录（`riye-pc`，账号 `qq469510353@`），Funnel 已启用，公网入口 IP `208.111.34.11 / 208.111.35.209`。
- 公网连接器：`https://riye-pc.tail86ab0.ts.net/healthz` 200，`initialize` / `tools/list`（11）/ `get_status` / `get_updates` 全部通过（用 `--resolve` 绕过本机 Clash 的 fake-ip 验证）。
- 公网 openGym App：`https://riye-pc.tail86ab0.ts.net:8443/` 无令牌 401、带 `?t=` 302 + `Set-Cookie`、带 Cookie 后首页/manifest/sw.js/`/api/health` 全 200。
- 冷启动：停掉 openGym + 连接器 + App 代理后，用 Startup 的 VBS 拉起，约 15 秒内三者健康、两个 Funnel 都在线。
- 写入：在**临时复制的 data 副本**上跑通「新建模板（含周排期、备注、dbLoad）→ 改名 → 改组数/重量 → 删除」，并验证字段原样保留；**真实 `data` 未被修改**（rev 仍 80，模板仍 2 个）。
- 更新：把游标归零后 `get_updates` 返回 2026-10-17 的训练（19 组），第二次调用返回 0。

已知限制：

- ChatGPT 的插件/MCP 能力按账号灰度，入口名称可能不同；没有该能力的账号无法使用本方案（可退回 openGym 自带 AI Coach 或 Claude Desktop + 官方只读 MCP）。
- 公网 URL 必须由隧道提供；quick tunnel 每次换地址。
- 公网 App 入口用 `*.ts.net:8443` 时 passkey 不可用（RP ID 绑 LAN IP），用密码登录。
- 训练时的心率/动作视频等媒体不在本连接器范围；只读写结构化训练数据。
- `set_superset` 只处理同一模板内的连续/非连续动作分组；跨模板超级组不在 openGym 原生模型内。
- 有氧动作（`bp=cardio`）不允许写进计划（openGym 的有氧记录模型是 `min/speed`，与力量组不同），请直接在 App 里记录。

---

## 13. 参考

- [openGym 1.4.1](https://github.com/DuarteSantos8/openGym/releases/tag/v1.4.1) / [官方 MCP（只读）](https://github.com/DuarteSantos8/openGym/tree/v1.4.1/mcp)
- [openGym MCP Bridge](https://github.com/Nirvana-Z777/opengym-mcp-bridge)
- [GymCoach：ChatGPT + MCP](https://github.com/julien-au/gymcoach/blob/main/docs/chatgpt-mcp.md)
- [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [OpenAI：Connect and test your plugin / custom MCP server](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [OpenAI：MCP and connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

---

## 14. 一句话总结

**能实现，而且已经在这台机器上跑通**：ChatGPT 聊天窗口通过一个带令牌的本机 MCP 连接器读写 openGym；计划写入必须「预览 → 确认」；训练完成后在对话里说「更新一下」（或新对话自动触发）就能读到结果；配合隧道和登录自启，电脑开着就能用。
