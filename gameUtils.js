// shogi-server/gameUtils.js

const PIECE_TYPES = {
  Pawn: 'Pawn', Lance: 'Lance', Knight: 'Knight', Silver: 'Silver',
  Gold: 'Gold', Bishop: 'Bishop', Rook: 'Rook', King: 'King',
  PromotedPawn: 'PromotedPawn', PromotedLance: 'PromotedLance',
  PromotedKnight: 'PromotedKnight', PromotedSilver: 'PromotedSilver',
  Horse: 'Horse', Dragon: 'Dragon'
};

const SFEN_MAP = {
  [PIECE_TYPES.Pawn]: 'p', [PIECE_TYPES.Lance]: 'l', [PIECE_TYPES.Knight]: 'n',
  [PIECE_TYPES.Silver]: 's', [PIECE_TYPES.Gold]: 'g', [PIECE_TYPES.Bishop]: 'b',
  [PIECE_TYPES.Rook]: 'r', [PIECE_TYPES.King]: 'k',
  [PIECE_TYPES.PromotedPawn]: '+p', [PIECE_TYPES.PromotedLance]: '+l',
  [PIECE_TYPES.PromotedKnight]: '+n', [PIECE_TYPES.PromotedSilver]: '+s',
  [PIECE_TYPES.Horse]: '+b', [PIECE_TYPES.Dragon]: '+r'
};

const EMPTY_HAND = {
  [PIECE_TYPES.Pawn]: 0, [PIECE_TYPES.Lance]: 0, [PIECE_TYPES.Knight]: 0, [PIECE_TYPES.Silver]: 0,
  [PIECE_TYPES.Gold]: 0, [PIECE_TYPES.Bishop]: 0, [PIECE_TYPES.Rook]: 0, [PIECE_TYPES.King]: 0,
  [PIECE_TYPES.PromotedPawn]: 0, [PIECE_TYPES.PromotedLance]: 0, [PIECE_TYPES.PromotedKnight]: 0,
  [PIECE_TYPES.PromotedSilver]: 0, [PIECE_TYPES.Horse]: 0, [PIECE_TYPES.Dragon]: 0,
};

const createInitialBoard = () => {
  const board = Array(9).fill(null).map(() => Array(9).fill(null));
  const place = (x, y, type, owner) => { board[y][x] = { type, owner, isPromoted: false }; };
  
  // Gote
  place(0, 0, 'Lance', 'gote'); place(1, 0, 'Knight', 'gote'); place(2, 0, 'Silver', 'gote');
  place(3, 0, 'Gold', 'gote'); place(4, 0, 'King', 'gote'); place(5, 0, 'Gold', 'gote');
  place(6, 0, 'Silver', 'gote'); place(7, 0, 'Knight', 'gote'); place(8, 0, 'Lance', 'gote');
  place(1, 1, 'Rook', 'gote'); place(7, 1, 'Bishop', 'gote');
  for (let i = 0; i < 9; i++) place(i, 2, 'Pawn', 'gote');

  // Sente
  place(0, 8, 'Lance', 'sente'); place(1, 8, 'Knight', 'sente'); place(2, 8, 'Silver', 'sente');
  place(3, 8, 'Gold', 'sente'); place(4, 8, 'King', 'sente'); place(5, 8, 'Gold', 'sente');
  place(6, 8, 'Silver', 'sente'); place(7, 8, 'Knight', 'sente'); place(8, 8, 'Lance', 'sente');
  place(7, 7, 'Rook', 'sente'); place(1, 7, 'Bishop', 'sente');
  for (let i = 0; i < 9; i++) place(i, 6, 'Pawn', 'sente');

  return board;
};

const getReversePieceType = (type) => {
  switch (type) {
    case 'PromotedPawn': return 'Pawn';
    case 'PromotedLance': return 'Lance';
    case 'PromotedKnight': return 'Knight';
    case 'PromotedSilver': return 'Silver';
    case 'Horse': return 'Bishop';
    case 'Dragon': return 'Rook';
    default: return type;
  }
};

const promotePiece = (type) => {
  switch (type) {
    case 'Pawn': return 'PromotedPawn';
    case 'Lance': return 'PromotedLance';
    case 'Knight': return 'PromotedKnight';
    case 'Silver': return 'PromotedSilver';
    case 'Bishop': return 'Horse';
    case 'Rook': return 'Dragon';
    default: return type;
  }
};

const hasObstacle = (x1, y1, x2, y2, board) => {
  const dx = Math.sign(x2 - x1);
  const dy = Math.sign(y2 - y1);
  let x = x1 + dx;
  let y = y1 + dy;
  while (x !== x2 || y !== y2) {
    if (board[y][x] !== null) return true;
    x += dx;
    y += dy;
  }
  return false;
};

// 駒の移動ルール判定
const canPieceMoveTo = (board, from, to, pieceObj, currentTurn) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const forward = currentTurn === 'sente' ? -1 : 1;
  const type = pieceObj.type;
  const promoted = pieceObj.isPromoted;

  const goldMove = () => {
    const absDx = Math.abs(dx);
    if ((absDx === 1 && dy === 0) || (absDx === 0 && Math.abs(dy) === 1)) return true;
    if (absDx === 1 && dy === forward) return true;
    return false;
  };

  switch (type) {
    case 'Pawn': return !promoted ? (dx === 0 && dy === forward) : goldMove();
    case 'King': return Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
    case 'Gold': return goldMove();
    case 'Silver':
      if (promoted) return goldMove();
      if (Math.abs(dx) <= 1 && dy === forward) return true;
      if (Math.abs(dx) === 1 && dy === -forward) return true;
      return false;
    case 'Knight':
      if (promoted) return goldMove();
      return Math.abs(dx) === 1 && dy === (forward * 2);
    case 'Lance':
      if (promoted) return goldMove();
      if (dx !== 0) return false;
      if (currentTurn === 'sente' ? (dy >= 0) : (dy <= 0)) return false;
      return !hasObstacle(from.x, from.y, to.x, to.y, board);
    case 'Bishop': case 'Horse':
      if (Math.abs(dx) === Math.abs(dy)) return !hasObstacle(from.x, from.y, to.x, to.y, board);
      if (promoted && (Math.abs(dx) + Math.abs(dy) === 1)) return true;
      return false;
    case 'Rook': case 'Dragon':
      if (dx === 0 || dy === 0) return !hasObstacle(from.x, from.y, to.x, to.y, board);
      if (promoted && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return true;
      return false;
    default:
        if(['PromotedPawn','PromotedLance','PromotedKnight','PromotedSilver'].includes(type)) return goldMove();
        return false;
  }
};

const applyMove = (currentBoard, currentHands, move, currentTurn) => {
  const newBoard = currentBoard.map(row => row.map(p => p ? {...p} : null));
  const newHands = { sente: { ...currentHands.sente }, gote: { ...currentHands.gote } };
  const nextTurn = currentTurn === 'sente' ? 'gote' : 'sente';

  if (move.drop) {
    newBoard[move.to.y][move.to.x] = { type: move.piece, owner: currentTurn, isPromoted: false };
    newHands[currentTurn][move.piece]--;
  } else {
    const piece = newBoard[move.from.y][move.from.x];
    const targetSquare = newBoard[move.to.y][move.to.x];
    if (targetSquare) {
      const capturedType = getReversePieceType(targetSquare.type);
      newHands[currentTurn][capturedType]++;
    }
    const newType = move.isPromoted ? promotePiece(piece.type) : piece.type;
    newBoard[move.to.y][move.to.x] = { ...piece, type: newType, isPromoted: move.isPromoted || piece.isPromoted };
    newBoard[move.from.y][move.from.x] = null;
  }
  return { board: newBoard, hands: newHands, turn: nextTurn };
};

// 王手判定
const isKingInCheck = (board, targetTurn) => {
  const attackerTurn = targetTurn === 'sente' ? 'gote' : 'sente';
  let kingPos = null;

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (p && p.type === 'King' && p.owner === targetTurn) {
        kingPos = { x, y };
        break;
      }
    }
    if (kingPos) break;
  }
  if (!kingPos) return false;

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (p && p.owner === attackerTurn) {
        if (canPieceMoveTo(board, {x, y}, kingPos, p, attackerTurn)) {
          return true;
        }
      }
    }
  }
  return false;
};

// 妥当な手か判定 (王手放置チェック含む)
const isValidMove = (board, hands, currentTurn, move) => {
  const { from, to, piece, drop, isPromoted } = move;

  if (to.x < 0 || to.x > 8 || to.y < 0 || to.y > 8) return false;
  const targetPiece = board[to.y][to.x];
  if (targetPiece && targetPiece.owner === currentTurn) return false;

  if (!drop && !isPromoted) {
     if (currentTurn === 'sente') {
        if (piece === 'Pawn' || piece === 'Lance') { if (to.y === 0) return false; }
        if (piece === 'Knight') { if (to.y <= 1) return false; }
     } else {
        if (piece === 'Pawn' || piece === 'Lance') { if (to.y === 8) return false; }
        if (piece === 'Knight') { if (to.y >= 7) return false; }
     }
  }

  // --- 移動ルールの基本チェック ---
  let isMoveOk = false;
  if (drop) {
    if (targetPiece !== null) return false;
    if (hands[currentTurn][piece] <= 0) return false;
    if (piece === 'Pawn') {
      for (let y = 0; y < 9; y++) {
        const p = board[y][to.x];
        if (p && p.owner === currentTurn && p.type === 'Pawn' && !p.isPromoted) return false;
      }
    }
    if (currentTurn === 'sente') {
      if ((piece === 'Pawn' || piece === 'Lance') && to.y === 0) return false;
      if (piece === 'Knight' && to.y <= 1) return false;
    } else {
      if ((piece === 'Pawn' || piece === 'Lance') && to.y === 8) return false;
      if (piece === 'Knight' && to.y >= 7) return false;
    }
    isMoveOk = true;
  } else {
    if (typeof from !== 'object') return false;
    const movingPiece = board[from.y][from.x];
    if (!movingPiece || movingPiece.owner !== currentTurn) return false;
    isMoveOk = canPieceMoveTo(board, from, to, movingPiece, currentTurn);
  }

  if (!isMoveOk) return false;

  // --- ★重要: 自殺手（王手放置）チェック ---
  // 仮に手を指してみる
  const nextState = applyMove(board, hands, move, currentTurn);
  // 指した後、自分の王様に王手が掛かっているなら、それは反則手
  if (isKingInCheck(nextState.board, currentTurn)) {
    return false;
  }

  return true;
};

const generateSFEN = (board, turn, hands) => {
  let sfen = "";
  for (let y = 0; y < 9; y++) {
    let empty = 0;
    for (let x = 0; x < 9; x++) {
      const p = board[y][x];
      if (!p) { empty++; continue; }
      if (empty > 0) { sfen += empty; empty = 0; }
      let char = SFEN_MAP[p.type] || '?';
      if (p.owner === 'sente') char = char.toUpperCase();
      sfen += char;
    }
    if (empty > 0) sfen += empty;
    if (y < 8) sfen += "/";
  }
  const handStr = (h) => Object.keys(h).sort().map(k => h[k] > 0 ? `${k}:${h[k]}` : '').join('');
  sfen += ` ${turn} S:${handStr(hands.sente)} G:${handStr(hands.gote)}`;
  return sfen;
};

module.exports = {
  createInitialBoard,
  isValidMove,
  applyMove,
  generateSFEN,
  isKingInCheck,
  EMPTY_HAND
};