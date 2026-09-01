'use strict';

const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3030);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, service: 'last-shield-server', rooms: rooms.size }));
});

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const rooms = new Map();

function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }
function cleanId(value) { return String(value || '').trim().replace(/^@/, '').toLowerCase(); }
function safeText(value, max = 80) { return String(value || '').trim().slice(0, max); }

function normalizeRules(input = {}) {
  const startHp = clamp(input.startHp ?? 100, 1, 100000);
  const maxHp = clamp(input.maxHp ?? startHp, 1, 100000);
  const targetWins = clamp(input.targetWins ?? 3, 1, 99);
  const triggers = Array.isArray(input.triggers) ? input.triggers : [];

  return {
    startHp: Math.min(startHp, maxHp),
    maxHp,
    targetWins,
    triggers: triggers.map(t => ({
      id: safeText(t.id || crypto.randomUUID(), 120),
      giftIds: Array.isArray(t.giftIds) ? t.giftIds.map(String).filter(Boolean) : [],
      action: t.action === 'heal' ? 'heal' : 'damage',
      amount: clamp(t.amount, 0, 100000)
    }))
  };
}

function makePlayer(player, rules) {
  const playerId = cleanId(player.playerId || player.username);
  return {
    playerId,
    username: safeText(player.username || playerId, 80),
    nickname: safeText(player.nickname || player.username || playerId, 80),
    avatar: safeText(player.avatar || '', 1000),
    connected: true,
    hp: rules.startHp,
    maxHp: rules.maxHp,
    alive: true,
    wins: 0,
    joinedAt: Date.now()
  };
}

function publicRoom(room) {
  return {
    roomId: room.roomId,
    hostPlayerId: room.hostPlayerId,
    rules: room.rules,
    phase: room.phase,
    winnerPlayerId: room.winnerPlayerId,
    players: Object.fromEntries([...room.players.entries()].map(([id, p]) => [id, publicPlayer(p)]))
  };
}

function publicPlayer(p) {
  return {
    playerId: p.playerId,
    nickname: p.nickname,
    avatar: p.avatar,
    connected: p.connected,
    hp: p.hp,
    maxHp: p.maxHp,
    alive: p.alive,
    wins: p.wins
  };
}

function emitSnapshot(room) {
  io.to(room.roomId).emit('room_snapshot', publicRoom(room));
}

function emitEvent(room, event) {
  io.to(room.roomId).emit('game_event', { id: crypto.randomUUID(), at: Date.now(), ...event });
}

function getOpponents(room, sourceId) {
  return [...room.players.values()].filter(p => p.connected && p.alive && p.playerId !== sourceId);
}

function applyDamage(room, target, amount, meta) {
  if (!target || !target.alive) return;
  const before = target.hp;
  target.hp = Math.max(0, before - amount);
  if (target.hp <= 0) target.alive = false;

  emitEvent(room, {
    type: 'damage',
    targetPlayerIds: [target.playerId],
    amount: before - target.hp,
    viewer: meta.viewer,
    viewerAvatar: meta.viewerAvatar,
    giftIcon: meta.giftIcon
  });
}

function applyHeal(room, target, amount, meta) {
  if (!target || !target.alive) return;
  const before = target.hp;
  target.hp = Math.min(target.maxHp, before + amount);

  emitEvent(room, {
    type: 'heal',
    targetPlayerIds: [target.playerId],
    amount: target.hp - before,
    viewer: meta.viewer,
    viewerAvatar: meta.viewerAvatar,
    giftIcon: meta.giftIcon
  });
}

function checkVictory(room) {
  if (room.phase !== 'playing') return;
  const connected = [...room.players.values()].filter(p => p.connected);
  if (connected.length < 2) return; // Ждем соперника
  
  const alive = connected.filter(p => p.alive);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) {
      winner.wins += 1;
    }
    
    room.winnerPlayerId = winner ? winner.playerId : null;
    const isGrandWinner = winner && winner.wins >= room.rules.targetWins;
    room.phase = isGrandWinner ? 'match_won' : 'round_won';

    emitEvent(room, {
      type: 'finish',
      targetPlayerIds: [],
      label: isGrandWinner ? 'ГРАНД ПОБЕДА!' : 'РАУНД ВЫИГРАН',
      winnerPlayerId: room.winnerPlayerId
    });
  }
}

function processGift(room, sourcePlayerId, gift) {
  if (room.phase !== 'playing') return;
  const source = room.players.get(sourcePlayerId);
  if (!source || !source.alive || !source.connected) return;

  const meta = { viewer: gift.viewer, viewerAvatar: gift.viewerAvatar, giftIcon: gift.giftIcon };
  
  // Ищем подарок в Триггерах
  const trigger = room.rules.triggers.find(t => t.giftIds.includes(gift.giftId));
  
  if (trigger) {
    // Если подарок есть в триггерах, используем правило триггера
    if (trigger.action === 'damage') {
      const opponents = getOpponents(room, source.playerId);
      opponents.forEach(t => applyDamage(room, t, trigger.amount, meta));
    } else if (trigger.action === 'heal') {
      applyHeal(room, source, trigger.amount, meta);
    }
  } else {
    // Если подарка нет в триггерах, наносим урон в размере стоимости подарка (totalCoins)
    const defaultDamage = gift.totalCoins || 0;
    
    // Игнорируем бесплатные подарки (розочки без стоимости и т.д.)
    if (defaultDamage > 0) {
      const opponents = getOpponents(room, source.playerId);
      opponents.forEach(t => applyDamage(room, t, defaultDamage, meta));
    }
  }

  checkVictory(room);
  emitSnapshot(room);
}

function ensureRoomId(value) {
  return safeText(value, 64).replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
}

io.on('connection', socket => {
  socket.on('create_room', payload => {
    try {
      const roomId = ensureRoomId(payload?.roomId);
      const playerId = cleanId(payload?.player?.playerId || payload?.player?.username);
      if (!roomId || !playerId) return;
      if (rooms.has(roomId)) return socket.emit('room_error', 'Комната уже существует.');

      const rules = normalizeRules(payload.rules);
      const room = {
        roomId, hostSocketId: socket.id, hostPlayerId: playerId,
        rules, phase: 'waiting', winnerPlayerId: null, players: new Map()
      };
      room.players.set(playerId, makePlayer({ ...payload.player, playerId }, rules));
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = playerId;
      emitSnapshot(room);
    } catch (e) { socket.emit('room_error', 'Ошибка создания комнаты.'); }
  });

  socket.on('join_room', payload => {
    const roomId = ensureRoomId(payload?.roomId);
    const room = rooms.get(roomId);
    const playerId = cleanId(payload?.player?.playerId || payload?.player?.username);
    if (!room || !playerId) return;
    if (room.players.has(playerId) && room.players.get(playerId).connected) return socket.emit('room_error', 'Игрок уже в сети.');

    let player = room.players.get(playerId);
    if (!player) {
      player = makePlayer({ ...payload.player, playerId }, room.rules);
      room.players.set(playerId, player);
    } else {
      player.connected = true;
      player.nickname = payload.player.nickname || player.nickname;
      player.avatar = payload.player.avatar || player.avatar;
    }
    
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    emitSnapshot(room);
  });

  socket.on('update_rules', payload => {
    const room = rooms.get(socket.data.roomId);
    if (!room || socket.id !== room.hostSocketId) return;
    room.rules = normalizeRules(payload?.rules || room.rules);
    for (const p of room.players.values()) {
      p.maxHp = room.rules.maxHp;
      p.hp = Math.min(p.hp, p.maxHp);
    }
    emitSnapshot(room);
  });

  socket.on('start_battle', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || socket.id !== room.hostSocketId) return;
    
    // Если начинается полностью новый матч (после гранд победы или вручную), сбрасываем победы
    if (room.phase === 'match_won' || room.phase === 'waiting') {
      for (const p of room.players.values()) p.wins = 0;
    }
    
    for (const p of room.players.values()) {
      p.hp = room.rules.startHp;
      p.alive = true;
    }
    room.winnerPlayerId = null;
    room.phase = 'playing';
    emitSnapshot(room);
    emitEvent(room, { type: 'start', targetPlayerIds: [], label: 'БОЙ НАЧАЛСЯ!' });
  });

  socket.on('reset_battle', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || socket.id !== room.hostSocketId) return;
    room.phase = 'waiting';
    room.winnerPlayerId = null;
    for (const p of room.players.values()) {
      p.hp = room.rules.startHp;
      p.alive = true;
      p.wins = 0;
    }
    emitSnapshot(room);
  });

  socket.on('gift_event', gift => {
    const room = rooms.get(socket.data.roomId);
    if (room) processGift(room, socket.data.playerId, gift);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (socket.id === room.hostSocketId) {
      io.to(room.roomId).emit('room_closed', 'HOST покинул комнату.');
      rooms.delete(room.roomId);
    } else {
      const p = room.players.get(socket.data.playerId);
      if (p) p.connected = false;
      checkVictory(room);
      emitSnapshot(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
