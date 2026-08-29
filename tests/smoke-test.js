process.env.AI_DELAY_MIN_MS = "10";
process.env.AI_DELAY_MAX_MS = "20";
const { settleQuestion } = require("../server.js");
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

  const stagHunt = getQuestion("stag-hunt");
  const stagSuccess = settleQuestion(stagHunt, [
    { playerId: "1", option: "A" },
    { playerId: "2", option: "A" },
    { playerId: "3", option: "B" },
  ]);
  if (stagSuccess[0].delta !== 5 || stagSuccess[2].delta !== 2) throw new Error("猎鹿博弈结算错误");

  const hawkDove = getQuestion("hawk-dove");
  const loneHawk = settleQuestion(hawkDove, [
    { playerId: "1", option: "B" },
    { playerId: "2", option: "A" },
  ]);
  if (loneHawk[0].delta !== 5 || loneHawk[1].delta !== 1) throw new Error("单鹰结算错误");
  const hawkConflict = settleQuestion(hawkDove, [
    { playerId: "1", option: "B" },
    { playerId: "2", option: "B" },
    { playerId: "3", option: "A" },
  ]);
  if (hawkConflict[0].delta !== -2 || hawkConflict[2].delta !== 2) throw new Error("多鹰冲突结算错误");

  const rankedPlayers = new Map([
    ["1", { score: 5 }],
    ["2", { score: 2 }],
  ]);
  expectDeltas(
    "领先者风险",
    settleQuestion(getQuestion("leader-risk"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "B" },
    ], rankedPlayers),
    [-5, -0.5],
  );

  expectDeltas(
    "人数预测",
    settleQuestion(getQuestion("crowd-forecast"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "B" },
      { playerId: "3", option: "B" },
      { playerId: "4", option: "D" },
    ]),
    [2, 2, 2, -1],
  );

  expectDeltas(
    "团队竞价",
    settleQuestion(getQuestion("team-auction"), [
      { playerId: "1", option: "C" },
      { playerId: "2", option: "C" },
      { playerId: "3", option: "H" },
    ]),
    [0, 0, 12],
  );

  expectDeltas(
    "拥挤博弈",
    settleQuestion(getQuestion("congestion-game"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "A" },
      { playerId: "3", option: "A" },
      { playerId: "4", option: "B" },
      { playerId: "5", option: "B" },
    ]),
    [0, 0, 0, 3, 3],
  );

  expectDeltas(
    "志愿者困境",
    settleQuestion(getQuestion("volunteer-dilemma"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "B" },
    ]),
    [2, 3],
  );

  expectDeltas(
    "最低努力",
    settleQuestion(getQuestion("minimum-effort"), [
      { playerId: "1", option: "B" },
      { playerId: "2", option: "E" },
    ]),
    [4, 1],
  );

  expectDeltas(
    "银行挤兑",
    settleQuestion(getQuestion("bank-run"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "A" },
      { playerId: "3", option: "B" },
      { playerId: "4", option: "B" },
      { playerId: "5", option: "B" },
    ]),
    [1, 1, 0, 0, 0],
  );

  const originalRandom = Math.random;
  Math.random = () => 0;
  const lotteryResults = settleQuestion(getQuestion("lottery-investment"), [
    { playerId: "1", option: "B" },
    { playerId: "2", option: "C" },
    { playerId: "3", option: "A" },
  ]);
  Math.random = originalRandom;
  expectDeltas("彩票投入", lotteryResults, [5, -2, 0]);

  expectDeltas(
    "全支付拍卖",
    settleQuestion(getQuestion("all-pay-auction"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "E" },
    ]),
    [-1, 1],
  );

  expectDeltas(
    "旅行者困境",
    settleQuestion(getQuestion("travelers-dilemma"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "E" },
    ]),
    [4, 0],
  );

  expectDeltas(
    "循环克制",
    settleQuestion(getQuestion("cyclic-dominance"), [
      { playerId: "1", option: "A" },
      { playerId: "2", option: "A" },
      { playerId: "3", option: "B" },
    ]),
    [-1, -1, 2],
  );

  await new Promise((resolve) => setTimeout(resolve, 120));
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

  console.log(`题库流程通过：20 种博弈机制结算有效，随机抽取 ${questionIds.size} 题且无重复`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
