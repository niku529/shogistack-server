const { Server } = require("socket.io");
const { createInitialBoard, isValidMove, applyMove, generateSFEN, isKingInCheck, EMPTY_HAND } = require('./gameUtils');

const generateId = () => Math.random().toString(36).substr(2, 9);

const io = new Server(3001, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"] 
  },
  pingTimeout: 60000, 
  pingInterval: 25000
});

console.log("将棋サーバー起動: http://localhost:3001");

const rooms = new Map();
const socketUserMap = new Map();

const stopTimer = (room) => {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
};

// ★追加: 人数更新用の関数
const broadcastUserCounts = (roomId) => {
    // 全体の接続数
    const globalCount = io.engine.clientsCount;
    io.emit("update_global_count", globalCount);

    // その部屋の人数
    if (roomId) {
        const roomCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        io.in(roomId).emit("update_room_count", roomCount);
    }
};

io.on("connection", (socket) => {
  console.log("接続:", socket.id);
  // 接続した時点で全体人数は増えるので通知
  io.emit("update_global_count", io.engine.clientsCount);

  socket.on("join_room", ({ roomId, mode, userId, userName }) => {
    socket.join(roomId);
    
    const safeName = userName || "名無し";

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        history: [],
        board: createInitialBoard(),
        hands: { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } },
        sfenHistory: {},
        status: mode === 'analysis' ? 'analysis' : 'waiting',
        winner: null,
        players: { sente: null, gote: null },
        userIds: { sente: null, gote: null },
        playerNames: { sente: null, gote: null },
        ready: { sente: false, gote: false },
        rematchRequests: { sente: false, gote: false },
        settings: { initial: 600, byoyomi: 30, randomTurn: false, fixTurn: false },
        times: { sente: 600, gote: 600 },
        currentByoyomi: { sente: 30, gote: 30 },
        lastMoveTimestamp: 0,
        totalConsumedTimes: { sente: 0, gote: 0 },
        timerInterval: null,
        gameCount: 0
      });
    }
    
    const room = rooms.get(roomId);

    if (!room.playerNames) room.playerNames = { sente: null, gote: null };
    if (typeof room.gameCount === 'undefined') room.gameCount = 0;
    if (typeof room.settings.randomTurn === 'undefined') room.settings.randomTurn = false;
    if (typeof room.settings.fixTurn === 'undefined') room.settings.fixTurn = false;

    let myRole = 'audience';

    if (room.userIds.sente === userId) {
      myRole = 'sente'; room.players.sente = socket.id; room.playerNames.sente = safeName;
    } else if (room.userIds.gote === userId) {
      myRole = 'gote'; room.players.gote = socket.id; room.playerNames.gote = safeName;
    } else if (room.userIds.sente === null) {
      room.userIds.sente = userId; room.players.sente = socket.id; myRole = 'sente'; room.playerNames.sente = safeName;
    } else if (room.userIds.gote === null) {
      room.userIds.gote = userId; room.players.gote = socket.id; myRole = 'gote'; room.playerNames.gote = safeName;
    }

    socketUserMap.set(socket.id, { roomId, userId, userName: safeName, role: myRole });

    io.in(roomId).emit("receive_message", { 
      id: generateId(), 
      text: `${safeName} さんが入室しました`, 
      role: 'system', 
      timestamp: Date.now() 
    });

    socket.emit("sync", {
      history: room.history,
      status: room.status,
      winner: room.winner,
      yourRole: myRole,
      ready: room.ready,
      settings: room.settings,
      times: room.times,
      rematchRequests: room.rematchRequests,
      playerNames: room.playerNames
    });
    
    io.in(roomId).emit("player_names_updated", room.playerNames);
    io.in(roomId).emit("ready_status", room.ready);
    io.in(roomId).emit("rematch_status", room.rematchRequests);

    // ★追加: 人数更新を通知
    broadcastUserCounts(roomId);
  });

  socket.on("send_message", ({ roomId, message, role, userName, userId }) => {
    let senderName = userName;
    let senderId = userId;

    if (!senderName || !senderId) {
        const sender = socketUserMap.get(socket.id);
        if (sender) {
            if (!senderName) senderName = sender.userName;
            if (!senderId) senderId = sender.userId;
        } else {
            senderName = senderName || "不明";
        }
    }
    
    io.in(roomId).emit("receive_message", { 
        id: generateId(), 
        text: message, 
        role, 
        userName: senderName, 
        userId: senderId, 
        timestamp: Date.now() 
    });
  });

  socket.on("update_settings", ({ roomId, settings }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room.status === 'waiting') {
        room.settings = settings;
        io.in(roomId).emit("settings_updated", settings);
      }
    }
  });

  socket.on("toggle_ready", ({ roomId, role }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (role !== 'sente' && role !== 'gote') return;

      room.ready[role] = !room.ready[role];
      io.in(roomId).emit("ready_status", room.ready);

      if (room.ready.sente && room.ready.gote) {
        let swapped = false;
        if (room.settings.randomTurn) {
            const isRematch = room.gameCount > 0;
            if (isRematch && room.settings.fixTurn) {
                swapped = false; 
            } else {
                if (Math.random() < 0.5) {
                    swapped = true;
                }
            }
        }

        if (swapped) {
            [room.players.sente, room.players.gote] = [room.players.gote, room.players.sente];
            [room.userIds.sente, room.userIds.gote] = [room.userIds.gote, room.userIds.sente];
            [room.playerNames.sente, room.playerNames.gote] = [room.playerNames.gote, room.playerNames.sente];
            
            if (room.players.sente) {
                const u = socketUserMap.get(room.players.sente);
                if (u) u.role = 'sente';
            }
            if (room.players.gote) {
                const u = socketUserMap.get(room.players.gote);
                if (u) u.role = 'gote';
            }
            
            [room.players.sente, room.players.gote, ...Array.from(room.players.audience || [])].forEach(socketId => {
                if (!socketId) return;
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    const u = socketUserMap.get(socketId);
                    socket.emit("sync", {
                        history: [],
                        status: 'playing',
                        winner: null,
                        yourRole: u ? u.role : 'audience',
                        ready: { sente: false, gote: false },
                        settings: room.settings,
                        times: { sente: room.settings.initial, gote: room.settings.initial },
                        rematchRequests: { sente: false, gote: false },
                        playerNames: room.playerNames
                    });
                }
            });
            
            io.in(roomId).emit("receive_message", { 
                id: generateId(), 
                text: "振り駒の結果、手番が入れ替わりました", 
                role: 'system', 
                timestamp: Date.now() 
            });
        }

        stopTimer(room);
        room.history = [];
        room.board = createInitialBoard();
        room.hands = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
        room.sfenHistory = {}; 
        
        const initialSfen = generateSFEN(room.board, 'sente', room.hands);
        room.sfenHistory[initialSfen] = 1;

        room.status = 'playing';
        room.winner = null;
        room.ready = { sente: false, gote: false };
        room.rematchRequests = { sente: false, gote: false };
        room.times = { sente: room.settings.initial, gote: room.settings.initial };
        room.currentByoyomi = { sente: room.settings.byoyomi, gote: room.settings.byoyomi };
        
        room.lastMoveTimestamp = Date.now();
        room.totalConsumedTimes = { sente: 0, gote: 0 };
        room.gameCount++;

        io.in(roomId).emit("game_started");
        
        if (!swapped) {
             io.in(roomId).emit("sync", {
                history: [], 
                status: 'playing', 
                winner: null, 
                ready: room.ready, 
                settings: room.settings, 
                times: room.times, 
                rematchRequests: room.rematchRequests, 
                playerNames: room.playerNames
            });
        } else {
            io.in(roomId).emit("player_names_updated", room.playerNames);
        }
        
        startTimer(roomId);
      }
    }
  });

  const startTimer = (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const turn = room.history.length % 2 === 0 ? 'sente' : 'gote';
    room.timerInterval = setInterval(() => {
      if (room.times[turn] > 0) room.times[turn]--;
      else room.currentByoyomi[turn]--;

      if (room.times[turn] === 0 && room.currentByoyomi[turn] <= -1) {
        stopTimer(room);
        room.status = 'finished';
        room.winner = turn === 'sente' ? 'gote' : 'sente';
        io.in(roomId).emit("game_finished", { winner: room.winner, reason: 'timeout' });
      }
      
      const displayTimes = { ...room.times };
      const displayByoyomi = {
          sente: Math.max(0, room.currentByoyomi.sente),
          gote: Math.max(0, room.currentByoyomi.gote)
      };

      io.in(roomId).emit("time_update", { times: displayTimes, currentByoyomi: displayByoyomi });
    }, 1000);
  };

  socket.on("move", ({ roomId, move, branchIndex }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (!room.playerNames) room.playerNames = { sente: null, gote: null };

      if (room.status === 'analysis' || room.status === 'finished') {
        if (typeof branchIndex === 'number' && branchIndex < room.history.length) {
           room.history = room.history.slice(0, branchIndex);
           let b = createInitialBoard();
           let h = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
           let t = 'sente';
           for (const m of room.history) {
              const r = applyMove(b, h, m, t);
              b = r.board; h = r.hands; t = r.turn;
           }
           room.board = b;
           room.hands = h;
        }
        room.history.push(move);
        io.in(roomId).emit("sync", {
           history: room.history, status: room.status, winner: room.winner, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: room.rematchRequests, playerNames: room.playerNames
        });
        return;
      }

      const currentTurn = room.history.length % 2 === 0 ? 'sente' : 'gote';
      const nextTurn = currentTurn === 'sente' ? 'gote' : 'sente';
      if (!isValidMove(room.board, room.hands, currentTurn, move)) return; 
      stopTimer(room);

      if (room.status === 'playing') {
        const now = Date.now();
        const spentTimeMs = now - room.lastMoveTimestamp;
        const spentSeconds = Math.max(0, Math.floor(spentTimeMs / 1000));
        room.totalConsumedTimes[currentTurn] += spentSeconds;
        room.lastMoveTimestamp = now;

        const res = applyMove(room.board, room.hands, move, currentTurn);
        room.board = res.board;
        room.hands = res.hands;
        
        const isCheck = isKingInCheck(room.board, nextTurn);
        const moveWithInfo = { ...move, isCheck, time: { now: spentSeconds, total: room.totalConsumedTimes[currentTurn] } };
        
        room.currentByoyomi[currentTurn] = room.settings.byoyomi;
        
        room.history.push(moveWithInfo);
        io.in(roomId).emit("move", moveWithInfo);

        const sfen = generateSFEN(room.board, nextTurn, room.hands);
        room.sfenHistory[sfen] = (room.sfenHistory[sfen] || 0) + 1;
        if (room.sfenHistory[sfen] >= 4) {
           stopTimer(room);
           room.status = 'finished';
           
           let indices = [];
           let tempBoard = createInitialBoard();
           let tempHands = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
           let tempTurn = 'sente';
           const initialSfen = generateSFEN(tempBoard, 'sente', tempHands);
           if (initialSfen === sfen) indices.push(-1);
           room.history.forEach((m, idx) => {
              const r = applyMove(tempBoard, tempHands, m, tempTurn);
              tempBoard = r.board; tempHands = r.hands; tempTurn = r.turn;
              const currentSfen = generateSFEN(tempBoard, tempTurn, tempHands);
              if (currentSfen === sfen) indices.push(idx);
           });
           const lastIdx = indices[indices.length - 1]; 
           const prevIdx = indices[indices.length - 2]; 
           let senteContinuousCheck = true;
           let goteContinuousCheck = true;
           let hasSenteMove = false;
           let hasGoteMove = false;
           for (let i = prevIdx + 1; i <= lastIdx; i++) {
              const m = room.history[i];
              if (i % 2 === 0) { hasSenteMove = true; if (!m.isCheck) senteContinuousCheck = false; } 
              else { hasGoteMove = true; if (!m.isCheck) goteContinuousCheck = false; }
           }
           if (hasSenteMove && senteContinuousCheck) { 
               room.winner = 'gote'; 
               io.in(roomId).emit("game_finished", { winner: 'gote', reason: 'illegal_sennichite' }); 
           } else if (hasGoteMove && goteContinuousCheck) { 
               room.winner = 'sente'; 
               io.in(roomId).emit("game_finished", { winner: 'sente', reason: 'illegal_sennichite' }); 
           } else { 
               room.winner = null; 
               io.in(roomId).emit("game_finished", { winner: null, reason: 'sennichite' }); 
           }
           return;
        }
        startTimer(roomId);
      }
    }
  });

  socket.on("game_resign", ({ roomId, loser }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      stopTimer(room);
      room.status = 'finished';
      room.winner = loser === 'sente' ? 'gote' : 'sente';
      io.in(roomId).emit("game_finished", { winner: room.winner, reason: 'resign' });
    }
  });

  socket.on("undo", (roomId) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (!room.playerNames) room.playerNames = { sente: null, gote: null };
      if (room.status !== 'playing' && room.history.length > 0) {
        room.history.pop();
        let b = createInitialBoard();
        let h = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
        let t = 'sente';
        room.sfenHistory = {}; 
        const initialSfen = generateSFEN(b, 'sente', h);
        room.sfenHistory[initialSfen] = 1;
        for (const m of room.history) {
           const r = applyMove(b, h, m, t);
           b = r.board; h = r.hands; t = r.turn;
           const sfen = generateSFEN(b, t, h);
           room.sfenHistory[sfen] = (room.sfenHistory[sfen] || 0) + 1;
        }
        room.board = b; room.hands = h;
        io.in(roomId).emit("sync", {
          history: room.history, status: room.status, winner: room.winner, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: room.rematchRequests, playerNames: room.playerNames
        });
      }
    }
  });

  socket.on("reset", (roomId) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (!room.playerNames) room.playerNames = { sente: null, gote: null };
      stopTimer(room);
      room.history = [];
      room.board = createInitialBoard();
      room.hands = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
      room.sfenHistory = {};
      room.winner = null;
      room.ready = { sente: false, gote: false };
      room.rematchRequests = { sente: false, gote: false };
      room.times = { sente: room.settings.initial, gote: room.settings.initial };
      room.gameCount = 0;
      io.in(roomId).emit("sync", {
        history: [], status: room.status, winner: null, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: room.rematchRequests, playerNames: room.playerNames
      });
    }
  });

  socket.on("rematch", ({ roomId, role }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (!room.playerNames) room.playerNames = { sente: null, gote: null };
      if (role !== 'sente' && role !== 'gote') return;
      room.rematchRequests[role] = true;
      io.in(roomId).emit("rematch_status", room.rematchRequests);
      if (room.rematchRequests.sente && room.rematchRequests.gote) {
        stopTimer(room);
        room.history = [];
        room.board = createInitialBoard();
        room.hands = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
        room.sfenHistory = {};
        room.status = 'waiting';
        room.winner = null;
        room.ready = { sente: false, gote: false };
        room.rematchRequests = { sente: false, gote: false };
        room.times = { sente: room.settings.initial, gote: room.settings.initial };
        room.currentByoyomi = { sente: room.settings.byoyomi, gote: room.settings.byoyomi };
        room.lastMoveTimestamp = Date.now();
        room.totalConsumedTimes = { sente: 0, gote: 0 };
        io.in(roomId).emit("sync", {
          history: [], status: 'waiting', winner: null, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: { sente: false, gote: false }, playerNames: room.playerNames
        });
      }
    }
  });
  
  socket.on("disconnect", () => {
    if (socketUserMap.has(socket.id)) {
      const { roomId, userName, role } = socketUserMap.get(socket.id);
      
      socketUserMap.delete(socket.id); // ★修正: 先に削除してからカウント通知
      broadcastUserCounts(roomId);     // ★追加: 減った人数を通知

      io.in(roomId).emit("receive_message", { 
        id: generateId(), text: `${userName} さんが退出しました`, role: 'system', timestamp: Date.now() 
      });
      if (rooms.has(roomId)) {
        const room = rooms.get(roomId);
        if (role === 'sente' || role === 'gote') {
           if (room.rematchRequests[role]) {
              room.rematchRequests[role] = false;
              io.in(roomId).emit("rematch_status", room.rematchRequests);
           }
           if (room.ready[role]) {
              room.ready[role] = false;
              io.in(roomId).emit("ready_status", room.ready);
           }
        }
      }
    }
    console.log("切断:", socket.id);
  });
});