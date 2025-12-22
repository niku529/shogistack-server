const { Server } = require("socket.io");
const Database = require('better-sqlite3');
const { createInitialBoard, isValidMove, applyMove, generateSFEN, isKingInCheck, EMPTY_HAND } = require('./gameUtils');

const generateId = () => Math.random().toString(36).substr(2, 9);

// DB設定
const db = new Database('shogi.db'); 
db.prepare(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    data TEXT,
    updated_at INTEGER
  )
`).run();

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

// --- 時間フォーマット用ユーティリティ ---
const formatDuration = (seconds) => {
  if (seconds < 0) return "0秒";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}秒`;
  return `${m}分${s}秒`;
};

// --- 終局処理の共通関数 ---
const handleGameEnd = (room, roomId, winner, reason) => {
    stopTimer(room);
    room.status = 'finished';
    room.winner = winner;
    saveRoom(roomId);

    io.in(roomId).emit("game_finished", { winner, reason });

    const now = Date.now();
    const gameDurationSec = Math.floor((now - (room.gameStartTime || now)) / 1000);
    const totalMoves = room.history.length;
    
    // 最長思考手の集計
    let maxThinkSente = { time: 0, moveNum: 0 };
    let maxThinkGote = { time: 0, moveNum: 0 };

    room.history.forEach((move, idx) => {
        const thinkTime = move.time ? move.time.now : 0;
        const moveNum = idx + 1;
        
        if (idx % 2 === 0) { // 先手
            if (thinkTime > maxThinkSente.time) maxThinkSente = { time: thinkTime, moveNum };
        } else { // 後手
            if (thinkTime > maxThinkGote.time) maxThinkGote = { time: thinkTime, moveNum };
        }
    });

    let reasonText = "";
    if (reason === 'resign') reasonText = "投了";
    else if (reason === 'timeout') reasonText = "時間切れ";
    else if (reason === 'sennichite') reasonText = "千日手";
    else if (reason === 'illegal_sennichite') reasonText = "反則(連続王手の千日手)";

    // 各プレイヤーへのメッセージ作成関数
    const sendStatsToPlayer = (role) => {
        const socketId = room.players[role];
        if (!socketId) return;

        const isWinner = winner === role;
        const resultText = winner ? (isWinner ? `あなたの勝ち (${reasonText})` : `あなたの負け (${reasonText})`) : `引き分け (${reasonText})`;
        
        const opponentRole = role === 'sente' ? 'gote' : 'sente';
        
        const myTimeSec = Math.floor(room.totalConsumedTimes[role] / 1000);
        const oppTimeSec = Math.floor(room.totalConsumedTimes[opponentRole] / 1000);

        // 自分だけの最長思考手を取得
        const myMax = role === 'sente' ? maxThinkSente : maxThinkGote;

        // ★修正: 相手の最長思考手は削除し、表記を「最長思考手」に統一
        const message = `【対局結果】
${resultText}
手数：${totalMoves}手
対局時間：${formatDuration(gameDurationSec)}
あなたの消費時間：${formatDuration(myTimeSec)}
相手の消費時間：${formatDuration(oppTimeSec)}
最長思考手：${myMax.moveNum > 0 ? `${myMax.moveNum}手目 (${formatDuration(myMax.time)})` : '-'}`;

        io.to(socketId).emit("receive_message", {
            id: generateId(),
            text: message,
            role: 'log',
            userName: 'ログ',
            userId: 'system-log',
            timestamp: Date.now()
        });
    };

    sendStatsToPlayer('sente');
    sendStatsToPlayer('gote');
};


// --- DBヘルパー ---
const loadRoomsFromDB = () => {
  try {
    const rows = db.prepare("SELECT * FROM rooms").all();
    let count = 0;
    for (const row of rows) {
      try {
        const roomData = JSON.parse(row.data);
        roomData.timerInterval = null; 
        rooms.set(row.id, roomData);
        count++;
      } catch (e) {
        console.error(`Room ${row.id} parse error:`, e);
      }
    }
    console.log(`${count} rooms loaded from DB.`);
  } catch (e) {
    console.error("DB Load Error:", e);
  }
};

const saveRoom = (roomId) => {
  const room = rooms.get(roomId);
  if (!room) return;
  const { timerInterval, ...dataToSave } = room;
  const json = JSON.stringify(dataToSave);
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO rooms (id, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(roomId, json, now);
  } catch (e) {
    console.error(`DB Save Error (${roomId}):`, e);
  }
};

setInterval(() => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const result = db.prepare("DELETE FROM rooms WHERE updated_at < ?").run(oneDayAgo);
    if (result.changes > 0) {
      for (const [id, room] of rooms.entries()) {
        const roomSockets = io.sockets.adapter.rooms.get(id);
        if (room.lastMoveTimestamp < oneDayAgo && (!roomSockets || roomSockets.size === 0)) {
           rooms.delete(id);
        }
      }
    }
  } catch (e) {
    console.error("Cleanup Error:", e);
  }
}, 60 * 60 * 1000);

loadRoomsFromDB();

const stopTimer = (room) => {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
};

const broadcastUserCounts = (roomId) => {
    const globalCount = io.engine.clientsCount;
    io.emit("update_global_count", globalCount);
    if (roomId) {
        const roomCount = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        io.in(roomId).emit("update_room_count", roomCount);
    }
};

const broadcastConnectionStatus = (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const isSenteOnline = room.players.sente ? io.sockets.sockets.has(room.players.sente) : false;
    const isGoteOnline = room.players.gote ? io.sockets.sockets.has(room.players.gote) : false;
    io.in(roomId).emit("connection_status_update", { sente: isSenteOnline, gote: isGoteOnline });
};

io.on("connection", (socket) => {
  console.log("接続:", socket.id);
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
        lastMoveTimestamp: Date.now(), 
        totalConsumedTimes: { sente: 0, gote: 0 },
        timerInterval: null,
        gameCount: 0,
        gameStartTime: 0
      });
      saveRoom(roomId);
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
    saveRoom(roomId);

    io.in(roomId).emit("receive_message", { 
      id: generateId(), text: `${safeName} さんが入室しました`, role: 'system', timestamp: Date.now() 
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
    broadcastUserCounts(roomId);
    broadcastConnectionStatus(roomId);
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
        id: generateId(), text: message, role, userName: senderName, userId: senderId, timestamp: Date.now() 
    });
  });

  socket.on("update_settings", ({ roomId, settings }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (room.status === 'waiting') {
        room.settings = settings;
        saveRoom(roomId);
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
            if (isRematch && room.settings.fixTurn) swapped = false; 
            else if (Math.random() < 0.5) swapped = true;
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
                        history: [], status: 'playing', winner: null, yourRole: u ? u.role : 'audience',
                        ready: { sente: false, gote: false }, settings: room.settings,
                        times: { sente: room.settings.initial, gote: room.settings.initial },
                        rematchRequests: { sente: false, gote: false }, playerNames: room.playerNames
                    });
                }
            });
            io.in(roomId).emit("receive_message", { 
                id: generateId(), text: "振り駒の結果、手番が入れ替わりました", role: 'system', timestamp: Date.now() 
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
        room.gameStartTime = Date.now();

        saveRoom(roomId);
        io.in(roomId).emit("game_started");
        
        if (!swapped) {
             io.in(roomId).emit("sync", {
                history: [], status: 'playing', winner: null, ready: room.ready, settings: room.settings,
                times: room.times, rematchRequests: room.rematchRequests, playerNames: room.playerNames
            });
        } else {
            io.in(roomId).emit("player_names_updated", room.playerNames);
        }
        
        broadcastConnectionStatus(roomId);
        startTimer(roomId);
      }
    }
  });

  const startTimer = (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const turn = room.history.length % 2 === 0 ? 'sente' : 'gote';
    
    room.timerInterval = setInterval(() => {
      const now = Date.now();
      const elapsedTotalMs = now - room.lastMoveTimestamp;
      const elapsedSeconds = Math.floor(elapsedTotalMs / 1000);

      const currentRemaining = room.times[turn] - elapsedSeconds;

      let displayTimes = { ...room.times };
      let displayByoyomi = { ...room.currentByoyomi };

      if (currentRemaining > 0) {
          displayTimes[turn] = currentRemaining;
      } else {
          displayTimes[turn] = 0;
          const overTime = -currentRemaining; 
          const remainingByoyomi = room.settings.byoyomi - overTime;
          displayByoyomi[turn] = remainingByoyomi;

          if (remainingByoyomi <= -1) {
            handleGameEnd(room, roomId, turn === 'sente' ? 'gote' : 'sente', 'timeout');
            return;
          }
      }

      io.in(roomId).emit("time_update", { 
          times: { sente: Math.max(0, displayTimes.sente), gote: Math.max(0, displayTimes.gote) }, 
          currentByoyomi: { sente: Math.max(0, displayByoyomi.sente), gote: Math.max(0, displayByoyomi.gote) }
      });
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
        saveRoom(roomId);
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
        
        // ★修正: 持ち時間計算用（秒単位の切り捨て）
        const spentSecondsForTimer = Math.floor(spentTimeMs / 1000);
        
        if (room.times[currentTurn] > 0) {
            room.times[currentTurn] = Math.max(0, room.times[currentTurn] - spentSecondsForTimer);
        }

        // ★修正: 集計用はミリ秒単位で正確に加算
        room.totalConsumedTimes[currentTurn] += spentTimeMs;
        room.lastMoveTimestamp = now;

        const res = applyMove(room.board, room.hands, move, currentTurn);
        room.board = res.board;
        room.hands = res.hands;
        
        const isCheck = isKingInCheck(room.board, nextTurn);
        const moveWithInfo = { 
            ...move, 
            isCheck, 
            time: { 
                now: spentSecondsForTimer, // クライアント表示は秒でOK
                total: Math.floor(room.totalConsumedTimes[currentTurn] / 1000) // 表示用合計も秒に変換
            } 
        };
        
        room.currentByoyomi[currentTurn] = room.settings.byoyomi;
        
        room.history.push(moveWithInfo);
        saveRoom(roomId);

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
               handleGameEnd(room, roomId, 'gote', 'illegal_sennichite');
           } else if (hasGoteMove && goteContinuousCheck) { 
               handleGameEnd(room, roomId, 'sente', 'illegal_sennichite');
           } else { 
               handleGameEnd(room, roomId, null, 'sennichite');
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
      handleGameEnd(room, roomId, loser === 'sente' ? 'gote' : 'sente', 'resign');
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
        saveRoom(roomId);
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
      saveRoom(roomId);
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
        saveRoom(roomId);
        io.in(roomId).emit("sync", {
          history: [], status: 'waiting', winner: null, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: { sente: false, gote: false }, playerNames: room.playerNames
        });
      }
    }
  });
  
  socket.on("disconnect", () => {
    if (socketUserMap.has(socket.id)) {
      const { roomId, userName, role } = socketUserMap.get(socket.id);
      
      socketUserMap.delete(socket.id); 
      broadcastUserCounts(roomId);     
      broadcastConnectionStatus(roomId);

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