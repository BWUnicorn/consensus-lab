const crypto = require("node:crypto");
const testAdminNickname = "integration-admin";
process.env.AI_DELAY_MIN_MS = "10";
process.env.AI_DELAY_MAX_MS = "20";
process.env.MATCH_COUNTDOWN_SECONDS = "0.08";
process.env.MATCH_AI_FILL_SECONDS = "0.08";
process.env.MATCH_AI_START_SECONDS = "0.03";
process.env.AUTO_NEXT_SECONDS = "0.08";
process.env.HOST_TRANSFER_DELAY_SECONDS = "0.05";
process.env.ADMIN_TRIGGER_HASH = crypto.createHash("sha256").update(testAdminNickname).digest("hex");
const { selectQuestions, settleQuestion, buildStrategyProfile } = require("../server.js");
const { questionBank } = require("../question-bank.js");

const baseUrl = "http://127.0.0.1:4173";

async function post(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${body.error}`);
  return body;
}

async function postRaw(path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function readSnapshot(session) {
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/events?roomCode=${session.roomCode}&playerId=${session.playerId}`,
    { signal: controller.signal },
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let message = "";
  while (!message.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    message += decoder.decode(value, { stream: true });
  }
  controller.abort();
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine.slice(6));
}

async function holdConnection(session) {
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/events?roomCode=${session.roomCode}&playerId=${session.playerId}`,
    { signal: controller.signal },
  );
  if (!response.ok) throw new Error("无法建立持续房间连接");
  return { close: () => controller.abort() };
}

function getQuestion(id) {
  const question = questionBank.find((candidate) => candidate.id === id);
  if (!question) throw new Error(`缺少题目：${id}`);
  return question;
}

function expectDeltas(label, results, expected) {
  const actual = results.map((item) => item.delta);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}结算错误：${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  }
}

async function run() {
  if (questionBank.length !== 20) throw new Error("题库不是 20 题");
  if (new Set(questionBank.map((question) => question.rule.type)).size !== 20) {
    throw new Error("题库存在重复的博弈机制");
  }
  for (const question of questionBank) {
    const optionIds = new Set(question.options.map((option) => option.id));
    for (const profileId of ["conservative", "aggressive", "cooperative", "opportunist"]) {
      if (!optionIds.has(question.aiChoices[profileId])) {
        throw new Error(`题目 ${question.id} 缺少有效的 ${profileId} AI 答案`);
      }
    }
  }
  const sampledIds = new Set();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const selected = selectQuestions();
    if (selected.length !== 10 || new Set(selected).size !== 10) throw new Error("随机抽题没有返回10道不同题目");
    selected.forEach((id) => sampledIds.add(id));
  }
  if (sampledIds.size !== 20) throw new Error("随机抽题测试没有覆盖全部20题");

  const profile = buildStrategyProfile([
    {
      question: { id: "peace-agreement-v2" },
      distribution: { A: 3, B: 1 },
      results: [{ playerId: "1", option: "A" }],
    },
    {
      question: { id: "narrow-passage" },
      distribution: { A: 1, B: 3 },
      results: [{ playerId: "1", option: "B" }],
    },
  ], "1");
  if (profile.answeredRounds !== 2 || profile.dimensions.length !== 5) throw new Error("策略人格报告结构错误");
  if (profile.dimensions.some((dimension) => dimension.score < 0 || dimension.score > 100)) {
    throw new Error("策略人格分数超出范围");
  }

  const cases = [
    ["复合策略", "strategy-choice-v2", ["A", "B", "B", "C"], [1, 3, 3, 4]],
    ["动态合作", "peace-agreement-v2", ["A", "A", "A", "B"], [4, 4, 4, 2]],
    ["多数协调", "shelter-vote", ["A", "A", "B", "C"], [4, 4, 0, 0]],
    ["少数选择", "hidden-color-v2", ["A", "A", "B", "C"], [1, 1, 3, 3]],
    ["人数平衡", "rescue-balance", ["A", "A", "A", "B"], [1, 1, 1, 5]],
    ["比例阈值", "public-fund-v2", ["A", "A", "B"], [5, 5, 2]],
    ["共享容量", "shared-warehouse-v2", ["A", "B", "C"], [1, 2, 3]],
    ["唯一竞价", "single-ticket-v2", ["A", "A", "D", "C"], [1, 1, 6, 1]],
    ["平均数预测", "average-guess-v2", ["A", "C", "C", "E"], [1, 5, 5, 1]],
    ["全员一致", "signal-tower-v2", ["B", "B"], [6, 6]],
    ["志愿者困境", "generator-volunteer", ["A", "B"], [2, 4]],
    ["分级投入", "supply-contribution", ["A", "B", "C"], [3, 4, 5]],
    ["单人冒险", "narrow-passage", ["B", "A"], [6, 3]],
    ["高速拥堵", "expressway-congestion", ["A", "A", "A", "A", "B"], [0, 0, 0, 0, 2]],
    ["全支付竞价", "all-pay-auction", ["A", "D"], [4, 6]],
    ["中位数协调", "median-rendezvous", ["A", "D", "G"], [1, 5, 1]],
    ["非对称市场", "asymmetric-market", ["A", "A", "B", "C"], [6, 6, 4, 2]],
    ["角色联盟", "expedition-coalition", ["A", "B", "B", "C"], [7, 4, 4, 2]],
    ["挤兑博弈", "bank-run", ["A", "A", "A", "B", "B"], [0, 0, 0, 2, 2]],
    ["期限混合", "deadline-hybrid", ["A", "B", "B", "C"], [2, 5, 5, 7]],
  ];
  for (const [label, questionId, options, expected] of cases) {
    const answers = options.map((option, index) => ({ playerId: String(index + 1), option }));
    expectDeltas(label, settleQuestion(getQuestion(questionId), answers), expected);
  }

  await new Promise((resolve) => setTimeout(resolve, 120));

  const normalEntry = await post("/api/admin-login", { nickname: "普通玩家" });
  if (normalEntry.admin) throw new Error("普通昵称错误进入了管理控制台");
  const adminEntry = await post("/api/admin-login", { nickname: testAdminNickname });
  if (!adminEntry.admin || !adminEntry.adminToken) throw new Error("管理员暗门验证失败");
  const deniedStats = await postRaw("/api/admin-stats", { adminToken: "invalid-token" });
  if (deniedStats.status !== 403) throw new Error("无效令牌可以读取管理统计");
  const initialStats = await post("/api/admin-stats", { adminToken: adminEntry.adminToken });
  if (typeof initialStats.totals?.rooms !== "number" || !Array.isArray(initialStats.rooms)) {
    throw new Error("管理控制台统计结构无效");
  }

  const recoveryHost = await post("/api/create", { nickname: "原房主" });
  const recoveryGuest = await post("/api/join", { nickname: "接任者", roomCode: recoveryHost.roomCode });
  const resumed = await post("/api/resume", recoveryHost);
  if (!resumed.ok || resumed.status !== "lobby") throw new Error("刷新恢复会话校验失败");
  const guestConnection = await holdConnection(recoveryGuest);
  const hostConnection = await holdConnection(recoveryHost);
  hostConnection.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const refreshedHostConnection = await holdConnection(recoveryHost);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const refreshedRoom = await readSnapshot(recoveryHost);
  if (refreshedRoom.hostId !== recoveryHost.playerId) throw new Error("房主刷新时在宽限期内丢失了权限");
  refreshedHostConnection.close();
  await new Promise((resolve) => setTimeout(resolve, 130));
  const transferredRoom = await readSnapshot(recoveryGuest);
  if (transferredRoom.hostId !== recoveryGuest.playerId) throw new Error("房主断线后没有自动转移权限");
  guestConnection.close();
  const roomStats = await post("/api/admin-stats", { adminToken: adminEntry.adminToken });
  if (roomStats.totals.rooms < 1 || roomStats.totals.humanPlayers < 2) {
    throw new Error("管理控制台没有统计现有房间和真人玩家");
  }

  const matchOne = await post("/api/matchmake", { nickname: "浪花" });
  const matchTwo = await post("/api/matchmake", { nickname: "灯塔" });
  if (matchOne.roomCode !== matchTwo.roomCode) throw new Error("两名在线玩家没有进入同一个匹配房间");
  const matching = await readSnapshot(matchOne);
  if (!matching.matchmaking || !matching.matchDeadline) throw new Error("匹配房间没有启动集结倒计时");

  await new Promise((resolve) => setTimeout(resolve, 140));
  const matchedGame = await readSnapshot(matchOne);
  if (matchedGame.status !== "playing" || matchedGame.players.length !== 2) throw new Error("双人匹配没有自动开局");
  if (matchedGame.roundSeconds !== 60) throw new Error("默认答题时间不是 60 秒");
  await post("/api/submit", { ...matchOne, option: matchedGame.question.options[0].id });
  await post("/api/submit", { ...matchTwo, option: matchedGame.question.options[0].id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const matchedResult = await readSnapshot(matchOne);
  if (matchedResult.status !== "result" || !matchedResult.autoNextDeadline) {
    throw new Error("匹配房间没有进入自动结算等待");
  }
  await new Promise((resolve) => setTimeout(resolve, 130));
  const matchedNextRound = await readSnapshot(matchOne);
  if (matchedNextRound.status !== "playing" || matchedNextRound.roundIndex !== 1) {
    throw new Error("匹配房间没有自动进入下一轮");
  }

  const cancelledMatch = await post("/api/matchmake", { nickname: "暂离" });
  await post("/api/cancel-match", cancelledMatch);

  const soloMatch = await post("/api/matchmake", { nickname: "独行者" });
  await new Promise((resolve) => setTimeout(resolve, 230));
  const soloGame = await readSnapshot(soloMatch);
  if (soloGame.status !== "playing" || soloGame.players.length !== 4) {
    throw new Error("单人匹配没有通过 AI 补足到 4 人并自动开局");
  }
  if (soloGame.players.filter((player) => player.isAI).length !== 3) {
    throw new Error("单人匹配的 AI 补位数量错误");
  }

  const host = await post("/api/create", { nickname: "海风" });
  await post("/api/add-ai", host);

  await post("/api/start", host);
  const questionIds = new Set();

  for (let roundIndex = 0; roundIndex < 10; roundIndex += 1) {
    const playing = await readSnapshot(host);
    if (playing.status !== "playing") throw new Error(`第 ${roundIndex + 1} 题未进入答题状态`);
    if (playing.roundCount !== 10) throw new Error("每局题目数不是 10");
    if (!playing.question?.id || !playing.question.options.length) throw new Error("当前题目没有正确下发");
    questionIds.add(playing.question.id);

    await post("/api/submit", { ...host, option: playing.question.options[0].id });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const result = await readSnapshot(host);
    if (result.status !== "result") throw new Error(`第 ${roundIndex + 1} 题没有正确结算`);
    if (!result.players.some((player) => player.isAI && player.aiProfile)) throw new Error("AI身份没有正确分配");
    if (!result.lastRound?.yourResult) throw new Error("没有返回玩家结算结果");
    await post("/api/next", host);
  }

  const finished = await readSnapshot(host);
  if (finished.status !== "finished") throw new Error("完成 10 题后没有进入最终结果");
  if (questionIds.size !== 10) throw new Error("一局内抽到了重复题目");
  if (finished.review?.length !== 10) throw new Error("终局复盘没有包含完整 10 题");
  if (finished.review.some((round) => round.results.length !== finished.players.length)) {
    throw new Error("终局复盘缺少玩家选项或分数记录");
  }
  if (finished.review.some((round) => round.results.some((result) => typeof result.scoreAfter !== "number"))) {
    throw new Error("终局复盘缺少累计分数趋势");
  }
  if (!finished.strategyProfile?.title || finished.strategyProfile.dimensions?.length !== 5) {
    throw new Error("终局没有返回完整的玩家策略人格报告");
  }

  console.log(`完整流程通过：策略人格、管理控制台、终局复盘、会话恢复、在线匹配及 ${questionIds.size} 题随机题库均有效`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
