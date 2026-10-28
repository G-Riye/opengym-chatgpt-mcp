# 本机部署记录（模板）

复制成 `personal/DEPLOY-zh-CN.md` 再填写真实值。`personal/` 已加入 `.gitignore`，**永远不会提交**；
提交前 guard（`.githooks/pre-commit` + `scripts/check-personal.mjs`）会拦截误加进来的域名、局域网地址、
隧道 UUID 或令牌。公开文档里只写 `<your-domain>`、`<lan-ip>`、`<token>` 这样的占位符。

## 地址

- 公网 App / PWA：`https://gym.<your-domain>`
  - 首次打开：`https://gym.<your-domain>/?t=<chatgpt/secrets/app-token 的内容>`
- 公网 MCP 连接器：`https://mcp.<your-domain>`
  - ChatGPT 里的连接器 URL：`https://mcp.<your-domain>/mcp/<chatgpt/secrets/mcp-token 的内容>`
  - 本机可用 `Show-Connection.cmd` 打印完整地址
- 局域网（家里）：`https://<lan-ip>:8443`（密码登录；令牌不需要）

## 本机文件（都不进仓库）

- `chatgpt/secrets/app-token`、`secrets/mcp-token`、`secrets/opengym-token.json`
- `chatgpt/store/cloudflare.json`（隧道名与两个 hostname）、`store/cloudflared.yml`（隧道 UUID + ingress）
- `chatgpt/store/public-url.txt`（MCP 公网基址）、`store/app-url.txt`（App 公网基址）
- `../windows/access.json`（当前局域网地址、证书指纹、公网 origin）
- `../windows/public-origin.txt`（公网 origin）
- `%USERPROFILE%\.cloudflared\cert.pem`（Cloudflare 登录证书，不是仓库里的东西）

## 常用命令

```bat
:: 启动连接器 + app-proxy + 隧道（读 store\tunnel-mode.txt）
Start.cmd

:: 只操作隧道
powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Mode cloudflare
powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Mode status
powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Mode stop

:: 打印当前公网连接地址（含新 token）
Show-Connection.cmd

:: 本机 guard（提交前自动跑）
node scripts/check-personal.mjs
node scripts/check-personal.mjs --staged
```

## 本机专用正则（可选）

`personal/guard-patterns.txt` 每行一条正则，guard 会额外拿它扫描。比如把不想公开的旧主机名、
旧域名、个人路径放进去；文件本身也在 `personal/` 里，不会入库。

## 变更记录

- 2026-10-29：公网入口从 Tailscale Funnel 换成 Cloudflare Tunnel；旧 Funnel 重置。
- 2026-10-29：发现旧 MCP token 曾出现在公开 README 中，已轮换（旧 token 现在 401），文档全部占位符化。
