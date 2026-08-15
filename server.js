/**
 * מערכת טריוויה טלפונית - שרת מרכזי
 * =====================================================
 * מכיל:
 *  - קצה API עבור ימות המשיח (שיחות טלפון)
 *  - אתר ניהול (יצירת משחקים, שאלות)
 *  - עמוד שליטה למנחה (התקדמות בשאלות)
 *  - עמוד תצוגה למסך הגדול (שם משתתפים, שאלה, שעון, ניקוד)
 * =====================================================
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_TIMER_SECONDS = 60;
const CALL_SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 שעות

// ============================================================================
// אחסון נתונים - קובץ JSON פשוט (נטען לזיכרון, נשמר בכל שינוי)
// ============================================================================
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { games: {} };
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

let db = loadData();

// מצבי שיחה פעילים בזיכרון (לא נשמרים לקובץ - זמניים לאורך השיחה בלבד)
const callSessions = {}; // callId -> { gameCode, phone, step, expectKey, pc, waitParamBase }

function cleanupOldSessions() {
  const now = Date.now();
  for (const id in callSessions) {
    if (now - callSessions[id].createdAt > CALL_SESSION_TTL_MS) {
      delete callSessions[id];
    }
  }
}
setInterval(cleanupOldSessions, 10 * 60 * 1000);

// ============================================================================
// פונקציות עזר - משחק
// ============================================================================
function generateGameCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (db.games[code]);
  return code;
}

function createGame(name) {
  const code = generateGameCode();
  db.games[code] = {
    code,
    name: name || ('משחק ' + code),
    status: 'waiting', // waiting | active | finished
    currentQuestionIndex: -1,
    phase: 'idle', // idle | question | timer | reveal
    timerSeconds: DEFAULT_TIMER_SECONDS,
    timerEndsAt: null,
    questions: [],
    players: {}, // phone -> { name, score, answeredQuestions: { [qIndex]: 'correct'|'wrong' } }
    createdAt: Date.now(),
  };
  saveData();
  return db.games[code];
}

function getGame(code) {
  return db.games[code];
}

function addQuestion(code, text, correctAnswerText, points, timerSeconds) {
  const game = getGame(code);
  if (!game) return null;
  game.questions.push({
    text,
    correctAnswerText,
    points: Number(points) || 10,
    timerSeconds: Number(timerSeconds) || DEFAULT_TIMER_SECONDS,
  });
  saveData();
  return game;
}

function deleteQuestion(code, index) {
  const game = getGame(code);
  if (!game) return null;
  game.questions.splice(index, 1);
  saveData();
  return game;
}

function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.length === 9 && p.charAt(0) !== '0') p = '0' + p;
  return p;
}

// ============================================================================
// קצה API עבור ימות המשיח
// ============================================================================
// שומר את ApiPhone בסשן ברגע שהוא מגיע - חייב לרוץ לפני handleYemotRequest
app.use('/yemot', (req, res, next) => {
  const callId = req.query.ApiCallId;
  if (callId && callSessions[callId] && req.query.ApiPhone) {
    callSessions[callId].ApiPhone = req.query.ApiPhone;
  }
  next();
});

app.get('/yemot', (req, res) => {
  try {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return handleYemotRequest(req, res);
  } catch (err) {
    return res.send('id_list_message=t-אירעה שגיאה זמנית, אנא נסו שוב&go_to_folder=/');
  }
});

function handleYemotRequest(req, res) {
  const p = req.query;
  const callId = p.ApiCallId || 'no_session';

  if (p.hangup === 'yes') {
    return res.send('noop');
  }

  let session = callSessions[callId];

  // ----- שלב ראשון: בקשת קוד משחק -----
  if (!session) {
    session = { createdAt: Date.now(), step: 'ask_code', pc: 0 };
    callSessions[callId] = session;
    return res.send(readBuild('t-ברוכים הבאים למערכת הטריוויה, הקישו את קוד המשחק בן ארבע הספרות', 'Code', { max: 4, min: 4, say: 'Number' }, session));
  }

  const answer = session.expectKey ? p[session.expectKey] : undefined;

  switch (session.step) {
    case 'ask_code':
      return handleAskCode(answer, session, res);
    case 'ask_name':
      return handleAskName(answer, session, res);
    case 'waiting':
      return handleWaiting(answer, session, res);
    default:
      session.step = 'ask_code';
      return res.send(readBuild('t-הקישו את קוד המשחק', 'Code', { max: 4, min: 4, say: 'Number' }, session));
  }
}

function handleAskCode(code, session, res) {
  const game = getGame(code);
  if (!game) {
    session.step = 'ask_code';
    return res.send('id_list_message=t-קוד משחק לא נמצא&' + stripReadPrefix(readBuild('t-הקישו את קוד המשחק', 'Code', { max: 4, min: 4, say: 'Number' }, session)));
  }
  session.gameCode = code;
  session.step = 'ask_name';
  return res.send(readBuild('t-אנא אייתו את שמכם באמצעות המקלדת, ובסיום הקישו סולמית', 'Name', { max: 20, min: 1, say: 'Letters' }, session));
}

function handleAskName(name, session, res) {
  const game = getGame(session.gameCode);
  if (!game) {
    session.step = 'ask_code';
    return res.send('id_list_message=t-המשחק כבר לא זמין&' + stripReadPrefix(readBuild('t-הקישו את קוד המשחק', 'Code', { max: 4, min: 4, say: 'Number' }, session)));
  }
  const phone = normalizePhone(session.ApiPhone);
  game.players[phone] = game.players[phone] || { name: name || 'משתתף', score: 0, answeredQuestions: {} };
  game.players[phone].name = name || game.players[phone].name;
  saveData();

  session.step = 'waiting';
  session.answeredForQuestion = null;
  return res.send('id_list_message=t-הצטרפת בהצלחה, המתינו להנחיה&' + stripReadPrefix(waitRead(session)));
}

function waitRead(session) {
  // המתנה קצרה - אם המשתמש לא מקיש כלום, המערכת בודקת שוב אחרי כמה שניות
  return readBuild('t-ממתין', 'Wait', { max: 1, min: 0, say: 'NO', okOnEmpty: true, timeout: 4 }, session);
}

function handleWaiting(pressed, session, res) {
  const game = getGame(session.gameCode);
  if (!game) {
    return res.send('id_list_message=t-המשחק הסתיים, תודה על השתתפותכם');
  }

  const qIndex = game.currentQuestionIndex;
  const phone = normalizePhone(session.ApiPhone);
  const player = game.players[phone];

  const isRevealPhase = game.phase === 'reveal' && qIndex >= 0;
  const alreadyAnswered = player && player.answeredQuestions[qIndex] !== undefined;

  if (isRevealPhase && !alreadyAnswered && (!pressed)) {
    // עבר לשלב חשיפת תשובה - שואלים 1/2
    return res.send(readBuild('t-האם עניתם נכון, לכן הקישו 1, לא הקישו 2', 'SelfReport', { max: 1, min: 1, say: 'NO', blockStar: 'no' }, session));
  }

  if (session.step === 'waiting' && pressed && !alreadyAnswered && game.phase === 'reveal') {
    // זו תשובת 1/2 שהתקבלה
    if (player) {
      const question = game.questions[qIndex];
      if (pressed === '1') {
        player.score += (question ? question.points : 10);
        player.answeredQuestions[qIndex] = 'correct';
      } else {
        player.answeredQuestions[qIndex] = 'wrong';
      }
      saveData();
    }
    return res.send('id_list_message=t-תשובתך נקלטה&' + stripReadPrefix(waitRead(session)));
  }

  // ממשיך להמתין
  return res.send(waitRead(session));
}

function readBuild(promptSegment, baseName, opts, session) {
  opts = opts || {};
  session.pc = (session.pc || 0) + 1;
  const paramName = baseName + '_' + session.pc;
  session.expectKey = paramName;
  const fields = [
    paramName,
    '',
    opts.max || '',
    opts.min || '',
    opts.timeout || '',
    opts.say || 'Number',
    opts.blockStar === 'yes' ? 'yes' : '',
    '',
    '',
    '',
    '',
    opts.okOnEmpty ? 'Ok' : '',
    '',
    '',
    opts.confirmEntry ? '' : 'no',
  ];
  return 'read=' + promptSegment + '=' + fields.join(',');
}

function stripReadPrefix(readStr) {
  return readStr;
}

// ============================================================================
// API ניהול (אתר הניהול)
// ============================================================================
app.get('/api/admin/games', (req, res) => {
  res.json(Object.values(db.games).sort((a, b) => b.createdAt - a.createdAt));
});

app.post('/api/admin/games', (req, res) => {
  const game = createGame(req.body.name);
  res.json(game);
});

app.get('/api/admin/games/:code', (req, res) => {
  const game = getGame(req.params.code);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json(game);
});

app.post('/api/admin/games/:code/questions', (req, res) => {
  const { text, correctAnswerText, points, timerSeconds } = req.body;
  const game = addQuestion(req.params.code, text, correctAnswerText, points, timerSeconds);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json(game);
});

app.delete('/api/admin/games/:code/questions/:index', (req, res) => {
  const game = deleteQuestion(req.params.code, Number(req.params.index));
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json(game);
});

app.post('/api/admin/games/:code/status', (req, res) => {
  const game = getGame(req.params.code);
  if (!game) return res.status(404).json({ error: 'not found' });
  game.status = req.body.status;
  saveData();
  res.json(game);
});

app.delete('/api/admin/games/:code', (req, res) => {
  delete db.games[req.params.code];
  saveData();
  res.json({ ok: true });
});

// ============================================================================
// API שליטה (עמוד המנחה)
// ============================================================================
app.get('/api/control/:code', (req, res) => {
  const game = getGame(req.params.code);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json(publicGameView(game));
});

app.post('/api/control/:code/advance', (req, res) => {
  const game = getGame(req.params.code);
  if (!game) return res.status(404).json({ error: 'not found' });

  if (game.phase === 'idle' || game.phase === 'reveal') {
    // עוברים לשאלה הבאה
    game.currentQuestionIndex++;
    if (game.currentQuestionIndex >= game.questions.length) {
      game.phase = 'idle';
      game.status = 'finished';
      game.currentQuestionIndex = game.questions.length - 1;
    } else {
      game.phase = 'question';
      game.status = 'active';
      game.timerEndsAt = null;
    }
  } else if (game.phase === 'question') {
    game.phase = 'timer';
    const q = game.questions[game.currentQuestionIndex];
    game.timerEndsAt = Date.now() + (q.timerSeconds || DEFAULT_TIMER_SECONDS) * 1000;
  } else if (game.phase === 'timer') {
    game.phase = 'reveal';
    game.timerEndsAt = null;
  }
  saveData();
  res.json(publicGameView(game));
});

app.post('/api/control/:code/restart-timer', (req, res) => {
  const game = getGame(req.params.code);
  if (!game || game.currentQuestionIndex < 0) return res.status(404).json({ error: 'not found' });
  const q = game.questions[game.currentQuestionIndex];
  game.phase = 'timer';
  game.timerEndsAt = Date.now() + (q.timerSeconds || DEFAULT_TIMER_SECONDS) * 1000;
  saveData();
  res.json(publicGameView(game));
});

// ============================================================================
// API תצוגה (המסך הגדול)
// ============================================================================
app.get('/api/display/:code', (req, res) => {
  const game = getGame(req.params.code);
  if (!game) return res.status(404).json({ error: 'not found' });
  res.json(publicGameView(game));
});

function publicGameView(game) {
  const q = game.currentQuestionIndex >= 0 ? game.questions[game.currentQuestionIndex] : null;
  const players = Object.entries(game.players).map(([phone, p]) => ({
    name: p.name,
    score: p.score,
  })).sort((a, b) => b.score - a.score);

  return {
    code: game.code,
    name: game.name,
    status: game.status,
    phase: game.phase,
    questionNumber: game.currentQuestionIndex + 1,
    totalQuestions: game.questions.length,
    questionText: q ? q.text : null,
    correctAnswerText: (game.phase === 'reveal' && q) ? q.correctAnswerText : null,
    timerEndsAt: game.timerEndsAt,
    players,
  };
}

// ============================================================================
// דפי HTML (משרתים מ-public/)
// ============================================================================
app.get('/', (req, res) => res.redirect('/admin.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Trivia server running on port ' + PORT));
