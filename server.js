const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const ROUND_SECONDS = 30;
const AI_DELAY_MIN_MS = Number(process.env.AI_DELAY_MIN_MS || 1800);
const AI_DELAY_MAX_MS = Number(process.env.AI_DELAY_MAX_MS || 5200);
const rooms = new Map();

const aiProfiles = [
  { id: "conservative", label: "保守者", choices: ["A", "A"] },
  { id: "aggressive", label: "激进派", choices: ["C", "B"] },
  { id: "random", label: "随机者", choices: null },
];

const aiNames = ["白帆", "北辰", "回声", "星轨", "木棉", "深蓝", "微光", "潮汐", "云雀"];

const rounds = [
  {
    options: ["A", "B", "C"],
    settle(answers) {
      const counts = countOptions(answers, this.options);
      const selectedCounts = Object.values(counts).filter((count) => count > 0);
      const maximum = selectedCounts.length ? Math.max(...selectedCounts) : 0;
      const minimum = selectedCounts.length ? Math.min(...selectedCounts) : 0;
      return answers.map((answer) => {
        if (!answer.option) return result(answer, 0, "未在规定时间内提交");
        if (answer.option === "A") return result(answer, 1, "谨慎策略固定获得 1 分");
        if (answer.option === "B" && counts.B === maximum) return result(answer, 3, "共识成为本轮多数");
        if (answer.option === "C" && counts.C === minimum) return result(answer, 4, "独行成为本轮少数");
        return result(answer, 0, "本轮条件没有满足");
      });
    },
  },
  {
    options: ["A", "B"],
    settle(answers) {
      const breakers = answers.filter((answer) => answer.option === "B").length;
      return answers.map((answer) => {
        if (!answer.option) return result(answer, 0, "未在规定时间内提交");
        if (answer.option === "B") return result(answer, 1, "破坏方固定获得 1 分");
        if (breakers < 2) return result(answer, 3, "协议仍然有效");
        return result(answer, 0, "两人打破协议，合作失效");
      });
    },
  },
];

function result(answer, delta, reason) {
  return { playerId: answer.playerId, option: answer.option, delta, reason };
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

function chooseAIOption(player, roundIndex) {
  const round = rounds[roundIndex];
  const profile = aiProfiles.find((candidate) => candidate.id === player.aiProfile);
  if (!profile?.choices) return round.options[Math.floor(Math.random() * round.options.length)];
  return profile.choices[roundIndex] || round.options[0];
}

function clearAITimers(room) {
  for (const timer of room.aiTimers) clearTimeout(timer);
  room.aiTimers = [];
}

function scheduleAIAnswers(room) {
  const scheduledRound = room.roundIndex;
  for (const player of room.players.values()) {
    if (!player.isAI) continue;
    const delay = AI_DELAY_MIN_MS + Math.random() * Math.max(0, AI_DELAY_MAX_MS - AI_DELAY_MIN_MS);
    const timer = setTimeout(() => {
      if (room.status !== "playing" || room.roundIndex !== scheduledRound || room.answers.has(player.id)) return;
      room.answers.set(player.id, chooseAIOption(player, scheduledRound));
      broadcast(room);
      if (room.answers.size === room.players.size) settleRound(room);
    }, delay);
    room.aiTimers.push(timer);
  }
}

function publicRoom(room, playerId) {
  const yourResult = room.lastRound?.results.find((item) => item.playerId === playerId) || null;
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    roundIndex: room.roundIndex,
    roundCount: rounds.length,
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
  const round = rounds[room.roundIndex];
  const answers = [...room.players.values()].map((player) => ({
    playerId: player.id,
    option: room.answers.get(player.id) || null,
  }));
  const results = round.settle(answers);
  for (const item of results) {
    const player = room.players.get(item.playerId);
    if (player) player.score += item.delta;
  }
  room.lastRound = {
    distribution: countOptions(answers, round.options),
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
    for (const currentPlayer of room.players.values()) currentPlayer.score = 0;
    startRound(room);
    return json(response, 200, { ok: true });
  }

  if (pathname === "/api/submit") {
    if (room.status !== "playing") return json(response, 409, { error: "当前不在答题阶段" });
    if (Date.now() > room.deadline) return json(response, 409, { error: "本轮已经结束" });
    if (room.answers.has(player.id)) return json(response, 409, { error: "本轮已经提交，不能修改" });
    const option = String(payload.option || "").toUpperCase();
    if (!rounds[room.roundIndex].options.includes(option)) return json(response, 400, { error: "无效选项" });
    room.answers.set(player.id, option);
    broadcast(room);
    if (room.answers.size === room.players.size) settleRound(room);
    return json(response, 200, { ok: true });
  }

  if (pathname === "/api/next") {
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以进入下一轮" });
    if (room.status !== "result") return json(response, 409, { error: "当前不能进入下一轮" });
    if (room.roundIndex < rounds.length - 1) {
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
