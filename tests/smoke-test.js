process.env.AI_DELAY_MIN_MS = "10";
process.env.AI_DELAY_MAX_MS = "20";
require("../server.js");

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

async function run() {
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

  console.log(`题库流程通过：20 题中随机抽取 ${questionIds.size} 题，AI 自动作答并完成结算`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
