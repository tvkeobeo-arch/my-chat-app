const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const io = new Server(server, { cors: { origin: "*" } });

const DB_PATH = path.join(__dirname, 'users.json');
let users = { '이한률': '1218' };

if (fs.existsSync(DB_PATH)) {
  try {
    const fileData = fs.readFileSync(DB_PATH, 'utf8');
    users = JSON.parse(fileData);
  } catch (err) {
    console.error('회원 데이터 로드 실패:', err);
  }
} else {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function saveUsers() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('회원 데이터 저장 실패:', err);
  }
}

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

  if (bannedIPs.has(ip)) {
    socket.emit('banned');
    socket.disconnect();
    return;
  }

  socket.on('register', ({ userId, userPw }) => {
    if (!userId || !userPw) return socket.emit('auth_error', '아이디와 비밀번호를 모두 입력해 주세요.');
    if (users[userId]) return socket.emit('auth_error', '이미 존재하는 아이디입니다.');
    
    users[userId] = userPw;
    saveUsers();
    socket.emit('register_success', '회원가입이 완료되었습니다! 로그인해 주세요.');
  });

  socket.on('login', ({ userId, userPw }) => {
    if (!userId || !userPw) return socket.emit('auth_error', '아이디와 비밀번호를 입력해 주세요.');
    if (!users[userId]) return socket.emit('auth_error', '존재하지 않는 아이디입니다.');
    if (users[userId] !== userPw) return socket.emit('auth_error', '비밀번호가 일치하지 않습니다.');

    socket.userId = userId;

    if (userId === '이한률' && userPw === '1218') {
      socket.isAdmin = true;
      socket.join('admin_room');
      socket.emit('admin_login_success', { bannedIPs: Array.from(bannedIPs) });
      return;
    }

    onlineUsers++;
    io.emit('userCount', onlineUsers);
    socket.emit('login_success', { userId });
  });

  // 명시적 대화 시작
  socket.on('startChat', () => {
    if (!socket.userId || socket.isAdmin) return;
    disconnectPartner(socket);
    removeFromQueue(socket);
    waitingQueue.push(socket);
    socket.emit('waiting');
    matchQueue();
  });

  socket.on('message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('message', msg);
      io.to('admin_room').emit('admin_chat_log', {
        fromId: socket.userId,
        fromIp: socket.ipAddr,
        toId: socket.partner.userId,
        toIp: socket.partner.ipAddr,
        msg: msg
      });
    }
  });

  socket.on('findNext', () => {
    if (!socket.userId || socket.isAdmin) return;
    disconnectPartner(socket);
    removeFromQueue(socket);
    waitingQueue.push(socket);
    socket.emit('waiting');
    matchQueue();
  });

  socket.on('leave', () => {
    if (!socket.userId || socket.isAdmin) return;
    disconnectPartner(socket);
    removeFromQueue(socket);
    socket.emit('ended');
  });

  socket.on('admin_ban_ip', (targetIp) => {
    if (!socket.isAdmin) return;
    bannedIPs.add(targetIp);
    for (let [id, sock] of io.sockets.sockets) {
      if (sock.ipAddr === targetIp) {
        sock.emit('banned');
        sock.disconnect();
      }
    }
    io.to('admin_room').emit('admin_ban_updated', Array.from(bannedIPs));
  });

  socket.on('admin_unban_ip', (targetIp) => {
    if (!socket.isAdmin) return;
    bannedIPs.delete(targetIp);
    io.to('admin_room').emit('admin_ban_updated', Array.from(bannedIPs));
  });

  socket.on('disconnect', () => {
    if (socket.userId && !socket.isAdmin) {
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