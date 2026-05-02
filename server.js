// Refractor 信令服务器
const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

// 健康检查端点（给 cron job 用）
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

wss.on('connection', (ws) => {
    let currentRoom = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, room } = data;

            if (type === 'create' || type === 'join') {
                if (!rooms.has(room)) rooms.set(room, { clients: [] });
                const roomData = rooms.get(room);
                if (roomData.clients.length >= 10) {
                    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                    return;
                }
                roomData.clients.push({ ws, type });
                currentRoom = room;
                // 通知所有成员
                roomData.clients.forEach(c => c.ws.send(JSON.stringify({
                    type: 'user-joined', room, users: roomData.clients.length
                })));
            }
            else if (type === 'signal' && currentRoom) {
                const roomData = rooms.get(currentRoom);
                if (roomData) {
                    roomData.clients.forEach(client => {
                        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                type: 'signal',
                                from: 'peer',
                                data: data.data,
                                room: currentRoom
                            }));
                        }
                    });
                }
            }
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
        }
    });

    ws.on('close', () => {
        if (!currentRoom) return;
        const roomData = rooms.get(currentRoom);
        if (!roomData) return;
        roomData.clients = roomData.clients.filter(c => c.ws !== ws);
        if (roomData.clients.length === 0) rooms.delete(currentRoom);
        else {
            roomData.clients.forEach(c => c.ws.send(JSON.stringify({
                type: 'user-left', room: currentRoom, users: roomData.clients.length
            })));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`信令服务器运行在端口 ${PORT}`));