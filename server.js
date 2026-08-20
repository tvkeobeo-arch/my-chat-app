const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let waitingQueue = [];
let onlineUsers = 0;

function matchQueue() {
  while (waitingQueue.length >= 2) {
    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();

    if (!user1.connected) {
      if (user2.connected) waitingQueue.unshift(user2);
      continue;
    }
    if (!user2.connected) {
      waitingQueue.unshift(user1);
      continue;
    }

    user1.partner = user2;
    user2.partner = user1;

    user1.emit('matched');
    user2.emit('matched');
  }
}

function removeFromQueue(socket) {
  const index = waitingQueue.indexOf(socket);
  if (index > -1) {
    waitingQueue.splice(index, 1);
  }
}

function disconnectPartner(socket) {
  if (socket.partner) {
    const partner = socket.partner;
    socket.partner = null;
    partner.partner = null;
    partner.emit('partnerDisconnected');
  }
}

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('userCount', onlineUsers);

  waitingQueue.push(socket);
  socket.emit('waiting');
  matchQueue();

  socket.on('message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('message', msg);
    }
  });

  socket.on('findNext', () => {
    disconnectPartner(socket);
    removeFromQueue(socket);
    waitingQueue.push(socket);
    socket.emit('waiting');
    matchQueue();
  });

  socket.on('leave', () => {
    disconnectPartner(socket);
    removeFromQueue(socket);
    socket.emit('ended');
  });

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('userCount', onlineUsers);
    removeFromQueue(socket);
    disconnectPartner(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Developer: HR] 수공라이브 서버 가동 중 (PORT ${PORT})`);
});