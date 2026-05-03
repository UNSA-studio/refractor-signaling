export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

let rooms = new Map();

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
          // 转发聊天消息给房间里的所有人
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