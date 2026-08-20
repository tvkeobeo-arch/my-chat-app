const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let waitingUser = null;

io.on('connection', (socket) => {
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
server.listen(PORT, () => {
  console.log(`[Developer: 이한률] 서버가 PORT ${PORT}에서 실행 중입니다.`);
});