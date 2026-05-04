// ========== Refractor 信令服务器（Durable Object 版本） ==========

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok' });
    }

    // ---------- HTTP API ----------

    // 创建房间
    if (request.method === 'POST' && url.pathname === '/create') {
      return createRoom(request, env);
    }

    // 查询房间
    if (url.pathname.startsWith('/check/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);
      return checkRoom(roomId, env);
    }

    // 删除房间
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
      // 所有 WebSocket 交由对应的 Durable Object 实例处理
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
    // 客户端列表保存在内存中 (Durable Object 保证单实例)
    this.clients = new Set();
  }

  // 处理 HTTP 请求（包括 WebSocket 升级）
  async fetch(request) {
    const url = new URL(request.url);
    
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 其他 HTTP 方法可用于内部操作
    if (request.method === 'GET' && url.pathname.endsWith('/status')) {
      return jsonResponse({
        clients: this.clients.size,
        roomId: this.state.id.toString()
      });
    }

    return new Response('Not found', { status: 404 });
  }

  handleWebSocket(ws) {
    this.clients.add(ws);
    ws.accept();

    // 广播新成员
    this.broadcast({ type: 'user-joined', count: this.clients.size });

    ws.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'signal':
            // 转发 WebRTC 信令给其他所有人
            this.broadcast({ type: 'signal', data: data.data }, ws);
            break;
          case 'chat':
            this.broadcast({ type: 'chat', data: data.data, from: 'peer' }, ws);
            break;
          case 'join':
            // join 由服务器自动处理，不需要额外转发
            break;
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    ws.addEventListener('close', () => {
      this.clients.delete(ws);
      if (this.clients.size > 0) {
        this.broadcast({ type: 'user-left', count: this.clients.size });
      }
      // 这里不删除房间，房间级别的数据（如名称、密码、上限）
      // 可以通过 DO 的 state.storage 持久化，这里暂不实现
    });
  }

  broadcast(message, excludeWs = null) {
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    this.clients.forEach(client => {
      if (client !== excludeWs && client.readyState === WebSocket.READY_STATE_OPEN) {
        client.send(msgStr);
      }
    });
  }
}

// ========== 辅助函数 ==========
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createRoom(request, env) {
  try {
    const body = await request.json();
    const roomId = body.roomId;
    if (!roomId) return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);

    // 检查是否已存在（通过 DO 快速判断）
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);
    // 简单通过获取状态来判断是否存在（这里仅用 /status 端点）
    const resp = await stub.fetch('https://dummy/status');
    if (resp.status === 200) {
      return jsonResponse({ error: 'ROOM_EXISTS' }, 409);
    }
    // 实际上 DO 在第一次调用时就会被创建，所以 create 本质上什么都不用做，
    // 只要 DO 被触达就会存在。但我们仍然保留这个端点用于占位。
    return jsonResponse({ success: true, roomId });
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
    // 这里我们无法直接从 DO 取回房间的名字/密码等元数据，需要进一步设计
    // 临时方案：只要 DO 存在，就认为房间存在
    return jsonResponse({
      roomId,
      online: status.clients || 0,
      hasPassword: false,  // 后续可从 DO 存储读取
      limit: 10,
      name: roomId
    });
  } catch (e) {
    return jsonResponse({ error: 'SERVICE_ERROR' }, 500);
  }
}

async function deleteRoom(roomId, env) {
  try {
    const id = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(id);
    // Durable Object 删除需要通过专门的 API，但我们可以简单标记
    // 这里暂不做真实删除，实际项目中可在 DO 中实现 deleteSelf
    return jsonResponse({ success: true });
  } catch (e) {
    return jsonResponse({ error: 'SERVICE_ERROR' }, 500);
  }
}
