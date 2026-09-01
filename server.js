const { Server } = require("socket.io");
const PORT = process.env.PORT || 3030;

const io = new Server(PORT, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

io.on("connection", (socket) => {
  
  socket.on("create_room", ({ roomId, player, rules }) => {
    if (rooms[roomId]) {
      return socket.emit("room_error", "Комната с таким кодом уже существует.");
    }
    rooms[roomId] = {
      roomId,
      hostPlayerId: player.playerId,
      phase: "waiting", // Возможные фазы: waiting, countdown, playing, round_won, match_won
      rules: rules || { startHp: 100, maxHp: 100, targetWins: 3, breakDuration: 10, triggers: [] },
      players: {
        [player.playerId]: { ...player, hp: rules?.startHp || 100, maxHp: rules?.maxHp || 100, wins: 0, alive: true }
      },
      countdownUntil: 0
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerId = player.playerId;
    io.to(roomId).emit("room_snapshot", rooms[roomId]);
  });

  socket.on("join_room", ({ roomId, player }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("room_error", "Комната не найдена.");
    if (room.phase !== "waiting" && !room.players[player.playerId]) {
      return socket.emit("room_error", "Бой уже начался.");
    }
    
    room.players[player.playerId] = {
      ...player,
      hp: room.rules.startHp,
      maxHp: room.rules.maxHp,
      wins: room.players[player.playerId]?.wins || 0,
      alive: true
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerId = player.playerId;
    io.to(roomId).emit("room_snapshot", room);
  });

  socket.on("update_rules", ({ rules }) => {
    const room = rooms[socket.roomId];
    if (room && room.hostPlayerId === socket.playerId) {
      room.rules = rules;
      io.to(socket.roomId).emit("room_snapshot", room);
    }
  });

  socket.on("start_battle", () => {
    const room = rooms[socket.roomId];
    if (!room || room.hostPlayerId !== socket.playerId) return;
    
    // Восстанавливаем всем HP перед новым боем
    Object.values(room.players).forEach(p => { 
        p.hp = room.rules.startHp; 
        p.maxHp = room.rules.maxHp; 
        p.alive = true; 
    });
    
    room.phase = "countdown";
    const COUNTDOWN_TIME = 10000; // 10 секунд обратного отсчета
    room.countdownUntil = Date.now() + COUNTDOWN_TIME; 
    io.to(socket.roomId).emit("room_snapshot", room);

    // Автоматический перевод в активную фазу
    setTimeout(() => {
      if (rooms[socket.roomId]?.phase === "countdown") {
        rooms[socket.roomId].phase = "playing";
        io.to(socket.roomId).emit("room_snapshot", rooms[socket.roomId]);
      }
    }, COUNTDOWN_TIME);
  });

  socket.on("reset_battle", () => {
    const room = rooms[socket.roomId];
    if (!room || room.hostPlayerId !== socket.playerId) return;
    Object.values(room.players).forEach(p => { 
        p.hp = room.rules.startHp; 
        p.wins = 0; 
        p.alive = true; 
    });
    room.phase = "waiting";
    io.to(socket.roomId).emit("room_snapshot", room);
  });

  socket.on("gift_event", (payload) => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== "playing") return;

    const trigger = room.rules.triggers.find(t => t.giftIds.includes(payload.giftId));
    if (!trigger) return;

    const targetIds = [];
    let eventType = trigger.action;
    const senderId = socket.playerId;
    const opponent = Object.values(room.players).find(p => p.playerId !== senderId);

    // Логика урона и победы
    if (trigger.action === "damage" && opponent) {
      opponent.hp = Math.max(0, opponent.hp - (trigger.amount * payload.count));
      targetIds.push(opponent.playerId);
      
      // Смерть противника = Победа в раунде
      if (opponent.hp <= 0 && opponent.alive) {
         opponent.alive = false;
         room.players[senderId].wins += 1;
         
         if (room.players[senderId].wins >= room.rules.targetWins) {
           room.phase = "match_won"; // Гранд финал
         } else {
           room.phase = "round_won"; // Конец обычного раунда
         }
         room.winnerPlayerId = senderId;
      }
    } 
    // Логика Хилла (Лечения)
    else if (trigger.action === "heal") {
      const self = room.players[senderId];
      if (self && self.alive) {
         self.hp = Math.min(self.maxHp, self.hp + (trigger.amount * payload.count));
         targetIds.push(self.playerId);
      }
    }

    // Рассылка визуального уведомления в Overlay HUD
    io.to(socket.roomId).emit("game_event", {
       type: eventType,
       amount: trigger.amount * payload.count,
       targetPlayerIds: targetIds,
       viewer: payload.viewer,
       viewerAvatar: payload.viewerAvatar,
       giftIcon: payload.giftIcon,
       count: payload.count
    });
    
    // Рассылка нового стейта (Обновленные HP)
    io.to(socket.roomId).emit("room_snapshot", room);
  });

  const handleLeave = () => {
    if (!socket.roomId || !rooms[socket.roomId]) return;
    const room = rooms[socket.roomId];

    if (room.hostPlayerId === socket.playerId) {
      // Если вышел создатель — уведомляем всех и удаляем комнату, чтобы она не висела на сервере пустышкой
      io.to(socket.roomId).emit("room_closed", "Создатель завершил игру.");
      io.in(socket.roomId).socketsLeave(socket.roomId);
      delete rooms[socket.roomId];
    } else {
      // Если вышел обычный игрок — удаляем только его
      delete room.players[socket.playerId];
      
      // Если комната совсем опустела - очищаем
      if (Object.keys(room.players).length === 0) {
        delete rooms[socket.roomId];
      } else {
        io.to(socket.roomId).emit("room_snapshot", room);
      }
    }
    socket.roomId = null;
    socket.playerId = null;
  };

  socket.on("leave_room", handleLeave);
  socket.on("disconnect", handleLeave);
});

console.log(`Мультиплеер сервер запущен на порту ${PORT}`);
