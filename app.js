const screens = {
  home: document.querySelector("#home-screen"),
  lobby: document.querySelector("#lobby-screen"),
  admin: document.querySelector("#admin-screen"),
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
  adminTimer: null,
  adminToken: null,
  renderedRound: null,
};

const elements = {
  nickname: document.querySelector("#nickname"),
  roomInput: document.querySelector("#room-code-input"),
  homeMessage: document.querySelector("#home-message"),
  quickMatchButton: document.querySelector("#quick-match"),
  lobbyEyebrow: document.querySelector("#lobby-eyebrow"),
  lobbyTitle: document.querySelector("#lobby-title"),
  lobbyHelp: document.querySelector("#lobby-help"),
  lobbyGrid: document.querySelector("#lobby-grid"),
  roomCard: document.querySelector("#room-card"),
  roomCode: document.querySelector("#room-code"),
  playerCount: document.querySelector("#player-count"),
  playerList: document.querySelector("#player-list"),
  aiControls: document.querySelector("#ai-controls"),
  addAIButton: document.querySelector("#add-ai"),
  copyMessage: document.querySelector("#copy-message"),
  lobbyMessage: document.querySelector("#lobby-message"),
  startButton: document.querySelector("#start-game"),
  cancelMatchButton: document.querySelector("#cancel-match"),
  adminActiveGames: document.querySelector("#admin-active-games"),
  adminOnlineHumans: document.querySelector("#admin-online-humans"),
  adminTotalRooms: document.querySelector("#admin-total-rooms"),
  adminMatchmakingRooms: document.querySelector("#admin-matchmaking-rooms"),
  adminAIPlayers: document.querySelector("#admin-ai-players"),
  adminUptime: document.querySelector("#admin-uptime"),
  adminUpdatedAt: document.querySelector("#admin-updated-at"),
  adminRoomList: document.querySelector("#admin-room-list"),
  adminMessage: document.querySelector("#admin-message"),
  exitAdminButton: document.querySelector("#exit-admin"),
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
  scoreTotal: document.querySelector("#score-total"),
  scoreReason: document.querySelector("#score-reason"),
  distribution: document.querySelector("#distribution"),
  nextRound: document.querySelector("#next-round"),
  resultAutoMessage: document.querySelector("#result-auto-message"),
  finalLeaderboard: document.querySelector("#final-leaderboard"),
  scoreTrend: document.querySelector("#score-trend"),
  reviewRounds: document.querySelector("#review-rounds"),
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
  elements.quickMatchButton.disabled = false;
  elements.cancelMatchButton.disabled = false;
}

async function restoreSession() {
  const savedSession = localStorage.getItem("consensus-lab-session");
  if (!savedSession) return;
  try {
    const session = JSON.parse(savedSession);
    if (!session?.roomCode || !session?.playerId) throw new Error("会话信息不完整");
    state.session = session;
    elements.homeMessage.textContent = "正在恢复上次的房间……";
    await api("/api/resume", session);
    connectToRoom();
  } catch {
    clearSession();
    elements.homeMessage.textContent = "上次的房间已经结束，请重新加入。";
    showScreen("home");
  }
}

async function tryOpenAdmin(nickname) {
  try {
    const result = await api("/api/admin-login", { nickname });
    if (!result.admin) return false;
    state.eventSource?.close();
    state.adminToken = result.adminToken;
    sessionStorage.setItem("consensus-lab-admin-token", result.adminToken);
    elements.nickname.value = "";
    await startAdminConsole();
    return true;
  } catch {
    return false;
  }
}

function formatUptime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours ? `${hours}时${minutes}分` : `${minutes}分`;
}

function roomStatusLabel(status) {
  return ({ lobby: "等待中", playing: "答题中", result: "结算中", finished: "已结束" })[status] || status;
}

async function refreshAdminStats() {
  const stats = await api("/api/admin-stats", { adminToken: state.adminToken });
  elements.adminActiveGames.textContent = stats.totals.activeGames;
  elements.adminOnlineHumans.textContent = stats.totals.onlineHumans;
  elements.adminTotalRooms.textContent = stats.totals.rooms;
  elements.adminMatchmakingRooms.textContent = stats.totals.matchmakingRooms;
  elements.adminAIPlayers.textContent = stats.totals.aiPlayers;
  elements.adminUptime.textContent = formatUptime(stats.uptimeSeconds);
  elements.adminUpdatedAt.textContent = `更新于 ${new Date(stats.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
  elements.adminRoomList.innerHTML = stats.rooms.length
    ? stats.rooms.map((room) => `
      <tr>
        <td><b>${escapeHtml(room.code)}</b></td>
        <td><span class="admin-status status-${escapeHtml(room.status)}">${escapeHtml(roomStatusLabel(room.status))}</span></td>
        <td>${room.matchmaking ? "在线匹配" : "私人房间"}</td>
        <td>${room.onlineHumanCount}/${room.humanCount}</td>
        <td>${room.aiCount}</td>
        <td>${room.round ? `${room.round}/${room.roundCount}` : "未开始"}</td>
        <td>${new Date(room.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="admin-empty">当前没有房间</td></tr>';
  elements.adminMessage.textContent = "";
}

async function startAdminConsole() {
  clearInterval(state.adminTimer);
  showScreen("admin");
  try {
    await refreshAdminStats();
    state.adminTimer = setInterval(async () => {
      try {
        await refreshAdminStats();
      } catch (error) {
        elements.adminMessage.textContent = error.message;
      }
    }, 3000);
  } catch (error) {
    exitAdminConsole();
    elements.homeMessage.textContent = error.message;
  }
}

function exitAdminConsole() {
  clearInterval(state.adminTimer);
  state.adminTimer = null;
  state.adminToken = null;
  sessionStorage.removeItem("consensus-lab-admin-token");
  showScreen("home");
}

async function restoreAdminConsole() {
  const token = sessionStorage.getItem("consensus-lab-admin-token");
  if (!token) return false;
  state.adminToken = token;
  try {
    await startAdminConsole();
    return Boolean(state.adminToken);
  } catch {
    exitAdminConsole();
    return false;
  }
}

async function createRoom() {
  const nickname = nicknameValue();
  if (!nickname) return;
  if (await tryOpenAdmin(nickname)) return;
  elements.homeMessage.textContent = "正在创建房间……";
  try {
    const session = await api("/api/create", { nickname });
    saveSession(session);
    connectToRoom();
  } catch (error) {
    elements.homeMessage.textContent = error.message;
  }
}

async function quickMatch() {
  const nickname = nicknameValue();
  if (!nickname) return;
  if (await tryOpenAdmin(nickname)) return;
  elements.quickMatchButton.disabled = true;
  elements.homeMessage.textContent = "正在寻找在线玩家……";
  try {
    const session = await api("/api/matchmake", { nickname });
    saveSession(session);
    connectToRoom();
  } catch (error) {
    elements.homeMessage.textContent = error.message;
    elements.quickMatchButton.disabled = false;
  }
}

async function joinRoom() {
  const nickname = nicknameValue();
  if (!nickname) return;
  if (await tryOpenAdmin(nickname)) return;
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
  const isMatchmaking = snapshot.matchmaking;
  elements.roomCode.textContent = snapshot.code;
  elements.playerCount.textContent = snapshot.players.length;
  const isHost = snapshot.hostId === snapshot.yourPlayerId;
  elements.lobbyEyebrow.textContent = isMatchmaking ? "ONLINE MATCHMAKING" : "等待其他参与者";
  elements.lobbyTitle.textContent = isMatchmaking ? "正在匹配对手" : "房间已准备好";
  elements.lobbyHelp.textContent = isMatchmaking
    ? "匹配完成后由服务器自动开局，最多 10 人。"
    : "把房间码发给朋友，至少两人即可开始。";
  elements.roomCard.hidden = isMatchmaking;
  elements.lobbyGrid.classList.toggle("matchmaking", isMatchmaking);
  elements.playerList.innerHTML = snapshot.players
    .map(
      (player) => `
        <li>
          <span class="player-avatar">${escapeHtml(player.name.slice(0, 1))}</span>
          <span class="player-name">${escapeHtml(player.name)}${player.id === snapshot.yourPlayerId ? "（你）" : ""}</span>
          ${player.isAI ? `<span class="ai-badge">AI · ${escapeHtml(player.aiProfile)}</span>` : ""}
          ${player.isHost && !isMatchmaking ? '<span class="host-badge">房主</span>' : ""}
          ${isHost && player.isAI && !isMatchmaking ? `<button class="remove-ai-button" data-ai-id="${player.id}" aria-label="移除${escapeHtml(player.name)}">×</button>` : ""}
        </li>`,
    )
    .join("");

  elements.playerList.querySelectorAll(".remove-ai-button").forEach((button) => {
    button.addEventListener("click", () => removeAIPlayer(button.dataset.aiId));
  });
  elements.aiControls.hidden = isMatchmaking || !isHost;
  elements.addAIButton.disabled = snapshot.players.length >= 10;
  elements.startButton.hidden = isMatchmaking || !isHost;
  elements.startButton.disabled = snapshot.players.length < 2;
  elements.startButton.textContent = snapshot.players.length < 2 ? "等待第二名玩家" : "开始第一轮";
  elements.cancelMatchButton.hidden = !isMatchmaking;
  elements.lobbyMessage.classList.toggle("matchmaking-status", isMatchmaking);
  if (isMatchmaking) startMatchmakingTimer(snapshot);
  else elements.lobbyMessage.textContent = isHost ? "" : "等待房主开始游戏";
  showScreen("lobby");
}

function startMatchmakingTimer(snapshot) {
  const update = () => {
    if (snapshot.matchDeadline) {
      const seconds = Math.max(0, Math.ceil((snapshot.matchDeadline - Date.now()) / 1000));
      elements.lobbyMessage.textContent = seconds > 0
        ? `已组成对局，${seconds} 秒后自动开始；仍可继续加入玩家。`
        : "对局即将开始……";
      return;
    }
    if (snapshot.matchAiFillDeadline) {
      const seconds = Math.max(0, Math.ceil((snapshot.matchAiFillDeadline - Date.now()) / 1000));
      elements.lobbyMessage.textContent = `正在寻找真人玩家；${seconds} 秒后将由 AI 补足到 4 人。`;
      return;
    }
    elements.lobbyMessage.textContent = "正在整理匹配结果……";
  };
  update();
  state.timer = setInterval(update, 250);
}

async function cancelMatch() {
  elements.cancelMatchButton.disabled = true;
  elements.lobbyMessage.textContent = "正在退出匹配……";
  try {
    await api("/api/cancel-match", state.session);
    clearSession();
    elements.quickMatchButton.disabled = false;
    elements.homeMessage.textContent = "已退出匹配。";
    showScreen("home");
  } catch (error) {
    elements.lobbyMessage.textContent = error.message;
    elements.cancelMatchButton.disabled = false;
  }
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
  startClientTimer(snapshot.deadline, snapshot.roundSeconds);
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

function startClientTimer(deadline, durationSeconds = 60) {
  clearInterval(state.timer);
  const update = () => {
    const milliseconds = Math.max(0, deadline - Date.now());
    const seconds = Math.ceil(milliseconds / 1000);
    elements.timerText.textContent = `${seconds}s`;
    elements.timerFill.style.width = `${Math.min(100, (milliseconds / (durationSeconds * 1000)) * 100)}%`;
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
  const yourPlayer = snapshot.players.find((player) => player.id === snapshot.yourPlayerId);
  const distribution = snapshot.lastRound?.distribution || {};
  const maxCount = Math.max(1, ...Object.values(distribution));

  elements.resultKicker.textContent = `第 ${snapshot.roundIndex + 1} 轮结算`;
  elements.resultSummary.textContent = `共有 ${snapshot.players.length} 人参与本轮，你选择了 ${yourResult?.option || "未提交"}。`;
  elements.scoreChange.textContent = `${yourResult?.delta >= 0 ? "+" : ""}${yourResult?.delta ?? 0}`;
  elements.scoreTotal.textContent = `累计 ${yourPlayer?.score ?? 0} 分`;
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
  const isHost = snapshot.hostId === snapshot.yourPlayerId;
  elements.nextRound.hidden = snapshot.matchmaking || !isHost;
  elements.nextRound.disabled = false;
  elements.nextRound.textContent = snapshot.roundIndex < snapshot.roundCount - 1 ? "进入下一轮" : "公布最终结果";
  elements.resultAutoMessage.hidden = !snapshot.matchmaking;
  showScreen("result");
  if (snapshot.matchmaking) startAutoNextTimer(snapshot);
}

function startAutoNextTimer(snapshot) {
  const update = () => {
    const seconds = Math.max(0, Math.ceil((snapshot.autoNextDeadline - Date.now()) / 1000));
    elements.resultAutoMessage.textContent = snapshot.roundIndex < snapshot.roundCount - 1
      ? `${seconds} 秒后自动进入下一轮`
      : `${seconds} 秒后公布最终结果`;
    if (seconds <= 0) clearInterval(state.timer);
  };
  update();
  state.timer = setInterval(update, 250);
}

function sortedPlayers(snapshot) {
  return [...snapshot.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-CN"));
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
  renderScoreTrend(snapshot);
  renderRoundReview(snapshot);
  showScreen("final");
}

function renderScoreTrend(snapshot) {
  const history = snapshot.review || [];
  if (!history.length) {
    elements.scoreTrend.textContent = "暂无复盘数据";
    return;
  }

  const width = 760;
  const height = 280;
  const padding = { top: 22, right: 24, bottom: 38, left: 46 };
  const colors = ["#4de3c1", "#8a6cff", "#ff74bb", "#ffc96b", "#55a7ff", "#ff7d8c", "#8fe36b", "#d78cff", "#65d7ff", "#f2a65a"];
  const series = snapshot.players.map((player, playerIndex) => {
    let lastScore = 0;
    const scores = [0, ...history.map((round) => {
      const result = round.results.find((item) => item.playerId === player.id);
      if (result) lastScore = result.scoreAfter;
      return lastScore;
    })];
    return { player, scores, color: colors[playerIndex % colors.length] };
  });
  const values = series.flatMap((item) => item.scores);
  let minimum = Math.min(0, ...values);
  let maximum = Math.max(0, ...values);
  if (minimum === maximum) maximum = minimum + 1;
  const scoreRange = maximum - minimum;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const x = (index) => padding.left + (index / history.length) * chartWidth;
  const y = (score) => padding.top + ((maximum - score) / scoreRange) * chartHeight;

  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const score = maximum - ratio * scoreRange;
    const yPosition = padding.top + ratio * chartHeight;
    return `<line x1="${padding.left}" y1="${yPosition}" x2="${width - padding.right}" y2="${yPosition}" class="trend-grid-line" />
      <text x="${padding.left - 9}" y="${yPosition + 4}" class="trend-axis-label" text-anchor="end">${score.toFixed(1).replace(".0", "")}</text>`;
  }).join("");
  const xLabels = Array.from({ length: history.length + 1 }, (_, index) => `
    <text x="${x(index)}" y="${height - 12}" class="trend-axis-label" text-anchor="middle">${index === 0 ? "起" : index}</text>
  `).join("");
  const lines = series.map((item) => {
    const points = item.scores.map((score, index) => `${x(index)},${y(score)}`).join(" ");
    const dots = item.scores.map((score, index) => `<circle cx="${x(index)}" cy="${y(score)}" r="3" fill="${item.color}" />`).join("");
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />${dots}`;
  }).join("");

  elements.scoreTrend.innerHTML = `
    <div class="trend-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="所有玩家十轮积分变化趋势">${grid}${xLabels}${lines}</svg></div>
    <div class="trend-legend">${series.map((item) => `
      <span><i style="background:${item.color}"></i>${escapeHtml(item.player.name)}${item.player.id === snapshot.yourPlayerId ? "（你）" : ""}</span>
    `).join("")}</div>`;
}

function renderRoundReview(snapshot) {
  const history = snapshot.review || [];
  const playerOrder = sortedPlayers(snapshot);
  elements.reviewRounds.innerHTML = history.map((round) => {
    const optionTitles = Object.fromEntries(round.question.options.map((option) => [option.id, option.title]));
    const resultByPlayer = new Map(round.results.map((result) => [result.playerId, result]));
    return `
      <article class="glass-card review-round">
        <header>
          <span>第 ${round.roundIndex + 1} 题 · ${escapeHtml(round.question.kicker)}</span>
          <h3>${escapeHtml(round.question.title)}</h3>
        </header>
        <div class="review-table-wrap">
          <table class="review-table">
            <thead><tr><th>玩家</th><th>选择</th><th>本轮</th><th>累计</th></tr></thead>
            <tbody>${playerOrder.map((player) => {
              const result = resultByPlayer.get(player.id);
              const delta = result?.delta ?? 0;
              const option = result?.option;
              return `<tr class="${player.id === snapshot.yourPlayerId ? "is-you" : ""}">
                <td>${escapeHtml(player.name)}${player.isAI ? " · AI" : ""}</td>
                <td>${option ? `${option} · ${escapeHtml(optionTitles[option] || option)}` : "未提交"}</td>
                <td class="${delta > 0 ? "score-up" : delta < 0 ? "score-down" : ""}">${delta > 0 ? "+" : ""}${delta}</td>
                <td>${result?.scoreAfter ?? 0} 分</td>
              </tr>`;
            }).join("")}</tbody>
          </table>
        </div>
      </article>`;
  }).join("");
}

document.querySelector("#create-room").addEventListener("click", createRoom);
document.querySelector("#join-room").addEventListener("click", joinRoom);
elements.quickMatchButton.addEventListener("click", quickMatch);
elements.nickname.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const nickname = nicknameValue();
  if (!nickname) return;
  const opened = await tryOpenAdmin(nickname);
  if (!opened) elements.homeMessage.textContent = "请选择快速匹配、创建房间或输入房间码。";
});

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
elements.cancelMatchButton.addEventListener("click", cancelMatch);
elements.exitAdminButton.addEventListener("click", exitAdminConsole);
elements.submit.addEventListener("click", submitAnswer);
elements.nextRound.addEventListener("click", nextRound);

document.querySelector("#restart-game").addEventListener("click", () => {
  clearSession();
  elements.homeMessage.textContent = "";
  showScreen("home");
});

async function initializeApp() {
  if (await restoreAdminConsole()) return;
  restoreSession();
}

initializeApp();
