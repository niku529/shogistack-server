const { Server } = require("socket.io");
const { createInitialBoard, isValidMove, applyMove, generateSFEN, isKingInCheck, EMPTY_HAND } = require('./gameUtils');

const generateId = () => Math.random().toString(36).substr(2, 9);

// 変更前: cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] }
// 変更後: 環境変数で許可するか、一旦すべて許可する（開発・個人利用ならこれでOK）
const io = new Server(3001, {
  cors: { 
    origin: "*",  // ★すべてのドメインからの接続を許可（本番で楽にするため）
    methods: ["GET", "POST"] 
  }
});

console.log("将棋サーバー起動: http://localhost:3001");

const rooms = new Map();

const stopTimer = (room) => {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
};

io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  socket.on("join_room", ({ roomId, mode, userId }) => {
    socket.join(roomId);
    
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
        ready: { sente: false, gote: false },
        rematchRequests: { sente: false, gote: false },
        settings: { initial: 600, byoyomi: 30 },
        times: { sente: 600, gote: 600 },
        currentByoyomi: { sente: 30, gote: 30 },
        lastMoveTimestamp: 0,
        totalConsumedTimes: { sente: 0, gote: 0 },
        timerInterval: null
      });
    }
    
    const room = rooms.get(roomId);
    let myRole = 'audience';

    if (room.userIds.sente === userId) {
      myRole = 'sente'; room.players.sente = socket.id;
    } else if (room.userIds.gote === userId) {
      myRole = 'gote'; room.players.gote = socket.id;
    } else if (room.userIds.sente === null) {
      room.userIds.sente = userId; room.players.sente = socket.id; myRole = 'sente';
    } else if (room.userIds.gote === null) {
      room.userIds.gote = userId; room.players.gote = socket.id; myRole = 'gote';
    }

    socket.emit("sync", {
      history: room.history,
      status: room.status,
      winner: room.winner,
      yourRole: myRole,
      ready: room.ready,
      settings: room.settings,
      times: room.times,
      rematchRequests: room.rematchRequests
    });
    
    io.in(roomId).emit("ready_status", room.ready);
    io.in(roomId).emit("rematch_status", room.rematchRequests);
  });

  socket.on("send_message", ({ roomId, message, role }) => {
    io.in(roomId).emit("receive_message", { id: generateId(), text: message, role, timestamp: Date.now() });
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

        io.in(roomId).emit("game_started");
        io.in(roomId).emit("sync", {
          history: [], status: 'playing', winner: null, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: room.rematchRequests
        });
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

      if (room.times[turn] === 0 && room.currentByoyomi[turn] === 0) {
        stopTimer(room);
        room.status = 'finished';
        room.winner = turn === 'sente' ? 'gote' : 'sente';
        io.in(roomId).emit("game_finished", { winner: room.winner, reason: 'timeout' });
      }
      io.in(roomId).emit("time_update", { times: room.times, currentByoyomi: room.currentByoyomi });
    }, 1000);
  };

  // ★修正: 分岐同期対応
  socket.on("move", ({ roomId, move, branchIndex }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      // 検討モードの場合の特殊処理
      if (room.status === 'analysis' || room.status === 'finished') {
        // 分岐（過去の手数から指された）場合、履歴を切り詰める
        if (typeof branchIndex === 'number' && branchIndex < room.history.length) {
           room.history = room.history.slice(0, branchIndex);
           
           // 盤面も再構築が必要
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
        
        // 新しい手を追加
        room.history.push(move);
        
        // 履歴が書き換わったので、全員に履歴ごと再同期(Sync)を送る
        io.in(roomId).emit("sync", {
           history: room.history,
           status: room.status,
           winner: room.winner,
           ready: room.ready,
           settings: room.settings,
           times: room.times,
           rematchRequests: room.rematchRequests
        });
        return;
      }

      // --- 以下、通常対局モード ---
      const currentTurn = room.history.length % 2 === 0 ? 'sente' : 'gote';
      const nextTurn = currentTurn === 'sente' ? 'gote' : 'sente';
      
      if (!isValidMove(room.board, room.hands, currentTurn, move)) {
        return; 
      }
      
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
        
        const moveWithInfo = { 
          ...move, 
          isCheck,
          time: { 
            now: spentSeconds, 
            total: room.totalConsumedTimes[currentTurn] 
          }
        };
        
        room.currentByoyomi[currentTurn] = room.settings.byoyomi;
        room.history.push(moveWithInfo);
        
        io.in(roomId).emit("move", moveWithInfo);

        // 千日手判定
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
              if (i % 2 === 0) { 
                 hasSenteMove = true;
                 if (!m.isCheck) senteContinuousCheck = false;
              } else { 
                 hasGoteMove = true;
                 if (!m.isCheck) goteContinuousCheck = false;
              }
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
        room.board = b;
        room.hands = h;

        io.in(roomId).emit("sync", {
          history: room.history, status: room.status, winner: room.winner, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: room.rematchRequests
        });
      }
    }
  });

  socket.on("reset", (roomId) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      stopTimer(room);
      room.history = [];
      room.board = createInitialBoard();
      room.hands = { sente: { ...EMPTY_HAND }, gote: { ...EMPTY_HAND } };
      room.sfenHistory = {};
      room.winner = null;
      room.ready = { sente: false, gote: false };
      room.rematchRequests = { sente: false, gote: false };
      room.times = { sente: room.settings.initial, gote: room.settings.initial };
      io.in(roomId).emit("sync", {
        history: [], status: room.status, winner: null, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: room.rematchRequests
      });
    }
  });

  socket.on("rematch", ({ roomId, role }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
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
          history: [], status: 'waiting', winner: null, ready: room.ready, settings: room.settings, times: room.times, rematchRequests: { sente: false, gote: false }
        });
      }
    }
  });
  
  socket.on("disconnect", () => {});
});