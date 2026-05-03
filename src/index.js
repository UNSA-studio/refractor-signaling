// ========== Refractor Signaling Server ==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 查询房间状态
    if (url.pathname.startsWith('/check/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);
      }
      const roomInfo = rooms.get(roomId);
      if (!roomInfo) {
        return jsonResponse({ error: 'ROOM_NOT_FOUND' });
      }
      return jsonResponse({
        roomId: roomId,
        online: roomInfo.clients.size,
        hasPassword: roomInfo.hasPassword,
        limit: roomInfo.limit,
        name: roomInfo.name,
        // 不返回密码哈希，只告知是否有密码
      });
    }

    // WebSocket 升级
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return new Response('Missing room ID', { status: 400 });
      }

      // 创建房间（如果不存在）
      if (!rooms.has(roomId)) {
        return new Response(JSON.stringify({ error: 'ROOM_NOT_FOUND' }), { status: 404 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      handleWebSocket(server, roomId);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Refractor Signaling', { status: 200 });
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// 房间信息存储
let rooms = new Map(); // roomId -> { name, hasPassword, passwordHash, limit, clients: Set<WebSocket> }

// WebSocket 处理
function handleWebSocket(ws, roomId) {
  const roomInfo = rooms.get(roomId);
  if (!roomInfo) return;

  roomInfo.clients.add(ws);
  ws.accept();

  ws.addEventListener('message', event => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'signal':
          // 转发 WebRTC 信令
          roomInfo.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.READY_STATE_OPEN) {
              client.send(JSON.stringify({ type: 'signal', data: data.data }));
            }
          });
          break;

        case 'create-room':
          // 主播首次连接时发送这个，建立房间（已在WebSocket连接前处理）
          break;

        case 'join':
          // 广播新成员加入
          roomInfo.clients.forEach(client => {
            client.send(JSON.stringify({ type: 'user-joined', count: roomInfo.clients.size }));
          });
          break;

        case 'chat':
          roomInfo.clients.forEach(client => {
            if (client.readyState === WebSocket.READY_STATE_OPEN) {
              client.send(JSON.stringify({ type: 'chat', data: data.data, from: 'peer' }));
            }
          });
          break;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  });

  ws.addEventListener('close', () => {
    roomInfo.clients.delete(ws);
    if (roomInfo.clients.size === 0) {
      // 房间无人时删除
      rooms.delete(roomId);
    } else {
      // 通知其他成员
      roomInfo.clients.forEach(client => {
        client.send(JSON.stringify({ type: 'user-left', count: roomInfo.clients.size }));
      });
    }
  });
}

// 新增：创建房间的 API（由主播端通过 HTTP POST 调用）
async function createRoom(request) {
  try {
    const body = await request.json();
    const roomId = body.roomId;
    if (!roomId) return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);
    if (rooms.has(roomId)) return jsonResponse({ error: 'ROOM_EXISTS' }, 409);

    rooms.set(roomId, {
      name: body.name || '',
      hasPassword: body.hasPassword || false,
      passwordHash: body.passwordHash || '',
      limit: body.limit || 10,
      clients: new Set()
    });

    return jsonResponse({ success: true, roomId: roomId });
  } catch (e) {
    return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
  }
}

// 修改 fetch，增加 POST /create 路由
// 需要在 fetch 中加入以下判断
/* 将上面 fetch 函数替换为：
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/create') {
      return createRoom(request);
    }
    // ... 其余不变
  }
};
*/

// 由于代码限制，我重新给出完整 fetch：
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/create') {
      return createRoom(request);
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.pathname.startsWith('/check/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return jsonResponse({ error: 'MISSING_ROOM_ID' }, 400);
      }
      const roomInfo = rooms.get(roomId);
      if (!roomInfo) {
        return jsonResponse({ error: 'ROOM_NOT_FOUND' });
      }
      return jsonResponse({
        roomId: roomId,
        online: roomInfo.clients.size,
        hasPassword: roomInfo.hasPassword,
        limit: roomInfo.limit,
        name: roomInfo.name
      });
    }
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return new Response('Missing room ID', { status: 400 });
      }
      if (!rooms.has(roomId)) {
        return new Response(JSON.stringify({ error: 'ROOM_NOT_FOUND' }), { status: 404 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      handleWebSocket(server, roomId);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Refractor Signaling', { status: 200 });
  }
};