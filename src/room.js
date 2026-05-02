export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // clientId -> WebSocket
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 接受服务器端 WebSocket
    this.state.acceptWebSocket(server);

    const clientId = crypto.randomUUID();
    this.sessions.set(clientId, server);

    // 将客户端 WebSocket 返回给用户
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'ping':
          // 心跳回复
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'signal':
          // 转发信令给房间内其他所有人
          this.broadcast(ws, {
            type: 'signal',
            data: data.data
          });
          break;

        case 'create':
        case 'join':
          // 广播用户加入
          this.broadcast(ws, {
            type: 'user-joined',
            count: this.sessions.size
          });
          break;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // 移除离开的会话
    for (const [id, session] of this.sessions.entries()) {
      if (session === ws) {
        this.sessions.delete(id);
        break;
      }
    }

    // 广播用户离开
    this.broadcast(ws, {
      type: 'user-left',
      count: this.sessions.size
    });
  }

  broadcast(senderWs, message) {
    const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
    for (const ws of this.sessions.values()) {
      if (ws !== senderWs && ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(msgStr);
      }
    }
  }
}