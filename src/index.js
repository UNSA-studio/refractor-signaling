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
    this.clients = new Set();
    // 关键：初始化房间状态（默认为未激活）
    this.isActive = false;
    this.name = '';
    this.hasPassword = false;
    this.passwordHash = '';
    this.limit = 10;
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // WebSocket 升级
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!this.isActive) {
        return new Response(JSON.stringify({ error: 'ROOM_NOT_FOUND' }), { status: 404 });
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
        this.isActive = true;
        this.name = body.name || '';
        this.hasPassword = body.hasPassword || false;
        this.passwordHash = body.passwordHash || '';
        this.limit = body.limit || 10;
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
        roomId: this.state.id.toString(),
        online: this.clients.size,
        hasPassword: this.hasPassword,
        limit: this.limit,
        name: this.name
      });
    }

    // 内部 API：删除房间
    if (request.method === 'POST' && url.pathname.endsWith('/deactivate')) {
      this.isActive = false;
      this.name = '';
      this.clients.clear();
      return jsonResponse({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }

  handleWebSocket(ws) {
    this.clients.add(ws);
    ws.accept();
    this.broadcast({ type: 'user-joined', count: this.clients.size });

    ws.addEventListener('message', event => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'signal':
            this.broadcast({ type: 'signal', data: data.data }, ws);
            break;
          case 'chat':
            this.broadcast({ type: 'chat', data: data.data, from: 'peer' }, ws);
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
      // 注意：不在这里自动 deactivate，由主播决定何时结束直播。
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
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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
