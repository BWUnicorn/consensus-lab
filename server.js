const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { questionBank } = require("./question-bank");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS || 60);
const QUESTIONS_PER_GAME = 10;
const AI_DELAY_MIN_MS = Number(process.env.AI_DELAY_MIN_MS || 1800);
const AI_DELAY_MAX_MS = Number(process.env.AI_DELAY_MAX_MS || 5200);
const MATCH_COUNTDOWN_SECONDS = Number(process.env.MATCH_COUNTDOWN_SECONDS || 15);
const MATCH_AI_FILL_SECONDS = Number(process.env.MATCH_AI_FILL_SECONDS || 20);
const MATCH_AI_START_SECONDS = Number(process.env.MATCH_AI_START_SECONDS || 3);
const MATCH_TARGET_PLAYERS = Number(process.env.MATCH_TARGET_PLAYERS || 4);
const AUTO_NEXT_SECONDS = Number(process.env.AUTO_NEXT_SECONDS || 8);
const HOST_TRANSFER_DELAY_SECONDS = Number(process.env.HOST_TRANSFER_DELAY_SECONDS || 10);
const ADMIN_TRIGGER_HASH = String(process.env.ADMIN_TRIGGER_HASH || "b36769b0d3377eeef902c6250c2435c3d07b316a62e1616e8c66cd05a8e4e044").toLowerCase();
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const SERVER_STARTED_AT = Date.now();
const rooms = new Map();
const adminSessions = new Map();

const aiProfiles = [
  { id: "conservative", label: "保守者" },
  { id: "aggressive", label: "激进派" },
  { id: "cooperative", label: "合作者" },
  { id: "opportunist", label: "机会主义者" },
  { id: "random", label: "随机者" },
];

const plannedAIProfileIds = aiProfiles.filter((profile) => profile.id !== "random").map((profile) => profile.id);
const intentionallySymmetricOptionIds = new Set([
  "hidden-color-v2",
  "single-ticket-v2",
  "average-guess-v2",
  "median-rendezvous",
]);

const aiNames = ["白帆", "北辰", "回声", "星轨", "木棉", "深蓝", "微光", "潮汐", "云雀"];

function validateQuestionBank() {
  if (questionBank.length !== 20) throw new Error(`题库必须恰好包含 20 题，当前为 ${questionBank.length} 题`);
  const ids = new Set();
  for (const question of questionBank) {
    if (ids.has(question.id)) throw new Error(`题目 ID 重复：${question.id}`);
    ids.add(question.id);
    const optionIds = new Set(question.options.map((option) => option.id));
    const optionDetails = new Set(question.options.map((option) => option.detail));
    if (optionDetails.size === 1 && !intentionallySymmetricOptionIds.has(question.id)) {
      throw new Error(`题目 ${question.id} 的所有选项收益说明完全相同，缺少可辨识的策略差异`);
    }
    for (const profileId of plannedAIProfileIds) {
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

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function isAdminTrigger(value) {
  const candidate = Buffer.from(sha256(value), "hex");
  const expected = Buffer.from(ADMIN_TRIGGER_HASH, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function createAdminSession() {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

function requireAdmin(payload) {
  const token = String(payload.adminToken || "");
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return true;
}

function adminStatistics() {
  const roomList = [...rooms.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((room) => {
      const humans = humanPlayers(room);
      const aiCount = [...room.players.values()].filter((player) => player.isAI).length;
      return {
        code: room.code,
        status: room.status,
        matchmaking: room.matchmaking,
        playerCount: room.players.size,
        humanCount: humans.length,
        onlineHumanCount: humans.filter((player) => player.connected).length,
        aiCount,
        round: room.questionIds.length ? room.roundIndex + 1 : 0,
        roundCount: room.questionIds.length || QUESTIONS_PER_GAME,
        updatedAt: room.updatedAt,
      };
    });
  return {
    generatedAt: Date.now(),
    serverStartedAt: SERVER_STARTED_AT,
    uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
    totals: {
      rooms: roomList.length,
      activeGames: roomList.filter((room) => room.status === "playing" || room.status === "result").length,
      waitingRooms: roomList.filter((room) => room.status === "lobby").length,
      matchmakingRooms: roomList.filter((room) => room.matchmaking && room.status === "lobby").length,
      onlineHumans: roomList.reduce((sum, room) => sum + room.onlineHumanCount, 0),
      humanPlayers: roomList.reduce((sum, room) => sum + room.humanCount, 0),
      aiPlayers: roomList.reduce((sum, room) => sum + room.aiCount, 0),
    },
    rooms: roomList,
  };
}

function selectQuestions(count = QUESTIONS_PER_GAME) {
  const shuffled = [...questionBank];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const selected = shuffled.slice(0, Math.min(count, shuffled.length)).map((question) => question.id);
  return selected;
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

const strategyDimensionLabels = {
  cooperation: "合作",
  risk: "冒险",
  conformity: "从众",
  contrarian: "逆向",
  selfInterest: "利己",
};

const strategyPersonalities = {
  cooperation: {
    title: "协作建构者",
    description: "你愿意为共同收益创造条件。比起独自领先，你更关注一群人能否一起走得更远。",
  },
  risk: {
    title: "风险猎手",
    description: "你愿意接受波动，换取更高的潜在回报。局势越不确定，越容易激发你的判断力。",
  },
  conformity: {
    title: "共识追随者",
    description: "你擅长感知群体方向，并让自己站在共识一侧。你相信多数人的选择本身也是重要信息。",
  },
  contrarian: {
    title: "逆向观察者",
    description: "你习惯避开拥挤的答案，从被忽视的位置寻找机会。群体越一致，你越会重新检查另一种可能。",
  },
  selfInterest: {
    title: "精致博弈者",
    description: "你会优先计算自身收益，并敏锐捕捉规则中的机会。你很少仅凭善意交出自己的筹码。",
  },
  balanced: {
    title: "混沌变量",
    description: "你的策略会随题目和局势快速变化，很难被一种固定倾向概括。对手很难从过去预测你的下一步。",
  },
};

function buildStrategyProfile(history, playerId) {
  const totals = Object.fromEntries(Object.keys(strategyDimensionLabels).map((key) => [key, 0]));
  let answeredRounds = 0;

  for (const round of history || []) {
    const question = questionBank.find((candidate) => candidate.id === round.question?.id);
    const playerResult = round.results?.find((item) => item.playerId === playerId);
    if (!question || !playerResult?.option) continue;

    const option = playerResult.option;
    answeredRounds += 1;
    if (option === question.aiChoices.cooperative) totals.cooperation += 100;
    if (option === question.aiChoices.aggressive) totals.risk += 100;
    if (option === question.aiChoices.opportunist) totals.selfInterest += 100;

    const chosenCount = Number(round.distribution?.[option] || 0);
    const positiveCounts = Object.values(round.distribution || {}).map(Number).filter((count) => count > 0);
    const maximum = positiveCounts.length ? Math.max(...positiveCounts) : chosenCount;
    const minimum = positiveCounts.length ? Math.min(...positiveCounts) : chosenCount;
    const popularity = maximum === minimum ? 50 : ((chosenCount - minimum) / (maximum - minimum)) * 100;
    totals.conformity += popularity;
    totals.contrarian += 100 - popularity;
  }

  const divisor = Math.max(1, answeredRounds);
  const scores = Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, Math.round(value / divisor)]),
  );
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const personalityKey = ranked[0][1] - ranked[ranked.length - 1][1] < 18 ? "balanced" : ranked[0][0];
  const personality = strategyPersonalities[personalityKey];

  return {
    title: personality.title,
    description: personality.description,
    answeredRounds,
    dimensions: Object.entries(strategyDimensionLabels).map(([key, label]) => ({ key, label, score: scores[key] })),
  };
}

function settleQuestion(question, answers, players = new Map()) {
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
      if (answer.option === rule.safe) return result(answer, rule.safeScore, `稳妥选择固定获得 ${rule.safeScore} 分`);
      if (answer.option === rule.majority && counts[answer.option] === maximum) return result(answer, rule.majorityScore, "你的选择成为人数最多的方案");
      if (answer.option === rule.minority && counts[answer.option] === minimum) return result(answer, rule.minorityScore, "你的选择成为人数最少的方案");
      return result(answer, rule.otherScore, "本轮得分条件没有满足");
    });
  }

  if (rule.type === "dynamic-cooperation") {
    const limit = Math.ceil(answers.length * rule.defectRatio);
    const defectors = counts[rule.defect] || 0;
    const succeeded = defectors < limit;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.defect) return result(answer, rule.defectScore, `破坏者固定获得 ${rule.defectScore} 分`);
      return succeeded
        ? result(answer, rule.successScore, `破坏者少于 ${limit} 人，协议成立`)
        : result(answer, rule.failScore, `破坏者达到 ${limit} 人，协议失败`);
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

  if (rule.type === "leader-risk") {
    const scores = [...players.values()].map((player) => player.score);
    const highestScore = scores.length ? Math.max(...scores) : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const currentScore = players.get(answer.playerId)?.score || 0;
      if (answer.option === rule.insure) {
        return result(answer, rule.insuranceCost, "支付固定保险成本，避开排名风险");
      }
      if (currentScore > 0 && currentScore === highestScore) {
        return result(answer, -currentScore, "你处于并列最高分，总积分被重置为 0");
      }
      return result(answer, 0, "你不是正分领先者，本轮积分不变");
    });
  }

  if (rule.type === "crowd-forecast") {
    const distances = submitted.map((answer) => Math.abs(counts[answer.option] - rule.values[answer.option]));
    const bestDistance = distances.length ? Math.min(...distances) : 0;
    const worstDistance = distances.length ? Math.max(...distances) : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const distance = Math.abs(counts[answer.option] - rule.values[answer.option]);
      if (distance === bestDistance) return result(answer, rule.bestScore, `人数预测误差为 ${distance}，属于最接近的一组`);
      if (distance === worstDistance) return result(answer, rule.worstScore, `人数预测误差为 ${distance}，属于最远的一组`);
      return result(answer, 0, `人数预测误差为 ${distance}`);
    });
  }

  if (rule.type === "team-auction") {
    const teamTotals = Object.fromEntries(optionIds.map((option) => [option, counts[option] * rule.values[option]]));
    const highestTotal = Math.max(0, ...Object.values(teamTotals));
    const winners = optionIds.filter((option) => counts[option] > 0 && teamTotals[option] === highestTotal);
    const poolPerTeam = winners.length ? rule.pool / winners.length : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (!winners.includes(answer.option)) return result(answer, 0, `团队总出价 ${teamTotals[answer.option]}，未赢得奖池`);
      const teamSize = counts[answer.option];
      const score = roundScore((poolPerTeam - teamTotals[answer.option]) / teamSize);
      return result(answer, score, `团队总出价 ${teamTotals[answer.option]} 获胜，扣除出价后平分奖池`);
    });
  }

  if (rule.type === "congestion") {
    const rawCapacity = answers.length * rule.capacityRatio;
    const capacity = rule.capacityRounding === "ceil" ? Math.ceil(rawCapacity) : Math.max(1, Math.floor(rawCapacity));
    const crowded = counts[rule.attend] > capacity;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.attend) {
        return crowded
          ? result(answer, rule.attendCrowded, `参加者超过容量 ${capacity} 人`)
          : result(answer, rule.attendSuccess, `参加者未超过容量 ${capacity} 人`);
      }
      if (Number.isFinite(rule.fixedStayScore)) {
        return result(answer, rule.fixedStayScore, `稳定支路固定获得 ${rule.fixedStayScore} 分`);
      }
      return crowded
        ? result(answer, rule.stayCrowded, "热门活动过度拥挤，你成功避开人群")
        : result(answer, rule.stayQuiet, "活动未拥挤，你获得留守收益");
    });
  }

  if (rule.type === "volunteer-dilemma") {
    const hasVolunteer = counts[rule.volunteer] > 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.volunteer) return result(answer, rule.volunteerScore, "你承担了任务，确保团队目标完成");
      return hasVolunteer
        ? result(answer, rule.freeRideScore, "有人承担任务，你获得搭便车收益")
        : result(answer, 0, "无人承担任务，团队目标失败");
    });
  }

  if (rule.type === "tiered-contribution") {
    const total = submitted.reduce((sum, answer) => sum + rule.values[answer.option], 0);
    const required = answers.length * rule.requiredPerPlayer;
    const succeeded = total >= required;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const score = succeeded ? rule.successScores[answer.option] : rule.failScores[answer.option];
      return result(answer, score, `总投入 ${total}/${required}，工程${succeeded ? "成功" : "失败"}`);
    });
  }

  if (rule.type === "single-dare") {
    const dareCount = counts[rule.dare] || 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.dare) {
        return dareCount === 1
          ? result(answer, rule.loneDareScore, "你是唯一坚持者，独占先机")
          : result(answer, rule.conflictScore, "多名玩家同时坚持，发生冲突");
      }
      return dareCount === 0
        ? result(answer, rule.noDareSafeScore, "无人坚持，所有人有序通过")
        : result(answer, rule.safeWhenDaredScore, "你选择避让，避免了冲突");
    });
  }

  if (rule.type === "closest-median") {
    if (!submitted.length) return answers.map((answer) => result(answer, 0, "无人提交答案"));
    const values = submitted.map((answer) => rule.values[answer.option]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    const closest = Math.min(...submitted.map((answer) => Math.abs(rule.values[answer.option] - median)));
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const won = Math.abs(rule.values[answer.option] - median) === closest;
      return won
        ? result(answer, rule.winScore, `最接近中位数 ${median}`)
        : result(answer, rule.otherScore, `中位数为 ${median}，获得基础分`);
    });
  }

  if (rule.type === "asymmetric-congestion") {
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.safe) return result(answer, rule.safeScore, "持有现金获得固定收益");
      const market = rule.markets[answer.option];
      const capacity = Math.ceil(answers.length * market.ratio);
      const crowded = counts[answer.option] > capacity;
      return crowded
        ? result(answer, market.crowdedScore, `该市场人数超过容量 ${capacity}`)
        : result(answer, market.successScore, `该市场人数未超过容量 ${capacity}`);
    });
  }

  if (rule.type === "role-coalition") {
    const requiredSupporters = Math.ceil(answers.length * rule.supporterRatio);
    const succeeded = counts[rule.leader] === 1 && counts[rule.supporter] >= requiredSupporters;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.observer) return result(answer, rule.observerScore, "观察员获得固定收益");
      if (answer.option === rule.leader) {
        return result(answer, succeeded ? rule.leaderSuccess : rule.leaderFail, succeeded ? "你是唯一指挥，探险队组建成功" : "指挥或队员人数不符合要求");
      }
      return result(answer, succeeded ? rule.supporterSuccess : rule.supporterFail, succeeded ? "探险队组建成功" : `至少需要 ${requiredSupporters} 名队员及唯一指挥`);
    });
  }

  if (rule.type === "hybrid") {
    const required = Math.ceil(answers.length * rule.thresholdRatio);
    const thresholdReached = counts[rule.threshold] >= required;
    const uniqueSucceeded = counts[rule.unique] === 1;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.fixed) return result(answer, rule.fixedScore, "提前交付获得固定收益");
      if (answer.option === rule.threshold) {
        return result(answer, thresholdReached ? rule.thresholdSuccess : rule.thresholdFail, thresholdReached ? `按期协作达到 ${required} 人` : `按期协作未达到 ${required} 人`);
      }
      return result(answer, uniqueSucceeded ? rule.uniqueSuccess : rule.uniqueFail, uniqueSucceeded ? "你是唯一最后冲刺者" : "最后冲刺者不止一人");
    });
  }

  if (rule.type === "minimum-effort") {
    const minimum = submitted.length ? Math.min(...submitted.map((answer) => rule.values[answer.option])) : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const effort = rule.values[answer.option];
      const score = rule.multiplier * minimum - effort + rule.base;
      return result(answer, score, `全队最低努力为 ${minimum}，扣除你的努力成本 ${effort}`);
    });
  }

  if (rule.type === "bank-run") {
    const calculatedLimit = Math.floor(answers.length * rule.safeRatio);
    const safeLimit = rule.allowZeroLimit ? calculatedLimit : Math.max(1, calculatedLimit);
    const runHappened = counts[rule.withdraw] > safeLimit;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.withdraw) {
        return runHappened
          ? result(answer, rule.withdrawRun, `取款人数超过 ${safeLimit} 人，发生挤兑`)
          : result(answer, rule.withdrawSafe, "银行保持稳定，你提前取回资金");
      }
      return runHappened
        ? result(answer, rule.holdRun, `取款人数超过 ${safeLimit} 人，持有资金受损`)
        : result(answer, rule.holdSafe, "银行保持稳定，持有者获得高收益");
    });
  }

  if (rule.type === "lottery") {
    const totalTickets = submitted.reduce((sum, answer) => sum + rule.tickets[answer.option], 0);
    let winnerId = null;
    if (totalTickets > 0) {
      let winningTicket = Math.floor(Math.random() * totalTickets);
      for (const answer of submitted) {
        winningTicket -= rule.tickets[answer.option];
        if (winningTicket < 0) {
          winnerId = answer.playerId;
          break;
        }
      }
    }
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const cost = rule.tickets[answer.option];
      if (answer.playerId === winnerId) return result(answer, rule.prize - cost, `中奖获得 ${rule.prize} 分，扣除 ${cost} 分票价`);
      return result(answer, -cost, cost ? `未中奖，扣除 ${cost} 分票价` : "没有购票，积分不变");
    });
  }

  if (rule.type === "all-pay-auction") {
    const highestBid = submitted.length ? Math.max(...submitted.map((answer) => rule.bids[answer.option])) : 0;
    const winners = submitted.filter((answer) => rule.bids[answer.option] === highestBid);
    if (rule.uniqueOnly) {
      const winnerId = winners.length === 1 ? winners[0].playerId : null;
      return answers.map((answer) => {
        if (!answer.option) return result(answer, 0, "未在规定时间内提交");
        const bid = rule.bids[answer.option];
        const won = answer.playerId === winnerId;
        const score = Math.max(rule.minimumScore, rule.baseScore - bid + (won ? rule.prize : 0));
        return result(answer, score, won ? "你是唯一最高报价者，获得设备奖励" : "支付报价成本，未获得设备奖励");
      });
    }
    const prizeShare = winners.length ? rule.prize / winners.length : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const bid = rule.bids[answer.option];
      const won = bid === highestBid;
      const score = roundScore((won ? prizeShare : 0) - bid);
      return result(answer, score, won ? `并列最高者 ${winners.length} 人，平分奖励后支付出价` : "未获胜，但仍需支付出价");
    });
  }

  if (rule.type === "travelers-dilemma") {
    const minimumClaim = submitted.length ? Math.min(...submitted.map((answer) => rule.claims[answer.option])) : 0;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const isMinimum = rule.claims[answer.option] === minimumClaim;
      const score = isMinimum ? minimumClaim + rule.bonus : Math.max(0, minimumClaim - rule.penalty);
      return result(answer, score, isMinimum ? `你申报最低，获得 ${rule.bonus} 分奖励` : `按最低申报额结算并扣除 ${rule.penalty} 分`);
    });
  }

  if (rule.type === "cyclic-dominance") {
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const defeatedOption = rule.beats[answer.option];
      const defeatingOption = optionIds.find((option) => rule.beats[option] === answer.option);
      const wins = counts[defeatedOption] || 0;
      const losses = counts[defeatingOption] || 0;
      return result(answer, wins - losses, `战胜 ${wins} 人，负于 ${losses} 人`);
    });
  }

  if (rule.type === "majority") {
    const maximum = Math.max(0, ...Object.values(counts));
    const winners = optionIds.filter((option) => counts[option] === maximum && maximum > 0);
    const score = winners.length > 1 ? rule.tieScore : rule.winScore;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      return winners.includes(answer.option)
        ? result(answer, score, winners.length > 1 ? `并列成为最多选择，获得 ${score} 分` : `成为最多选择，获得 ${score} 分`)
        : result(answer, rule.otherScore, "没有进入人数最多的方案");
    });
  }

  if (rule.type === "asymmetric-majority") {
    const maximum = Math.max(0, ...Object.values(counts));
    const winners = optionIds.filter((option) => counts[option] === maximum && maximum > 0);
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const optionScores = rule.scores[answer.option];
      if (!winners.includes(answer.option)) {
        return result(answer, optionScores.lose, `方案落选，按该地点的保底收益获得 ${optionScores.lose} 分`);
      }
      if (winners.length > 1) {
        return result(answer, optionScores.tie, `方案并列第一，按该地点的并列收益获得 ${optionScores.tie} 分`);
      }
      return result(answer, optionScores.win, `方案单独第一，按该地点的协调收益获得 ${optionScores.win} 分`);
    });
  }

  if (rule.type === "minority") {
    const positiveCounts = Object.values(counts).filter((count) => count > 0);
    const minimum = positiveCounts.length ? Math.min(...positiveCounts) : 0;
    const winners = optionIds.filter((option) => counts[option] === minimum && minimum > 0);
    const score = winners.length > 1 ? rule.tieScore : rule.winScore;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      return winners.includes(answer.option)
        ? result(answer, score, winners.length > 1 ? "并列成为人数最少的有效选择" : "成为人数最少的有效选择")
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

  if (rule.type === "asymmetric-balance") {
    const targets = {
      [rule.front]: Math.ceil(answers.length / 2),
      [rule.support]: Math.floor(answers.length / 2),
    };
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      const target = targets[answer.option];
      const actual = counts[answer.option];
      const optionScores = rule.scores[answer.option];
      if (actual === target) {
        return result(answer, optionScores.exact, `岗位人数 ${actual}/${target}，恰好达到理想编制`);
      }
      if (actual < target) {
        return result(answer, optionScores.understaffed, `岗位人数 ${actual}/${target}，当前人手不足`);
      }
      return result(answer, optionScores.overstaffed, `岗位人数 ${actual}/${target}，当前人员过量`);
    });
  }

  if (rule.type === "threshold") {
    const required = Math.ceil(answers.length * rule.ratio);
    const reached = counts[rule.support] >= required;
    return answers.map((answer) => {
      if (!answer.option) return result(answer, 0, "未在规定时间内提交");
      if (answer.option === rule.wait) return result(answer, rule.waitScore, `稳妥选择固定获得 ${rule.waitScore} 分`);
      return reached
        ? result(answer, rule.successScore, `参与人数达到 ${required} 人，行动成功`)
        : result(answer, rule.failScore, `至少需要 ${required} 人参与，行动未启动`);
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
      if (!winner) return result(answer, rule.noWinnerScore, "本轮没有出现唯一选择，获得基础分");
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
      if (answer.option === rule.safe) return result(answer, rule.safeScore, `稳妥选择固定获得 ${rule.safeScore} 分`);
      return unanimous
        ? result(answer, rule.successScore, `全员达成一致，获得 ${rule.successScore} 分`)
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

function createRoomRecord(player, { matchmaking = false } = {}) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: player.id,
    status: "lobby",
    matchmaking,
    roundIndex: 0,
    questionIds: [],
    deadline: null,
    matchDeadline: null,
    matchAiFillDeadline: null,
    autoNextDeadline: null,
    answers: new Map(),
    roundHistory: [],
    players: new Map([[player.id, player]]),
    connections: new Map(),
    lastRound: null,
    roundTimer: null,
    matchTimer: null,
    aiFillTimer: null,
    resultTimer: null,
    hostTransferTimer: null,
    aiTimers: [],
    updatedAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function humanPlayers(room) {
  return [...room.players.values()].filter((player) => !player.isAI);
}

function clearHostTransferTimer(room) {
  clearTimeout(room.hostTransferTimer);
  room.hostTransferTimer = null;
}

function scheduleHostTransfer(room) {
  if (room.matchmaking || room.hostTransferTimer) return;
  const currentHost = room.players.get(room.hostId);
  if (currentHost?.connected) return;
  room.hostTransferTimer = setTimeout(() => {
    room.hostTransferTimer = null;
    const host = room.players.get(room.hostId);
    if (host?.connected) return;
    const replacement = humanPlayers(room).find(
      (candidate) => candidate.id !== room.hostId && candidate.connected,
    );
    if (!replacement) return;
    room.hostId = replacement.id;
    room.updatedAt = Date.now();
    broadcast(room);
  }, HOST_TRANSFER_DELAY_SECONDS * 1000 + 25);
}

function clearMatchmakingTimers(room) {
  clearTimeout(room.matchTimer);
  clearTimeout(room.aiFillTimer);
  room.matchTimer = null;
  room.aiFillTimer = null;
  room.matchDeadline = null;
  room.matchAiFillDeadline = null;
}

function clearResultTimer(room) {
  clearTimeout(room.resultTimer);
  room.resultTimer = null;
  room.autoNextDeadline = null;
}

function prepareGame(room) {
  if (room.status !== "lobby" || room.players.size < 2) return;
  clearMatchmakingTimers(room);
  room.roundIndex = 0;
  room.questionIds = selectQuestions();
  room.roundHistory = [];
  for (const player of room.players.values()) player.score = 0;
  startRound(room);
}

function startMatchCountdown(room, seconds) {
  if (room.matchTimer || room.status !== "lobby") return;
  room.matchDeadline = Date.now() + seconds * 1000;
  room.matchTimer = setTimeout(() => prepareGame(room), seconds * 1000 + 25);
  broadcast(room);
}

function scheduleMatchmaking(room) {
  if (!room.matchmaking || room.status !== "lobby") return;
  const humans = humanPlayers(room).length;
  if (room.players.size >= 10) return prepareGame(room);

  if (humans >= 2) {
    clearTimeout(room.aiFillTimer);
    room.aiFillTimer = null;
    room.matchAiFillDeadline = null;
    startMatchCountdown(room, MATCH_COUNTDOWN_SECONDS);
    return;
  }

  if (humans === 1 && room.players.size > 1) {
    startMatchCountdown(room, MATCH_AI_START_SECONDS);
    return;
  }

  if (humans === 1 && !room.aiFillTimer) {
    room.matchAiFillDeadline = Date.now() + MATCH_AI_FILL_SECONDS * 1000;
    room.aiFillTimer = setTimeout(() => {
      room.aiFillTimer = null;
      room.matchAiFillDeadline = null;
      if (room.status !== "lobby" || humanPlayers(room).length !== 1) return;
      while (room.players.size < Math.min(10, MATCH_TARGET_PLAYERS)) {
        const aiPlayer = createAIPlayer(room);
        room.players.set(aiPlayer.id, aiPlayer);
      }
      room.updatedAt = Date.now();
      startMatchCountdown(room, MATCH_AI_START_SECONDS);
    }, MATCH_AI_FILL_SECONDS * 1000 + 25);
    broadcast(room);
  }
}

function findMatchmakingRoom() {
  return [...rooms.values()]
    .filter((room) => room.matchmaking && room.status === "lobby" && room.players.size < 10)
    .sort((a, b) => a.updatedAt - b.updatedAt)[0] || null;
}

function uniqueNickname(room, requestedName) {
  const names = new Set([...room.players.values()].map((player) => player.name));
  if (!names.has(requestedName)) return requestedName;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${requestedName.slice(0, Math.max(1, 12 - String(suffix).length))}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${requestedName.slice(0, 8)}${crypto.randomUUID().slice(0, 3)}`;
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
    matchmaking: room.matchmaking,
    matchDeadline: room.matchDeadline,
    matchAiFillDeadline: room.matchAiFillDeadline,
    autoNextDeadline: room.autoNextDeadline,
    roundSeconds: ROUND_SECONDS,
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
    review: room.status === "finished" ? room.roundHistory : null,
    strategyProfile: room.status === "finished" ? buildStrategyProfile(room.roundHistory, playerId) : null,
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
  clearResultTimer(room);
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
  const results = settleQuestion(question, answers, room.players);
  for (const item of results) {
    const player = room.players.get(item.playerId);
    if (player) player.score = roundScore(player.score + item.delta);
  }
  const distribution = countOptions(answers, question.options.map((option) => option.id));
  const scoredResults = results.map((item) => ({
    ...item,
    scoreAfter: room.players.get(item.playerId)?.score || 0,
  }));
  room.lastRound = {
    distribution,
    results: scoredResults,
  };
  room.roundHistory.push({
    roundIndex: room.roundIndex,
    question: publicQuestion(question),
    distribution,
    results: scoredResults,
  });
  room.status = "result";
  room.deadline = null;
  room.updatedAt = Date.now();
  if (room.matchmaking) {
    room.autoNextDeadline = Date.now() + AUTO_NEXT_SECONDS * 1000;
    room.resultTimer = setTimeout(() => advanceRoom(room), AUTO_NEXT_SECONDS * 1000 + 25);
  }
  broadcast(room);
}

function advanceRoom(room) {
  if (room.status !== "result") return;
  clearResultTimer(room);
  if (room.roundIndex < room.questionIds.length - 1) {
    room.roundIndex += 1;
    startRound(room);
  } else {
    room.status = "finished";
    room.updatedAt = Date.now();
    broadcast(room);
  }
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

  if (pathname === "/api/admin-login") {
    if (!isAdminTrigger(payload.nickname)) return json(response, 200, { admin: false });
    return json(response, 200, { admin: true, adminToken: createAdminSession() });
  }

  if (pathname === "/api/admin-stats") {
    if (!requireAdmin(payload)) return json(response, 403, { error: "管理员会话已失效" });
    return json(response, 200, adminStatistics());
  }

  if (pathname === "/api/create") {
    const nickname = cleanNickname(payload.nickname);
    if (!nickname) return json(response, 400, { error: "请输入昵称" });
    const player = createPlayer(nickname);
    const room = createRoomRecord(player);
    return json(response, 201, { roomCode: room.code, playerId: player.id });
  }

  if (pathname === "/api/matchmake") {
    const requestedName = cleanNickname(payload.nickname);
    if (!requestedName) return json(response, 400, { error: "请输入昵称" });
    let room = findMatchmakingRoom();
    if (!room) {
      const player = createPlayer(requestedName);
      room = createRoomRecord(player, { matchmaking: true });
      scheduleMatchmaking(room);
      return json(response, 201, { roomCode: room.code, playerId: player.id });
    }
    const player = createPlayer(uniqueNickname(room, requestedName));
    room.players.set(player.id, player);
    room.updatedAt = Date.now();
    scheduleMatchmaking(room);
    broadcast(room);
    return json(response, 201, { roomCode: room.code, playerId: player.id });
  }

  if (pathname === "/api/join") {
    const nickname = cleanNickname(payload.nickname);
    const roomCode = String(payload.roomCode || "").trim().toUpperCase();
    if (!nickname) return json(response, 400, { error: "请输入昵称" });
    const room = rooms.get(roomCode);
    if (!room) return json(response, 404, { error: "没有找到这个房间" });
    if (room.matchmaking) return json(response, 409, { error: "在线匹配房间不能通过房间码加入" });
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

  if (pathname === "/api/resume") {
    return json(response, 200, { ok: true, status: room.status });
  }

  if (pathname === "/api/cancel-match") {
    if (!room.matchmaking || room.status !== "lobby") {
      return json(response, 409, { error: "当前不在匹配队列中" });
    }
    room.players.delete(player.id);
    const connections = room.connections.get(player.id);
    if (connections) for (const connection of connections) connection.end();
    room.connections.delete(player.id);
    clearMatchmakingTimers(room);
    if (humanPlayers(room).length === 0) {
      rooms.delete(room.code);
    } else {
      room.hostId = humanPlayers(room)[0].id;
      room.updatedAt = Date.now();
      scheduleMatchmaking(room);
      broadcast(room);
    }
    return json(response, 200, { ok: true });
  }

  if (pathname === "/api/add-ai") {
    if (room.matchmaking) return json(response, 409, { error: "匹配房间由服务器自动补充AI" });
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
    if (room.matchmaking) return json(response, 409, { error: "匹配房间不能手动移除AI" });
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
    if (room.matchmaking) return json(response, 409, { error: "匹配房间会自动开始" });
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以开始游戏" });
    if (room.status !== "lobby") return json(response, 409, { error: "游戏已经开始" });
    if (room.players.size < 2) return json(response, 409, { error: "至少需要两名玩家" });
    prepareGame(room);
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
    if (room.matchmaking) return json(response, 409, { error: "匹配房间会自动进入下一轮" });
    if (player.id !== room.hostId) return json(response, 403, { error: "只有房主可以进入下一轮" });
    if (room.status !== "result") return json(response, 409, { error: "当前不能进入下一轮" });
    advanceRoom(room);
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
  if (player.id === room.hostId) clearHostTransferTimer(room);
  else scheduleHostTransfer(room);
  sendEvent(response, "snapshot", publicRoom(room, playerId));
  broadcast(room);

  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    connections.delete(response);
    if (connections.size === 0) {
      room.connections.delete(playerId);
      if (!room.players.has(playerId)) return;
      player.connected = false;
      player.lastSeen = Date.now();
      if (player.id === room.hostId) scheduleHostTransfer(room);
      broadcast(room);
    }
  });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
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
      clearMatchmakingTimers(room);
      clearResultTimer(room);
      clearHostTransferTimer(room);
      clearAITimers(room);
      rooms.delete(code);
    }
  }
  const now = Date.now();
  for (const [token, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(token);
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log(`共识实验室已启动：http://localhost:${PORT}`);
});

module.exports = { selectQuestions, settleQuestion, buildStrategyProfile };
