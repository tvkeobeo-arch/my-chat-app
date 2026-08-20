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
let roomCounter = 1;
let activeRooms = new Map();

const BAD_PATTERN = /(씨발|시발|병신|개새끼|지랄|존나|성교|야동|조건만남)/i;

function checkBadWords(text) {
  return BAD_PATTERN.test(text);
}

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

    const roomId = `방 #${roomCounter++}`;

    user1.partner = user2;
    user2.partner = user1;
    user1.currentRoomId = roomId;
    user2.currentRoomId = roomId;

    user1.join(roomId);
    user2.join(roomId);

    const roomData = {
      id: roomId,
      u1: { id: user1.userId, ip: user1.ipAddr },
      u2: { id: user2.userId, ip: user2.ipAddr },
      logs: [],
      hasWarning: false
    };

    activeRooms.set(roomId, roomData);

    user1.emit('matched');
    user2.emit('matched');

    io.to('admin_room').emit('admin_room_created', roomData);
  }
}

function removeFromQueue(socket) {
  const index = waitingQueue.indexOf(socket);
  if (index > -1) waitingQueue.splice(index, 1);
}

function disconnectPartner(socket) {
  if (socket.partner) {
    const partner = socket.partner;
    const roomId = socket.currentRoomId;

    if (roomId && activeRooms.has(roomId)) {
      activeRooms.delete(roomId);
      io.to('admin_room').emit('admin_room_destroyed', roomId);
    }

    if (roomId) {
      socket.leave(roomId);
      partner.leave(roomId);
    }

    socket.partner = null;
    socket.currentRoomId = null;
    partner.partner = null;
    partner.currentRoomId = null;
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
    if (!userId || !userPw) return socket.emit('auth_error', '아이디와 비밀번호를 입력해 주세요.');
    if (users[userId]) return socket.emit('auth_error', '이미 존재하는 아이디입니다.');
    
    users[userId] = userPw;
    saveUsers();
    socket.emit('register_success', '회원가입 완료! 로그인하세요.');
  });

  socket.on('login', ({ userId, userPw }) => {
    if (!userId || !userPw) return socket.emit('auth_error', '아이디와 비밀번호를 입력해 주세요.');
    if (!users[userId]) return socket.emit('auth_error', '존재하지 않는 아이디입니다.');
    if (users[userId] !== userPw) return socket.emit('auth_error', '비밀번호가 불일치합니다.');

    socket.userId = userId;

    if (userId === '이한률' && userPw === '1218') {
      socket.isAdmin = true;
      socket.join('admin_room');
      socket.emit('admin_login_success', {
        bannedIPs: Array.from(bannedIPs),
        rooms: Array.from(activeRooms.values()),
        onlineUsers: onlineUsers
      });
      return;
    }

    onlineUsers++;
    io.emit('userCount', onlineUsers);
    socket.emit('login_success', { userId });
  });

  socket.on('startChat', () => {
    if (!socket.userId || socket.isAdmin) return;
    disconnectPartner(socket);
    removeFromQueue(socket);
    waitingQueue.push(socket);
    socket.emit('waiting');
    matchQueue();
  });

  socket.on('message', (msg) => {
    if (socket.partner && socket.currentRoomId) {
      socket.partner.emit('message', msg);

      const isBad = checkBadWords(msg);
      const roomId = socket.currentRoomId;
      const room = activeRooms.get(roomId);

      if (room) {
        const logEntry = {
          fromId: socket.userId,
          fromIp: socket.ipAddr,
          msg: msg,
          isBad: isBad,
          time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        };
        room.logs.push(logEntry);
        if (isBad) room.hasWarning = true;

        io.to('admin_room').emit('admin_chat_update', {
          roomId: roomId,
          log: logEntry,
          hasWarning: room.hasWarning
        });
      }
    }
  });

  // 관리자 전용 채팅 개입 이벤트
  socket.on('admin_send_message', ({ roomId, msg }) => {
    if (!socket.isAdmin || !roomId || !msg) return;

    const room = activeRooms.get(roomId);
    if (room) {
      const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      
      // 방에 속한 유저들에게 관리자 메시지 전송
      io.to(roomId).emit('admin_broadcast', msg);

      // 관제 로그 기록 및 관제 화면 업데이트
      const logEntry = {
        fromId: '관리자',
        fromIp: 'ADMIN',
        msg: `[개입] ${msg}`,
        isBad: false,
        time: timeStr
      };
      room.logs.push(logEntry);

      io.to('admin_room').emit('admin_chat_update', {
        roomId: roomId,
        log: logEntry,
        hasWarning: room.hasWarning
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