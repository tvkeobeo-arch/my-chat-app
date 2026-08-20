const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// absolute path for static files
app.use(express.static(path.join(__dirname, 'public')));

// send index.html for any request
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let waitingUser = null;
let onlineUsers = 0;

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('userCount', onlineUsers);

  if (waitingUser) {
    const partner = waitingUser;
    waitingUser = null;

    socket.partner = partner;
    partner.partner = socket;

    socket.emit('matched', '상대방과 연결되었습니다!');
    partner.emit('matched', '상대방과 연결되었습니다!');
  } else {
    waitingUser = socket;
    socket.emit('waiting', '상대방을 기다리는 중입니다...');
  }

  socket.on('message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('message', msg);
    }
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('userCount', onlineUsers);

    if (waitingUser === socket) {
      waitingUser = null;
    }
    if (socket.partner) {
      socket.partner.emit('disconnected', '상대방이 나가셨습니다.');
      socket.partner.partner = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Developer: HR] 수공라이브 서버가 PORT ${PORT}에서 실행 중입니다.`);
});