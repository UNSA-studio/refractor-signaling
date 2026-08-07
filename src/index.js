// ========== Refractor 信令服务器（Durable Object v2） ==========

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    // ---------- HTTP API ----------
    if (request.method === 'POST' && url.pathname === '/create') {
      return createRoom(request, env);
    }

    if (url.pathname.startsWith('/check/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);
      return checkRoom(roomId, env);
    }

    if (request.method === 'POST' && url.pathname.startsWith('/delete/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);
      return deleteRoom(roomId, env);
    }

    // ---------- WebSocket ----------
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return new Response('Missing room ID', { status: 400 });
      }
      // 交给对应的 DO 处理
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Refractor Signaling', { status: 200 });
  }
};

// ========== Durable Object 定义 ==========
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set(); // 已加入的 WebSocket 连接
    this.clientIds = new Map(); // ws -> clientId（join 时登记）
    this.joinTimers = new Map(); // ws -> join 超时定时器
    this._loaded = false;
    // 房间状态（从持久化存储加载，默认为未激活）
    this.roomId = '';
    this.isActive = false;
    this.name = '';
    this.hasPassword = false;
    this.passwordHash = '';
    this.limit = 10;
  }

  /** 从持久化存储加载房间状态（DO 冷启动后恢复） */
  async _loadState() {
    if (this._loaded) return;
    this._loaded = true;
    const meta = await this.state.storage.get('meta');
    if (meta) {
      this.roomId = meta.roomId || '';
      this.isActive = !!meta.isActive;
      this.name = meta.name || '';
      this.hasPassword = !!meta.hasPassword;
      this.passwordHash = meta.passwordHash || '';
      this.limit = meta.limit || 10;
    }
  }

  /** 将房间状态写入持久化存储 */
  async _saveState() {
    await this.state.storage.put('meta', {
      roomId: this.roomId,
      isActive: this.isActive,
      name: this.name,
      hasPassword: this.hasPassword,
      passwordHash: this.passwordHash,
      limit: this.limit
    });
  }

  /**
   * DO alarm 处理：房间空置超过 TTL 后自动删除，防止僵尸房间残留。
   * 由 state.storage.setAlarm() 触发（DO 在内存中或冷启动都会执行）。
   */
  async alarm() {
    await this._loadState();
    // 仅当房间仍处于未激活/空置状态时清理；若期间有新成员加入会被 deleteAlarm 取消
    if (!this.isActive) return;
    if (this.clientIds.size > 0) return; // 还有人在，不做处理（理论上 alarm 已被取消）
    this.isActive = false;
    this.name = '';
    this.hasPassword = false;
    this.passwordHash = '';
    this.roomId = '';
    this.clients.clear();
    this.clientIds.clear();
    await this._saveState();
  }

  async fetch(request) {
    await this._loadState();
    const url = new URL(request.url);

    // WebSocket 升级
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!this.isActive) {
        return jsonResponse({ error: 'ROOM_NOT_FOUND' }, 404);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 内部 API：激活/更新房间信息
    if (request.method === 'POST' && url.pathname.endsWith('/activate')) {
      try {
        const body = await request.json();
        this.roomId = body.roomId || this.roomId;
        this.isActive = true;
        this.name = body.name || '';
        this.hasPassword = !!body.hasPassword;
        this.passwordHash = body.passwordHash || '';
        this.limit = body.limit || 10;
        // 房间被重新激活，取消任何待执行的删除 alarm
        await this.state.storage.deleteAlarm();
        await this._saveState();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
    }

    // 内部 API：查询房间状态
    if (request.method === 'GET' && url.pathname.endsWith('/status')) {
      if (!this.isActive) {
        return jsonResponse({ error: 'ROOM_NOT_FOUND' }, 404);
      }
      return jsonResponse({
        roomId: this.roomId || this.state.id.toString(),
        online: this.clientIds.size,
        hasPassword: this.hasPassword,
        limit: this.limit,
        name: this.name
      });
    }

    // 内部 API：删除房间
    if (request.method === 'POST' && url.pathname.endsWith('/deactivate')) {
      this.isActive = false;
      this.name = '';
      this.hasPassword = false;
      this.passwordHash = '';
      this.roomId = '';
      this.clients.clear();
      this.clientIds.clear();
      await this._saveState();
      return jsonResponse({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }

  handleWebSocket(ws) {
    this.clients.add(ws);
    ws.accept();

    // join 超时保护：10 秒内未完成密码验证则断开，防止未验证连接占位
    const joinTimer = setTimeout(() => {
      if (!this.clientIds.has(ws)) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: '加入超时，请重试' }));
          ws.close(4001, 'join timeout');
        } catch (e) { /* 连接已关闭 */ }
      }
    }, 10000);
    this.joinTimers.set(ws, joinTimer);

    ws.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'join': {
            // 人数上限检查（基于已完成 join 的成员数）
            if (this.limit > 0 && this.clientIds.size >= this.limit) {
              this.clearJoinTimer(ws);
              this.clients.delete(ws);
              ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
              ws.close(4004, 'room full');
              return;
            }
            // 验证密码：密码不匹配则拒绝加入
            if (this.hasPassword) {
              const sentHash = base64EncodeUtf8(data.password || '');
              if (sentHash !== this.passwordHash) {
                this.clearJoinTimer(ws);
                this.clients.delete(ws);
                ws.send(JSON.stringify({ type: 'error', message: '密码错误' }));
                ws.close(4003, 'wrong password');
                return;
              }
            }
            // 密码验证通过：登记 clientId 并广播加入
            this.clearJoinTimer(ws);
            this.clientIds.set(ws, data.clientId || '');
            // 有成员加入：取消待执行的空房间删除 alarm
            this.state.storage.deleteAlarm().catch(() => {});
            this.broadcast({ type: 'user-joined', count: this.clientIds.size });
            break;
          }
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'signal':
            this.broadcast({ type: 'signal', data: data.data }, ws);
            break;
          case 'chat': {
            // 透传发送者 clientId（join 时登记的），接收端可正确判断消息归属
            const from = this.clientIds.get(ws) || data.from || 'peer';
            this.broadcast({ type: 'chat', data: data.data, from }, ws);
            break;
          }
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    ws.addEventListener('close', () => {
      this.clients.delete(ws);
      this.clientIds.delete(ws);
      this.clearJoinTimer(ws);
      if (this.clientIds.size > 0) {
        this.broadcast({ type: 'user-left', count: this.clientIds.size });
      } else if (this.isActive) {
        // 房间空置：安排延迟自动删除（给主播网络抖动重连留时间），超时后 alarm() 清理
        this.state.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS).catch(() => {});
      }
    });
  }

  clearJoinTimer(ws) {
    const t = this.joinTimers.get(ws);
    if (t) {
      clearTimeout(t);
      this.joinTimers.delete(ws);
    }
  }

  broadcast(message, excludeWs = null) {
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    // 只向已完成 join 验证的客户端广播
    this.clientIds.forEach((clientId, client) => {
      // WebSocket.OPEN(1) 是标准常量；兼容 Workers 与非 Workers 运行环境
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        client.send(msgStr);
      }
    });
  }
}

// ========== 辅助函数 ==========
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 空房间保留时间：全部成员离开后等待 TTL，允许主播网络抖动重连，超时后自动删除房间 */
const EMPTY_ROOM_TTL_MS = 60_000;

/** UTF-8 安全的 Base64 编码，与 Android 端 Base64.encodeToString(password.toByteArray()) 一致 */
function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function createRoom(request, env) {
  try {
    const body = await request.json();
    const roomId = body.roomId;
    if (!roomId) return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);

    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);

    // 先检查是否已激活
    const checkResp = await stub.fetch('https://dummy/status');
    if (checkResp.status === 200) {
      return jsonResponse({ error: 'ROOM_EXISTS' }, 409);
    }

    // 通知 DO 激活
    const activateResp = await stub.fetch('https://dummy/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        name: body.name || '',
        hasPassword: body.hasPassword || false,
        passwordHash: body.passwordHash || '',
        limit: body.limit || 10
      })
    });

    if (activateResp.status === 200) {
      return jsonResponse({ success: true, roomId });
    } else {
      return jsonResponse({ error: 'CREATE_FAILED' }, 500);
    }
  } catch (e) {
    return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  }
}

async function checkRoom(roomId, env) {
  try {
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);
    const resp = await stub.fetch('https://dummy/status');
    if (resp.status !== 200) {
      return jsonResponse({ error: 'ROOM_NOT_FOUND' }, 404);
    }
    const status = await resp.json();
    return jsonResponse(status);
  } catch (e) {
    return jsonResponse({ error: 'SERVICE_ERROR' }, 500);
  }
}

async function deleteRoom(roomId, env) {
  try {
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);
    const resp = await stub.fetch('https://dummy/deactivate', { method: 'POST' });
    if (resp.status === 200) {
      return jsonResponse({ success: true });
    } else {
      return jsonResponse({ error: 'DELETE_FAILED' }, 500);
    }
  } catch (e) {
    return jsonResponse({ error: 'SERVICE_ERROR' }, 500);
  }
}
