const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { questionBank } = require("./question-bank");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const ROUND_SECONDS = 30;
const QUESTIONS_PER_GAME = 10;
const AI_DELAY_MIN_MS = Number(process.env.AI_DELAY_MIN_MS || 1800);
const AI_DELAY_MAX_MS = Number(process.env.AI_DELAY_MAX_MS || 5200);
const rooms = new Map();

const aiProfiles = [
  { id: "conservative", label: "保守者" },
  { id: "aggressive", label: "激进派" },
  { id: "random", label: "随机者" },
];

const aiNames = ["白帆", "北辰", "回声", "星轨", "木棉", "深蓝", "微光", "潮汐", "云雀"];

function validateQuestionBank() {
  if (questionBank.length !== 20) throw new Error(`题库必须恰好包含 20 题，当前为 ${questionBank.length} 题`);
  const ids = new Set();
  for (const question of questionBank) {
    if (ids.has(question.id)) throw new Error(`题目 ID 重复：${question.id}`);
    ids.add(question.id);
    const optionIds = new Set(question.options.map((option) => option.id));
    for (const profileId of ["conservative", "aggressive"]) {
      if (!optionIds.has(question.aiChoices[profileId])) {
        throw new Error(`题目 ${question.id} 的 ${profileId} AI 答案无效`);
      }
    }
  }
}

validateQuestionBank();

function result(answer, delta, reason) {
  return { playerId: answer.playerId, option: answer.option, delta, reason };
}

function selectQuestions(count = QUESTIONS_PER_GAME) {
  const shuffled = [...questionBank];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length)).map((question) => question.id);
}

function currentQuestion(room) {
  const questionId = room.questionIds[room.roundIndex];
  return questionBank.find((question) => question.id === questionId);
}

function publicQuestion(question) {
  if (!question) return null;
  return {
    id: question.id,
    kicker: question.kicker,
    title: question.title,
    description: question.description,
    options: question.options,
  };
}

function settleQuestion(question, answers) {
  const optionIds = question.options.map((option) => option.id);
  const counts = countOptions(answers, optionIds);
  const submitted = answers.filter((answer) => answer.option);
  const rule = question.rule;

  if (rule.type === "safe-majority-minority") {
    const positiveCounts = Object.values(counts).filter((count) => count > 0);
    const maximum = positiveCounts.length ? Math.max(...positiveCounts) : 0;
    const minimum = positiveCounts.length ? Math.min(...positiveCounts) : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.safe) return result(answer, 1, "稳妥选择固定获得 1 分");
      if (answer.option === rule.majority && counts[answer.option] === maximum) return result(answer, 3, "你的选择成为人数最多的方案");
      if (answer.option === rule.minority && counts[answer.option] === minimum) return result(answer, 4, "你的选择成为人数最少的方案");
      return result(answer, 0, "本轮得分条件没有满足");
    });
  }

  if (rule.type === "cooperation") {
    const defectors = counts[rule.defect] || 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.defect) return result(answer, 1, "冒险选择固定获得 1 分");
      return defectors < rule.limit
        ? result(answer, 3, "合作条件成立，获得 3 分")
        : result(answer, 0, "破坏者达到临界人数，合作失效");
    });
  }

  if (rule.type === "stag-hunt") {
    const required = Math.ceil(answers.length * rule.ratio);
    const succeeded = counts[rule.cooperate] >= required;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.solo) return result(answer, rule.soloScore, "独自行动获得确定收益");
      return succeeded
        ? result(answer, rule.successScore, `联合人数达到 ${required} 人，高价值行动成功`)
        : result(answer, 0, `至少需要 ${required} 人联合，行动失败`);
    });
  }

  if (rule.type === "hawk-dove") {
    const hawks = counts[rule.hawk] || 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.hawk) {
        return hawks === 1
          ? result(answer, rule.loneHawkScore, "你是唯一强夺者，获得控制权")
          : result(answer, rule.conflictScore, "多名玩家同时强夺，冲突导致扣分");
      }
      if (hawks === 0) return result(answer, rule.peacefulScore, "无人强夺，协商成功");
      if (hawks === 1) return result(answer, rule.yieldedScore, "你向唯一强夺者让步");
      return result(answer, rule.conflictObserverScore, "强夺者相互冲突，你保留部分收益");
    });
  }

  if (rule.type === "majority") {
    const maximum = Math.max(0, ...Object.values(counts));
    const winners = optionIds.filter((option) => counts[option] === maximum && maximum > 0);
    const score = winners.length > 1 ? rule.tieScore : rule.winScore;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      return winners.includes(answer.option)
        ? result(answer, score, winners.length > 1 ? "并列成为最多选择，获得 2 分" : "成为最多选择，获得 3 分")
        : result(answer, 0, "没有进入人数最多的方案");
    });
  }

  if (rule.type === "minority") {
    const positiveCounts = Object.values(counts).filter((count) => count > 0);
    const minimum = positiveCounts.length ? Math.min(...positiveCounts) : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      return counts[answer.option] === minimum
        ? result(answer, rule.winScore, "成为人数最少的有效选择")
        : result(answer, rule.otherScore, "未成为少数选择，获得基础分");
    });
  }

  if (rule.type === "balance") {
    const [left, right] = optionIds;
    const balanced = Math.abs(counts[left] - counts[right]) <= 1;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (balanced) return result(answer, rule.balancedScore, "两边保持均衡，所有人获得 3 分");
      const isMinority = counts[answer.option] === Math.min(counts[left], counts[right]);
      return isMinority
        ? result(answer, rule.minorityScore, "你处于人数较少的一边")
        : result(answer, rule.majorityScore, "你处于人数较多的一边");
    });
  }

  if (rule.type === "threshold") {
    const required = Math.ceil(answers.length * rule.ratio);
    const reached = counts[rule.support] >= required;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.wait) return result(answer, rule.waitScore, "稳妥选择固定获得 1 分");
      return reached
        ? result(answer, rule.successScore, `参与人数达到 ${required} 人，行动成功`)
        : result(answer, 0, `至少需要 ${required} 人参与，行动未启动`);
    });
  }

  if (rule.type === "shared-capacity") {
    const capacity = answers.length * rule.capacityPerPlayer;
    const requested = submitted.reduce((sum, answer) => sum + rule.values[answer.option], 0);
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      return requested <= capacity
        ? result(answer, rule.values[answer.option], `总申请 ${requested}/${capacity}，按申请量得分`)
        : result(answer, 0, `总申请 ${requested}/${capacity}，超过公共容量`);
    });
  }

  if (rule.type === "unique-high") {
    const uniqueOptions = optionIds.filter((option) => counts[option] === 1);
    const winner = uniqueOptions.sort((a, b) => rule.values[b] - rule.values[a])[0] || null;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (!winner) return result(answer, 0, "本轮没有出现唯一选择");
      return answer.option === winner
        ? result(answer, rule.winScore, "你选中了最高的唯一编号")
        : result(answer, rule.otherScore, "未赢得竞价，获得基础分");
    });
  }

  if (rule.type === "closest-average") {
    if (!submitted.length) return answers.map((answer) => result(answer, 0, "无人提交答案"));
    const average = submitted.reduce((sum, answer) => sum + rule.values[answer.option], 0) / submitted.length;
    const target = average * rule.factor;
    const distance = Math.min(...submitted.map((answer) => Math.abs(rule.values[answer.option] - target)));
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const won = Math.abs(rule.values[answer.option] - target) === distance;
      return won
        ? result(answer, rule.winScore, `最接近目标值 ${target.toFixed(1)}`)
        : result(answer, rule.otherScore, `目标值为 ${target.toFixed(1)}，获得基础分`);
    });
  }

  if (rule.type === "unanimity-risk") {
    const unanimous = submitted.length === answers.length && submitted.every((answer) => answer.option === rule.risk);
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.safe) return result(answer, rule.safeScore, "稳妥选择固定获得 1 分");
      return unanimous
        ? result(answer, rule.successScore, "全员达成一致，获得 5 分")
        : result(answer, 0, "没有达成全员一致");
    });
  }

  return answers.map((answer) => result(answer, 0, "题目规则配置错误"));
}

function countOptions(answers, optionIds) {
  return Object.fromEntries(optionIds.map((id) => [id, answers.filter((answer) => answer.option === id).length]));
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function cleanNickname(value) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, 12);
}

function createPlayer(name, { isAI = false, aiProfile = null } = {}) {
  return {
    id: crypto.randomUUID(),
    name,
    score: 0,
    connected: isAI,
    isAI,
    aiProfile,
    lastSeen: Date.now(),
  };
}

function createAIPlayer(room) {
  const availableNames = aiNames.filter(
    (name) => ![...room.players.values()].some((player) => player.name === name),
  );
  const name = availableNames[Math.floor(Math.random() * availableNames.length)] || `AI-${room.players.size}`;
  const profile = aiProfiles[Math.floor(Math.random() * aiProfiles.length)];
  return createPlayer(name, { isAI: true, aiProfile: profile.id });
}

function chooseAIOption(player, question) {
  const plannedOption = question.aiChoices[player.aiProfile];
  if (plannedOption) return plannedOption;
  return question.options[Math.floor(Math.random() * question.options.length)].id;
}

function clearAITimers(room) {
  for (const timer of room.aiTimers) clearTimeout(timer);
  room.aiTimers = [];
}

function scheduleAIAnswers(room) {
  const scheduledRound = room.roundIndex;
  const question = currentQuestion(room);
  for (const player of room.players.values()) {
    if (!player.isAI) continue;
    const delay = AI_DELAY_MIN_MS + Math.random() * Math.max(0, AI_DELAY_MAX_MS - AI_DELAY_MIN_MS);
    const timer = setTimeout(() => {
      if (room.status !== "playing" || room.roundIndex !== scheduledRound || room.answers.has(player.id)) return;
      room.answers.set(player.id, chooseAIOption(player, question));
      broadcast(room);
      if (room.answers.size === room.players.size) settleRound(room);
    }, delay);
    room.aiTimers.push(timer);
  }
}

function publicRoom(room, playerId) {
  const question = currentQuestion(room);
  const yourResult = room.lastRound?.results.find((item) => item.playerId === playerId) || null;
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    roundIndex: room.roundIndex,
    roundCount: room.questionIds.length || QUESTIONS_PER_GAME,
    question: publicQuestion(question),
    deadline: room.deadline,
    submissionCount: room.answers.size,
    yourPlayerId: playerId,
    yourAnswer: room.answers.get(playerId) || null,
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      connected: player.connected,
      isHost: player.id === room.hostId,
      isAI: player.isAI,
      aiProfile: player.isAI
        ? aiProfiles.find((profile) => profile.id === player.aiProfile)?.label || "AI"
        : null,
    })),
    lastRound: room.lastRound
      ? {
          distribution: room.lastRound.distribution,
          yourResult,
        }
      : null,
  };
}

function sendEvent(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room) {
  for (const [playerId, connections] of room.connections) {
    const snapshot = publicRoom(room, playerId);
    for (const response of connections) sendEvent(response, "snapshot", snapshot);
  }
}

function startRound(room) {
  clearTimeout(room.roundTimer);
  clearAITimers(room);
  room.status = "playing";
  room.answers = new Map();
  room.lastRound = null;
  room.deadline = Date.now() + ROUND_SECONDS * 1000;
  room.roundTimer = setTimeout(() => settleRound(room), ROUND_SECONDS * 1000 + 50);
  broadcast(room);
  scheduleAIAnswers(room);
}

function settleRound(room) {
  if (room.status !== "playing") return;
  clearTimeout(room.roundTimer);
  clearAITimers(room);
  const question = currentQuestion(room);
  const answers = [...room.players.values()].map((player) => ({
    playerId: player.id,
    option: room.answers.get(player.id) || null,
  }));
  const results = settleQuestion(question, answers);
  for (const item of results) {
    const player = room.players.get(item.playerId);
    if (player) player.score += item.delta;
  }
  room.lastRound = {
    distribution: countOptions(answers, question.options.map((option) => option.id)),
    results,
  };
  room.status = "result";
  room.deadline = null;
  room.updatedAt = Date.now();
  broadcast(room);
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 50_000) throw new Error("请求内容过大");
  }
  return body ? JSON.parse(body) : {};
}

function requireRoomAndPlayer(payload) {
  const room = rooms.get(String(payload.roomCode || "").toUpperCase());
  if (!room) throw new Error("房间不存在或服务器已重启");
  const player = room.players.get(payload.playerId);
  if (!player) throw new Error("玩家身份已失效，请重新加入");
  if (player.isAI) throw new Error("AI玩家不能作为操作身份");
  player.lastSeen = Date.now();
  room.updatedAt = Date.now();
  return { room, player };
}

async function handleApi(request, response, pathname) {
  const payload = await readJson(request);

  if (pathname === "/api/create") {
    const nickname = cleanNickname(payload.nickname);
    if (!nickname) return json(response, 400, { error: "请输入昵称" });
    const player = createPlayer(nickname);
    const code = makeRoomCode();
    const room = {
      code,
      hostId: player.id,
      status: "lobby",
      roundIndex: 0,
      questionIds: [],
      deadline: null,
      answers: new Map(),
      players: new Map([[player.id, player]]),
      connections: new Map(),
      lastRound: null,
      roundTimer: null,
      aiTimers: [],
      updatedAt: Date.now(),
    };
    rooms.set(code, room);
    return json(response, 201, { roomCode: code, playerId: player.id });
  }

  if (pathname === "/api/join") {
    const nickname = cleanNickname(payload.nickname);
    const roomCode = String(payload.roomCode || "").trim().toUpperCase();
    if (!nickname) return json(response, 400, { error: "请输入昵称" });
    const room = rooms.get(roomCode);
    if (!room) return json(response, 404, { error: "没有找到这个房间" });
    if (room.status !== "lobby") return json(response, 409, { error: "游戏已经开始，暂时不能加入" });
    if (room.players.size >= 10) return json(response, 409, { error: "房间人数已满" });
    if ([...room.players.values()].some((player) => player.name === nickname)) {
      return json(response, 409, { error: "房间里已经有人使用这个昵称" });
    }
    const player = createPlayer(nickname);
    room.players.set(player.id, player);
    room.updatedAt = Date.now();
    broadcast(room);
    return json(response, 201, { roomCode, playerId: player.id });
  }

  const { room, player } = requireRoomAndPlayer(payload);

  if (pathname === "/api/add-ai") {
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以添加AI玩家" });
    if (room.status !== "lobby") return json(response, 409, { error: "只能在等待大厅添加AI玩家" });
    if (room.players.size >= 10) return json(response, 409, { error: "房间人数已满" });
    const aiPlayer = createAIPlayer(room);
    room.players.set(aiPlayer.id, aiPlayer);
    room.updatedAt = Date.now();
    broadcast(room);
    return json(response, 201, { ok: true, aiPlayerId: aiPlayer.id });
  }

  if (pathname === "/api/remove-ai") {
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以移除AI玩家" });
    if (room.status !== "lobby") return json(response, 409, { error: "只能在等待大厅移除AI玩家" });
    const aiPlayer = room.players.get(payload.aiPlayerId);
    if (!aiPlayer?.isAI) return json(response, 404, { error: "没有找到这个AI玩家" });
    room.players.delete(aiPlayer.id);
    room.updatedAt = Date.now();
    broadcast(room);
    return json(response, 200, { ok: true });
  }

  if (pathname === "/api/start") {
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以开始游戏" });
    if (room.status !== "lobby") return json(response, 409, { error: "游戏已经开始" });
    if (room.players.size < 2) return json(response, 409, { error: "至少需要两名玩家" });
    room.roundIndex = 0;
    room.questionIds = selectQuestions();
    for (const currentPlayer of room.players.values()) currentPlayer.score = 0;
    startRound(room);
    return json(response, 200, { ok: true });
  }

  if (pathname === "/api/submit") {
    if (room.status !== "playing") return json(response, 409, { error: "当前不在答题阶段" });
    if (Date.now() > room.deadline) return json(response, 409, { error: "本轮已经结束" });
    if (room.answers.has(player.id)) return json(response, 409, { error: "本轮已经提交，不能修改" });
    const option = String(payload.option || "").toUpperCase();
    if (!currentQuestion(room).options.some((candidate) => candidate.id === option)) {
      return json(response, 400, { error: "无效选项" });
    }
    room.answers.set(player.id, option);
    broadcast(room);
    if (room.answers.size === room.players.size) settleRound(room);
    return json(response, 200, { ok: true });
  }

  if (pathname === "/api/next") {
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以进入下一轮" });
    if (room.status !== "result") return json(response, 409, { error: "当前不能进入下一轮" });
    if (room.roundIndex < room.questionIds.length - 1) {
      room.roundIndex += 1;
      startRound(room);
    } else {
      room.status = "finished";
      room.updatedAt = Date.now();
      broadcast(room);
    }
    return json(response, 200, { ok: true });
  }

  return json(response, 404, { error: "接口不存在" });
}

function handleEvents(request, response, url) {
  const roomCode = String(url.searchParams.get("roomCode") || "").toUpperCase();
  const playerId = url.searchParams.get("playerId");
  const room = rooms.get(roomCode);
  const player = room?.players.get(playerId);
  if (!room || !player) return json(response, 404, { error: "房间或玩家不存在" });

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const connections = room.connections.get(playerId) || new Set();
  connections.add(response);
  room.connections.set(playerId, connections);
  player.connected = true;
  player.lastSeen = Date.now();
  sendEvent(response, "snapshot", publicRoom(room, playerId));
  broadcast(room);

  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    connections.delete(response);
    if (connections.size === 0) {
      room.connections.delete(playerId);
      player.connected = false;
      player.lastSeen = Date.now();
      broadcast(room);
    }
  });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (!filePath.startsWith(ROOT + path.sep)) return json(response, 403, { error: "禁止访问" });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(response, 404, { error: "文件不存在" });
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/events") {
      return handleEvents(request, response, url);
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      return await handleApi(request, response, url.pathname);
    }
    if (request.method === "GET") return serveStatic(response, url.pathname);
    return json(response, 405, { error: "不支持的请求方式" });
  } catch (error) {
    return json(response, 400, { error: error.message || "请求处理失败" });
  }
});

setInterval(() => {
  const expiry = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.updatedAt < expiry) {
      clearTimeout(room.roundTimer);
      clearAITimers(room);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`共识实验室已启动：http://localhost:${PORT}`);
});

module.exports = { settleQuestion };
