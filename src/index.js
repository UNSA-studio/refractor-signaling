// Cloudflare Worker 入口：将 WebSocket 请求交给 Durable Object 处理
export { Room } from './room';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // WebSocket 升级：根据房间 ID 路由到对应的 Durable Object
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2]; // 例如 /room/A3F8-B9D2-C7E1-user472
      if (!roomId) {
        return new Response('Missing room ID', { status: 400 });
      }

      // 获取或创建 Durable Object 实例
      const id = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Refractor Signaling', { status: 200 });
  }
};