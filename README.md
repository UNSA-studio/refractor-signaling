# Refractor Signaling Server

Refractor 直播应用的 WebRTC 信令服务器，基于 Cloudflare Workers + Durable Objects 实现。

生产地址：`wss://rfr-sl.cc.cd`（WebSocket）/ `https://rfr-sl.cc.cd`（HTTP API）

## 项目结构

```
├── src/
│   ├── index.js      # Worker 入口 + Durable Object Room（v2，生产使用）
│   └── room.js       # （已删除）DO v1 遗留实现
├── server.js         # 本地开发服务器（Node.js ws/express，内存版，仅调试用）
├── wrangler.toml     # Cloudflare Workers 部署配置
└── package.json      # 本地开发依赖（server.js 用）
```

## 架构

- **Worker 路由层**（`src/index.js` 默认导出）：处理 HTTP API 和 WebSocket 升级请求，将 `/room/{roomId}` 转发给对应的 Durable Object。
- **Durable Object `Room`**：每个房间一个实例，状态持久化到 `state.storage`（SQLite），DO 冷启动后自动恢复房间信息（名称、密码、人数上限、激活状态）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回 `{status: 'ok'}` |
| POST | `/create` | 创建房间，body: `{roomId, name, hasPassword, passwordHash, limit}` |
| GET | `/check/{roomId}` | 查询房间状态，返回 `{online, name, hasPassword, limit}` |
| POST | `/delete/{roomId}` | 删除/关闭房间 |

## WebSocket 信令协议

连接地址：`wss://rfr-sl.cc.cd/room/{roomId}`

### 客户端 → 服务器

| type | data | 说明 |
|---|---|---|
| `join` | `{clientId, password?}` | 加入房间（10 秒超时保护；密码错误返回 `error` 并关闭连接码 4003） |
| `ping` | - | 心跳，服务器回 `pong`（客户端每 30 秒发送） |
| `signal` | `data`（任意 JSON） | WebRTC 信令转发给房间内其他客户端（SDP/ICE） |
| `chat` | `{data, from}` | 聊天消息，服务器透传发送者 `from` |

### 服务器 → 客户端

| type | data | 说明 |
|---|---|---|
| `pong` | - | 心跳响应 |
| `user-joined` | `{count}` | 有成员加入 |
| `user-left` | `{count}` | 有成员离开 |
| `signal` | `{data}` | 转发其他客户端的 WebRTC 信令 |
| `chat` | `{data, from}` | 转发聊天消息（`from` 为真实发送者 clientId） |
| `error` | `{message}` | 错误（密码错误 / 房间已满 / 加入超时等） |

## 房间规则

- **激活**：通过 `POST /create` 激活，未激活的房间 WebSocket 连接返回 `ROOM_NOT_FOUND`（404）。
- **密码**：`hasPassword=true` 时，`join` 必须携带正确密码。密码以 Base64（UTF-8）编码存储，与 Android 端 `Base64.encodeToString(password.toByteArray())` 一致。
- **人数上限**：`limit` 限制房间在线人数，满员时新加入返回 `error: 房间已满` 并关闭（4004）。
- **生命周期**：主播离开不会自动关闭房间（由 `POST /delete` 或主播重新开播决定）。

## 本地开发

```bash
npm install
node server.js   # 内存版本地信令服务器，端口 3000
```

## 部署

```bash
npx wrangler login          # 首次认证
npx wrangler deploy         # 发布
```

部署后需在 Cloudflare Dashboard 为 Worker 绑定自定义域名 `rfr-sl.cc.cd`（或配置路由）。

## 对接方

| 项目 | 仓库 | 说明 |
|---|---|---|
| Refractor（Android） | `UNSA-studio/Refractor` | 主播/观众客户端，硬编码连接本服务器 |
| Refractor Account | `UNSA-studio/account-Refractor` | 独立账户服务，不与信令服务器交互 |
