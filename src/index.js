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
        return new Response(JSON.stringify({ error: 'MISSING_ROOM_ID' }), { status: 400 });
      }
      const roomInfo = rooms.get(roomId);
      if (!roomInfo) {
        return new Response(JSON.stringify({ error: 'ROOM_NOT_FOUND' }), { status: 404 });
      }
      return new Response(JSON.stringify({
        roomId: roomId,
        online: roomInfo.clients.size,
        hasPassword: roomInfo.hasPassword,
        limit: roomInfo.limit,
        name: roomInfo.name
      }), { headers: { 'Content-Type': 'application/json' } });
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

let rooms = new Map();

async function createRoom(request) {
  try {
    const body = await request.json();
    const roomId = body.roomId;
    if (!roomId) return new Response(JSON.stringify({ error: 'MISSING_ROOM_ID' }), { status: 400 });
    if (rooms.has(roomId)) return new Response(JSON.stringify({ error: 'ROOM_EXISTS' }), { status: 409 });

    rooms.set(roomId, {
      name: body.name || '',
      hasPassword: body.hasPassword || false,
      passwordHash: body.passwordHash || '',
      limit: body.limit || 10,
      clients: new Set()
    });

    return new Response(JSON.stringify({ success: true, roomId: roomId }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 400 });
  }
}

function handleWebSocket(ws, roomId) {
  const roomInfo = rooms.get(roomId);
  if (!roomInfo) return;

  roomInfo.clients.add(ws);
  ws.accept();

  ws.addEventListener('message', event => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;
        case 'signal':
          roomInfo.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.READY_STATE_OPEN) {
              client.send(JSON.stringify({ type: 'signal', data: data.data }));
            }
          });
          break;
        case 'join':
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
      rooms.delete(roomId);
    } else {
      roomInfo.clients.forEach(client => {
        client.send(JSON.stringify({ type: 'user-left', count: roomInfo.clients.size }));
      });
    }
  });
}
