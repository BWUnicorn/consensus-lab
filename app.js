const screens = {
  home: document.querySelector("#home-screen"),
  lobby: document.querySelector("#lobby-screen"),
  game: document.querySelector("#game-screen"),
  result: document.querySelector("#result-screen"),
  final: document.querySelector("#final-screen"),
};

const state = {
  session: null,
  snapshot: null,
  selectedOption: null,
  eventSource: null,
  timer: null,
  renderedRound: null,
};

const elements = {
  nickname: document.querySelector("#nickname"),
  roomInput: document.querySelector("#room-code-input"),
  homeMessage: document.querySelector("#home-message"),
  roomCode: document.querySelector("#room-code"),
  playerCount: document.querySelector("#player-count"),
  playerList: document.querySelector("#player-list"),
  aiControls: document.querySelector("#ai-controls"),
  addAIButton: document.querySelector("#add-ai"),
  copyMessage: document.querySelector("#copy-message"),
  lobbyMessage: document.querySelector("#lobby-message"),
  startButton: document.querySelector("#start-game"),
  currentScore: document.querySelector("#current-score"),
  roundNumber: document.querySelector("#round-number"),
  submissionCount: document.querySelector("#submission-count"),
  timerFill: document.querySelector("#timer-fill"),
  timerText: document.querySelector("#timer-text"),
  roundKicker: document.querySelector("#round-kicker"),
  roundTitle: document.querySelector("#round-title"),
  roundDescription: document.querySelector("#round-description"),
  options: document.querySelector("#options"),
  submit: document.querySelector("#submit-answer"),
  submitMessage: document.querySelector("#submit-message"),
  resultKicker: document.querySelector("#result-kicker"),
  resultSummary: document.querySelector("#result-summary"),
  scoreChange: document.querySelector("#score-change"),
  scoreReason: document.querySelector("#score-reason"),
  distribution: document.querySelector("#distribution"),
  leaderboard: document.querySelector("#leaderboard"),
  nextRound: document.querySelector("#next-round"),
  finalLeaderboard: document.querySelector("#final-leaderboard"),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, node]) => node.classList.toggle("active", key === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function nicknameValue() {
  const nickname = elements.nickname.value.trim();
  if (!nickname) {
    elements.homeMessage.textContent = "先给自己取一个昵称吧。";
    elements.nickname.focus();
    return null;
  }
  elements.homeMessage.textContent = "";
  return nickname;
}

async function api(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

function saveSession(session) {
  state.session = session;
  localStorage.setItem("consensus-lab-session", JSON.stringify(session));
}

function clearSession() {
  state.eventSource?.close();
  clearInterval(state.timer);
  localStorage.removeItem("consensus-lab-session");
  state.session = null;
  state.snapshot = null;
  state.renderedRound = null;
}

async function createRoom() {
  const nickname = nicknameValue();
  if (!nickname) return;
  elements.homeMessage.textContent = "正在创建房间……";
  try {
    const session = await api("/api/create", { nickname });
    saveSession(session);
    connectToRoom();
  } catch (error) {
    elements.homeMessage.textContent = error.message;
  }
}

async function joinRoom() {
  const nickname = nicknameValue();
  if (!nickname) return;
  const roomCode = elements.roomInput.value.trim().toUpperCase();
  if (roomCode.length < 4) {
    elements.homeMessage.textContent = "请输入至少四位房间码。";
    return;
  }
  elements.homeMessage.textContent = "正在加入房间……";
  try {
    const session = await api("/api/join", { nickname, roomCode });
    saveSession(session);
    connectToRoom();
  } catch (error) {
    elements.homeMessage.textContent = error.message;
  }
}

function connectToRoom() {
  state.eventSource?.close();
  const params = new URLSearchParams(state.session);
  const source = new EventSource(`/api/events?${params}`);
  state.eventSource = source;

  source.addEventListener("snapshot", (event) => {
    state.snapshot = JSON.parse(event.data);
    renderSnapshot(state.snapshot);
  });

  source.onerror = () => {
    const activeMessage = screens.lobby.classList.contains("active") ? elements.lobbyMessage : elements.submitMessage;
    activeMessage.textContent = "连接暂时中断，正在自动重连……";
  };
}

function renderSnapshot(snapshot) {
  if (snapshot.status === "lobby") renderLobby(snapshot);
  if (snapshot.status === "playing") renderGame(snapshot);
  if (snapshot.status === "result") renderResult(snapshot);
  if (snapshot.status === "finished") renderFinal(snapshot);
}

function renderLobby(snapshot) {
  clearInterval(state.timer);
  elements.roomCode.textContent = snapshot.code;
  elements.playerCount.textContent = snapshot.players.length;
  const isHost = snapshot.hostId === snapshot.yourPlayerId;
  elements.playerList.innerHTML = snapshot.players
    .map(
      (player) => `
        <li>
          <span class="player-avatar">${escapeHtml(player.name.slice(0, 1))}</span>
          <span class="player-name">${escapeHtml(player.name)}${player.id === snapshot.yourPlayerId ? "（你）" : ""}</span>
          ${player.isAI ? `<span class="ai-badge">AI · ${escapeHtml(player.aiProfile)}</span>` : ""}
          ${player.isHost ? '<span class="host-badge">房主</span>' : ""}
          ${isHost && player.isAI ? `<button class="remove-ai-button" data-ai-id="${player.id}" aria-label="移除${escapeHtml(player.name)}">×</button>` : ""}
        </li>`,
    )
    .join("");

  elements.playerList.querySelectorAll(".remove-ai-button").forEach((button) => {
    button.addEventListener("click", () => removeAIPlayer(button.dataset.aiId));
  });
  elements.aiControls.hidden = !isHost;
  elements.addAIButton.disabled = snapshot.players.length >= 10;
  elements.startButton.hidden = !isHost;
  elements.startButton.disabled = snapshot.players.length < 2;
  elements.startButton.textContent = snapshot.players.length < 2 ? "等待第二名玩家" : "开始第一轮";
  elements.lobbyMessage.textContent = isHost ? "" : "等待房主开始游戏";
  showScreen("lobby");
}

async function addAIPlayer() {
  elements.addAIButton.disabled = true;
  elements.lobbyMessage.textContent = "正在分配AI身份……";
  try {
    await api("/api/add-ai", state.session);
  } catch (error) {
    elements.lobbyMessage.textContent = error.message;
    elements.addAIButton.disabled = false;
  }
}

async function removeAIPlayer(aiPlayerId) {
  elements.lobbyMessage.textContent = "正在移除AI玩家……";
  try {
    await api("/api/remove-ai", { ...state.session, aiPlayerId });
  } catch (error) {
    elements.lobbyMessage.textContent = error.message;
  }
}

function renderGame(snapshot) {
  const round = snapshot.question;
  const yourPlayer = snapshot.players.find((player) => player.id === snapshot.yourPlayerId);
  elements.currentScore.textContent = yourPlayer?.score ?? 0;
  elements.roundNumber.textContent = `ROUND ${String(snapshot.roundIndex + 1).padStart(2, "0")}`;
  elements.submissionCount.textContent = `${snapshot.submissionCount}/${snapshot.players.length} 已提交`;

  if (state.renderedRound !== round.id || !screens.game.classList.contains("active")) {
    state.renderedRound = round.id;
    state.selectedOption = snapshot.yourAnswer;
    elements.roundKicker.textContent = `第 ${snapshot.roundIndex + 1} 题 · ${round.kicker}`;
    elements.roundTitle.textContent = round.title;
    elements.roundDescription.textContent = round.description;
    elements.options.innerHTML = round.options
      .map(
        (option) => `
          <button class="option-button" data-option="${option.id}" role="radio" aria-checked="false">
            <span class="option-letter">${option.id}</span>
            <span class="option-content">
              <strong>${escapeHtml(option.title)}</strong>
              <small>${escapeHtml(option.detail)}</small>
            </span>
          </button>`,
      )
      .join("");
    elements.options.querySelectorAll(".option-button").forEach((button) => {
      button.addEventListener("click", () => selectOption(button.dataset.option));
    });
    showScreen("game");
  }

  if (snapshot.yourAnswer) markSubmitted(snapshot.yourAnswer);
  else {
    elements.submit.disabled = !state.selectedOption;
    elements.submit.textContent = "确认选择";
    elements.submitMessage.textContent = state.selectedOption
      ? `当前选择：${state.selectedOption}`
      : "选择后提交，提交后不可修改";
  }
  startClientTimer(snapshot.deadline);
}

function selectOption(optionId) {
  if (state.snapshot?.yourAnswer) return;
  state.selectedOption = optionId;
  elements.options.querySelectorAll(".option-button").forEach((button) => {
    const selected = button.dataset.option === optionId;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  elements.submit.disabled = false;
  elements.submitMessage.textContent = `当前选择：${optionId}`;
}

function markSubmitted(optionId) {
  state.selectedOption = optionId;
  elements.options.querySelectorAll(".option-button").forEach((button) => {
    const selected = button.dataset.option === optionId;
    button.classList.toggle("selected", selected);
    button.disabled = true;
    button.setAttribute("aria-checked", String(selected));
  });
  elements.submit.disabled = true;
  elements.submit.textContent = `已提交选项 ${optionId}`;
  elements.submitMessage.textContent = "答案已由服务器锁定，等待其他玩家……";
}

function startClientTimer(deadline) {
  clearInterval(state.timer);
  const update = () => {
    const milliseconds = Math.max(0, deadline - Date.now());
    const seconds = Math.ceil(milliseconds / 1000);
    elements.timerText.textContent = `${seconds}s`;
    elements.timerFill.style.width = `${Math.min(100, (milliseconds / 30_000) * 100)}%`;
    if (milliseconds <= 0) clearInterval(state.timer);
  };
  update();
  state.timer = setInterval(update, 250);
}

async function submitAnswer() {
  if (!state.selectedOption || state.snapshot?.yourAnswer) return;
  elements.submit.disabled = true;
  elements.submitMessage.textContent = "正在提交到服务器……";
  try {
    await api("/api/submit", { ...state.session, option: state.selectedOption });
  } catch (error) {
    elements.submit.disabled = false;
    elements.submitMessage.textContent = error.message;
  }
}

function renderResult(snapshot) {
  clearInterval(state.timer);
  const round = snapshot.question;
  const yourResult = snapshot.lastRound?.yourResult;
  const distribution = snapshot.lastRound?.distribution || {};
  const maxCount = Math.max(1, ...Object.values(distribution));

  elements.resultKicker.textContent = `第 ${snapshot.roundIndex + 1} 轮结算`;
  elements.resultSummary.textContent = `共有 ${snapshot.players.length} 人参与本轮，你选择了 ${yourResult?.option || "未提交"}。`;
  elements.scoreChange.textContent = `${yourResult?.delta >= 0 ? "+" : ""}${yourResult?.delta ?? 0}`;
  elements.scoreReason.textContent = yourResult?.reason || "等待结算信息";
  elements.distribution.innerHTML = round.options
    .map(
      (option) => `
        <div class="distribution-row">
          <span>${option.id}</span>
          <div class="distribution-track">
            <div class="distribution-fill" style="width: ${((distribution[option.id] || 0) / maxCount) * 100}%"></div>
          </div>
          <b>${distribution[option.id] || 0}</b>
        </div>`,
    )
    .join("");
  renderLeaderboard(elements.leaderboard, snapshot);

  const isHost = snapshot.hostId === snapshot.yourPlayerId;
  elements.nextRound.hidden = !isHost;
  elements.nextRound.disabled = false;
  elements.nextRound.textContent = snapshot.roundIndex < snapshot.roundCount - 1 ? "进入下一轮" : "公布最终结果";
  showScreen("result");
}

function sortedPlayers(snapshot) {
  return [...snapshot.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-CN"));
}

function renderLeaderboard(target, snapshot) {
  target.innerHTML = sortedPlayers(snapshot)
    .map(
      (player, index) => `
        <li class="${player.id === snapshot.yourPlayerId ? "is-you" : ""}">
          <span>${index + 1}</span>
          <span>${escapeHtml(player.name)}${player.id === snapshot.yourPlayerId ? "（你）" : ""}</span>
          <b>${player.score} 分</b>
        </li>`,
    )
    .join("");
}

async function nextRound() {
  elements.nextRound.disabled = true;
  try {
    await api("/api/next", state.session);
  } catch (error) {
    elements.resultSummary.textContent = error.message;
    elements.nextRound.disabled = false;
  }
}

function renderFinal(snapshot) {
  clearInterval(state.timer);
  elements.finalLeaderboard.innerHTML = sortedPlayers(snapshot)
    .map(
      (player, index) => `
        <div class="final-rank">
          <span>${index + 1}</span>
          <span>${escapeHtml(player.name)}${player.id === snapshot.yourPlayerId ? "（你）" : ""}</span>
          <b>${player.score} 分</b>
        </div>`,
    )
    .join("");
  showScreen("final");
}

document.querySelector("#create-room").addEventListener("click", createRoom);
document.querySelector("#join-room").addEventListener("click", joinRoom);

document.querySelector("#copy-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.snapshot.code);
    elements.copyMessage.textContent = "房间码已复制";
  } catch {
    elements.copyMessage.textContent = `房间码：${state.snapshot.code}`;
  }
});

elements.startButton.addEventListener("click", async () => {
  elements.startButton.disabled = true;
  elements.lobbyMessage.textContent = "正在开始游戏……";
  try {
    await api("/api/start", state.session);
  } catch (error) {
    elements.lobbyMessage.textContent = error.message;
    elements.startButton.disabled = false;
  }
});

elements.addAIButton.addEventListener("click", addAIPlayer);
elements.submit.addEventListener("click", submitAnswer);
elements.nextRound.addEventListener("click", nextRound);

document.querySelector("#restart-game").addEventListener("click", () => {
  clearSession();
  elements.homeMessage.textContent = "";
  showScreen("home");
});
