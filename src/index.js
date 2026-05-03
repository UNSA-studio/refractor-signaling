export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 新增：查询房间是否存在/有多少人
    if (url.pathname.startsWith('/check/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return new Response(JSON.stringify({ error: 'Missing room ID' }), { status: 400 });
      }
      const room = rooms.get(roomId);
      const count = room ? room.size : 0;
      return new Response(JSON.stringify({ roomId: roomId, online: count }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // WebSocket 升级：根据房间 ID 分发
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return new Response('Missing room ID', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      handleWebSocket(server, roomId, env);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Refractor Signaling', { status: 200 });
  }
};

let rooms = new Map(); // roomId -> Set<WebSocket>

function handleWebSocket(ws, roomId, env) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  const room = rooms.get(roomId);
  room.add(ws);

  ws.accept();

  ws.addEventListener('message', event => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'signal':
          room.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.READY_STATE_OPEN) {
              client.send(JSON.stringify({ type: 'signal', data: data.data }));
            }
          });
          break;
        case 'create':
        case 'join':
          room.forEach(client => {
            client.send(JSON.stringify({ type: 'user-joined', count: room.size }));
          });
          break;
        case 'chat':
          room.forEach(client => {
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
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      room.forEach(client => {
        client.send(JSON.stringify({ type: 'user-left', count: room.size }));
      });
    }
  });
}
