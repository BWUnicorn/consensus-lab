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

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const host = await post("/api/create", { nickname: "海风" });
  const guest = await post("/api/join", { nickname: "远帆", roomCode: host.roomCode });

  await post("/api/start", host);
  await post("/api/submit", { ...host, option: "A" });
  await post("/api/submit", { ...guest, option: "B" });

  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/events?roomCode=${host.roomCode}&playerId=${host.playerId}`,
    { signal: controller.signal },
  );
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  const message = new TextDecoder().decode(value);
  const dataLine = message.split("\n").find((line) => line.startsWith("data: "));
  const snapshot = JSON.parse(dataLine.slice(6));

  if (snapshot.status !== "result") throw new Error(`预期 result，实际为 ${snapshot.status}`);
  if (snapshot.players.length !== 2) throw new Error("玩家数量没有正确同步");
  if (snapshot.lastRound.yourResult.delta !== 1) throw new Error("第一轮谨慎策略结算错误");

  console.log(`联机流程通过：房间 ${host.roomCode}，2 名玩家，状态 ${snapshot.status}`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
