const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const io = new Server(server, { cors: { origin: "*" } });

let waitingQueue = [];
let onlineUsers = 0;
let bannedIPs = new Set();

function getClientIp(socket) {
  const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  return rawIp ? rawIp.split(',')[0].trim() : '0.0.0.0';
}

function matchQueue() {
  while (waitingQueue.length >= 2) {
    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();

    if (!user1.connected) { if (user2.connected) waitingQueue.unshift(user2); continue; }
    if (!user2.connected) { waitingQueue.unshift(user1); continue; }

    user1.partner = user2;
    user2.partner = user1;

    user1.emit('matched');
    user2.emit('matched');

    // 관리자 방에 매칭 상황 알림
    io.to('admin_room').emit('admin_match_event', {
      u1: { id: user1.userId, ip: user1.ipAddr },
      u2: { id: user2.userId, ip: user2.ipAddr }
    });
  }
}

function removeFromQueue(socket) {
  const index = waitingQueue.indexOf(socket);
  if (index > -1) waitingQueue.splice(index, 1);
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
  const ip = getClientIp(socket);
  socket.ipAddr = ip;

  // 차단된 IP 거부
  if (bannedIPs.has(ip)) {
    socket.emit('banned');
    socket.disconnect();
    return;
  }

  // 로그인 처리
  socket.on('login', (data) => {
    socket.userId = data.userId || '익명';
    onlineUsers++;
    io.emit('userCount', onlineUsers);

    waitingQueue.push(socket);
    socket.emit('waiting');
    matchQueue();
  });

  socket.on('message', (msg) => {
    // 0009 입력 시 개발자 모드 승인
    if (msg.trim() === '0009') {
      socket.join('admin_room');
      socket.emit('admin_approved', {
        bannedIPs: Array.from(bannedIPs)
      });
      return;
    }

    if (socket.partner) {
      socket.partner.emit('message', msg);

      // 개발자 패널로 실시간 대화 전송
      io.to('admin_room').emit('admin_chat_log', {
        fromId: socket.userId,
        fromIp: socket.ipAddr,
        toId: socket.partner.userId,
        toIp: socket.partner.ipAddr,
        msg: msg
      });
    }
  });

  // 관리자 기능: IP 차단
  socket.on('admin_ban_ip', (targetIp) => {
    if (!socket.rooms.has('admin_room')) return;
    bannedIPs.add(targetIp);

    for (let [id, sock] of io.sockets.sockets) {
      if (sock.ipAddr === targetIp) {
        sock.emit('banned');
        sock.disconnect();
      }
    }
    io.to('admin_room').emit('admin_ban_updated', Array.from(bannedIPs));
  });

  // 관리자 기능: IP 차단 해제
  socket.on('admin_unban_ip', (targetIp) => {
    if (!socket.rooms.has('admin_room')) return;
    bannedIPs.delete(targetIp);
    io.to('admin_room').emit('admin_ban_updated', Array.from(bannedIPs));
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
    if (socket.userId) {
      onlineUsers = Math.max(0, onlineUsers - 1);
      io.emit('userCount', onlineUsers);
    }
    removeFromQueue(socket);
    disconnectPartner(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Developer: HR] 수공라이브 가동 중 (PORT ${PORT})`);
});