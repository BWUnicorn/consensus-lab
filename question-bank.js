const o = (id, title, detail) => ({ id, title, detail });
const ai = (conservative, aggressive, cooperative, opportunist) => ({
  conservative, aggressive, cooperative, opportunist,
});

const questionBank = [
  {
    id: "strategy-choice-v2", kicker: "集体判断", title: "稳妥、追随共识，还是押注少数？",
    description: "所有人同时选择。多数与少数均按实际选择人数判定；若并列，所有并列选项均视为命中。",
    options: [o("A", "稳妥", "固定获得 1 分"), o("B", "共识", "属于人数最多的选项时得 3 分，否则 0 分"), o("C", "独行", "属于人数最少且至少有人选择的选项时得 4 分，否则 0 分")],
    aiChoices: ai("A", "C", "B", "C"),
    rule: { type: "safe-majority-minority", safe: "A", majority: "B", minority: "C", safeScore: 1, majorityScore: 3, minorityScore: 4, otherScore: 0 },
  },
  {
    id: "peace-agreement-v2", kicker: "信任边界", title: "签署和平协议，还是暗中破坏？",
    description: "破坏者少于玩家总数三分之一（向上取整）时协议成立；达到该人数时协议失败。",
    options: [o("A", "签署", "协议成立得 4 分，失败得 0 分"), o("B", "破坏", "固定获得 2 分")],
    aiChoices: ai("A", "B", "A", "B"),
    rule: { type: "dynamic-cooperation", cooperate: "A", defect: "B", defectRatio: 1 / 3, successScore: 4, failScore: 0, defectScore: 2 },
  },
  {
    id: "shelter-vote", kicker: "非对称协调", title: "避难基地应该建在哪里？",
    description: "得票单独第一视为协调成功。三处基地的建设风险不同，因此协调成功、并列第一和落选时的收益也不同。",
    options: [
      o("A", "山地堡垒", "高风险高回报：单独第一得 6 分，并列第一得 2 分，落选得 0 分"),
      o("B", "河谷营地", "均衡方案：单独第一得 4 分，并列第一得 3 分，落选得 1 分"),
      o("C", "城市地下站", "保底方案：单独第一得 3 分，并列第一或落选均得 2 分"),
    ],
    aiChoices: ai("C", "A", "B", "A"),
    rule: {
      type: "asymmetric-majority",
      scores: {
        A: { win: 6, tie: 2, lose: 0 },
        B: { win: 4, tie: 3, lose: 1 },
        C: { win: 3, tie: 2, lose: 2 },
      },
    },
  },
  {
    id: "hidden-color-v2", kicker: "逆向判断", title: "选择你认为最少人会选的颜色",
    description: "只比较至少有一人选择的颜色。并列最少时，并列选项均得 3 分。",
    options: [o("A", "深蓝", "单独最少得 5 分；其他情况至少得 1 分"), o("B", "赤红", "单独最少得 5 分；其他情况至少得 1 分"), o("C", "明黄", "单独最少得 5 分；其他情况至少得 1 分")],
    aiChoices: ai("A", "C", "A", "C"), rule: { type: "minority", winScore: 5, tieScore: 3, otherScore: 1 },
  },
  {
    id: "rescue-balance", kicker: "目标编制", title: "救援人员应加入前线救治还是后勤运输？",
    description: "理想编制为前线救治 ceil(N/2) 人、后勤运输 floor(N/2) 人。每个岗位按实际人数相对目标的不足、达标或过量分别结算。",
    options: [
      o("A", "前线救治", "风险津贴更高：人数达标得 5 分，不足得 4 分，过量得 0 分"),
      o("B", "后勤运输", "收益更稳定：人数达标得 4 分，不足得 3 分，过量得 1 分"),
    ],
    aiChoices: ai("B", "A", "A", "A"),
    rule: {
      type: "asymmetric-balance",
      front: "A",
      support: "B",
      scores: {
        A: { exact: 5, understaffed: 4, overstaffed: 0 },
        B: { exact: 4, understaffed: 3, overstaffed: 1 },
      },
    },
  },
  {
    id: "public-fund-v2", kicker: "公共选择", title: "是否为公共防护基金出资？",
    description: "至少 60% 玩家出资时基金启动；所需人数向上取整。",
    options: [o("A", "出资", "基金启动得 5 分，否则 0 分"), o("B", "保留资金", "固定获得 2 分")],
    aiChoices: ai("B", "A", "A", "B"), rule: { type: "threshold", support: "A", wait: "B", ratio: 0.6, successScore: 5, failScore: 0, waitScore: 2 },
  },
  {
    id: "shared-warehouse-v2", kicker: "资源分配", title: "你要从共享仓库领取几份物资？",
    description: "仓库总量为玩家人数的 2 倍。总申请不超过容量时按领取量得分；超出时所有人 0 分。",
    options: [o("A", "领取 1 份", "申请成功时得 1 分"), o("B", "领取 2 份", "申请成功时得 2 分"), o("C", "领取 3 份", "申请成功时得 3 分")],
    aiChoices: ai("A", "C", "A", "C"), rule: { type: "shared-capacity", capacityPerPlayer: 2, values: { A: 1, B: 2, C: 3 } },
  },
  {
    id: "single-ticket-v2", kicker: "唯一竞价", title: "为唯一船票选择一个报价",
    description: "从高到低寻找只有一人选择的报价；所有报价都不唯一时无人获胜。",
    options: [1, 2, 3, 4].map((value, index) => o(String.fromCharCode(65 + index), `报价 ${value}`, "成为最高唯一报价得 6 分，其他人得 1 分")),
    aiChoices: ai("B", "D", "B", "D"), rule: { type: "unique-high", values: { A: 1, B: 2, C: 3, D: 4 }, winScore: 6, otherScore: 1, noWinnerScore: 1 },
  },
  {
    id: "average-guess-v2", kicker: "群体预测", title: "猜一个最接近全体平均数 70% 的数字",
    description: "先计算全部选择的平均数，再乘 70% 得到目标值；距离相同则共同获胜。",
    options: [1, 2, 3, 4, 5].map((value, index) => o(String.fromCharCode(65 + index), String(value), "最接近目标值得 5 分，其他人得 1 分")),
    aiChoices: ai("C", "E", "C", "A"), rule: { type: "closest-average", factor: 0.7, values: { A: 1, B: 2, C: 3, D: 4, E: 5 }, winScore: 5, otherScore: 1 },
  },
  {
    id: "signal-tower-v2", kicker: "全体共识", title: "独立维修，还是同步重启信号塔？",
    description: "同步重启必须全员选择才成功；只要有一人未选择就失败。",
    options: [o("A", "独立维修", "固定获得 2 分"), o("B", "同步重启", "全员一致得 6 分，否则 0 分")],
    aiChoices: ai("A", "B", "B", "A"), rule: { type: "unanimity-risk", safe: "A", risk: "B", safeScore: 2, successScore: 6 },
  },
  {
    id: "generator-volunteer", kicker: "志愿者困境", title: "谁来承担启动备用发电机的风险？",
    description: "只要至少一人启动，供电恢复；若无人启动，全员 0 分。",
    options: [o("A", "主动启动", "确保任务成功，获得 2 分"), o("B", "等待他人", "有人启动得 4 分，否则 0 分")],
    aiChoices: ai("A", "B", "A", "B"), rule: { type: "volunteer-dilemma", volunteer: "A", wait: "B", volunteerScore: 2, freeRideScore: 4 },
  },
  {
    id: "supply-contribution", kicker: "分级投入", title: "你愿意为补给工程投入多少单位？",
    description: "全体总投入达到玩家人数时工程成功。成功和失败时，各投入档位的收益顺序相反。",
    options: [o("A", "投入 0", "成功得 3 分，失败得 2 分"), o("B", "投入 1", "成功得 4 分，失败得 1 分"), o("C", "投入 2", "成功得 5 分，失败得 0 分")],
    aiChoices: ai("A", "C", "C", "A"),
    rule: { type: "tiered-contribution", values: { A: 0, B: 1, C: 2 }, requiredPerPlayer: 1, successScores: { A: 3, B: 4, C: 5 }, failScores: { A: 2, B: 1, C: 0 } },
  },
  {
    id: "narrow-passage", kicker: "胆小鬼博弈", title: "狭窄通道中，你选择避让还是坚持前进？",
    description: "坚持者只有一人时可独占先机；两人及以上坚持会发生冲突。",
    options: [o("A", "避让", "无人坚持得 2 分；有人坚持得 3 分"), o("B", "坚持", "只有自己一人坚持得 6 分；多人坚持得 0 分")],
    aiChoices: ai("A", "B", "A", "B"), rule: { type: "single-dare", safe: "A", dare: "B", noDareSafeScore: 2, safeWhenDaredScore: 3, loneDareScore: 6, conflictScore: 0 },
  },
  {
    id: "expressway-congestion", kicker: "拥堵博弈", title: "选择高速通道还是稳定支路？",
    description: "高速通道容量为玩家人数的一半（向上取整）；超出后拥堵归零。",
    options: [o("A", "高速通道", "未超容量得 5 分，否则 0 分"), o("B", "稳定支路", "固定获得 2 分")],
    aiChoices: ai("B", "A", "B", "A"), rule: { type: "congestion", attend: "A", stay: "B", capacityRatio: 0.5, capacityRounding: "ceil", attendSuccess: 5, attendCrowded: 0, fixedStayScore: 2 },
  },
  {
    id: "all-pay-auction", kicker: "成本竞价", title: "为核心设备竞价，你愿意付出多少成本？",
    description: "每人有 4 分基础收益并支付报价。只有唯一最高报价者额外获得 5 分。",
    options: [o("A", "报价 0", "未获奖励时仍保留 4 分"), o("B", "报价 1", "支付 1 分竞价成本"), o("C", "报价 2", "支付 2 分竞价成本"), o("D", "报价 3", "支付 3 分竞价成本")],
    aiChoices: ai("A", "D", "B", "C"), rule: { type: "all-pay-auction", bids: { A: 0, B: 1, C: 2, D: 3 }, baseScore: 4, prize: 5, uniqueOnly: true, minimumScore: 0 },
  },
  {
    id: "median-rendezvous", kicker: "中位数协调", title: "选择 1 至 7 号集合点，猜测群体的中间选择",
    description: "将所有选择排序后取中位数；偶数人数取中间两数的平均值。距离相同则共同获胜。",
    options: [1, 2, 3, 4, 5, 6, 7].map((value, index) => o(String.fromCharCode(65 + index), String(value), "最接近中位数得 5 分，其他人得 1 分")),
    aiChoices: ai("D", "G", "D", "A"), rule: { type: "closest-median", values: { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7 }, winScore: 5, otherScore: 1 },
  },
  {
    id: "asymmetric-market", kicker: "市场进入", title: "进入高收益市场、稳定市场，还是持有现金？",
    description: "高收益市场容量为玩家数三分之一，稳定市场容量为三分之二，均向上取整。",
    options: [o("A", "高收益市场", "未超容量得 6 分，否则 0 分"), o("B", "稳定市场", "未超容量得 4 分，否则 1 分"), o("C", "持有现金", "固定获得 2 分")],
    aiChoices: ai("C", "A", "B", "A"),
    rule: { type: "asymmetric-congestion", markets: { A: { ratio: 1 / 3, successScore: 6, crowdedScore: 0 }, B: { ratio: 2 / 3, successScore: 4, crowdedScore: 1 } }, safe: "C", safeScore: 2 },
  },
  {
    id: "expedition-coalition", kicker: "角色协作", title: "探险队中，你担任指挥、队员还是观察员？",
    description: "任务成功条件：恰好 1 名指挥，且队员不少于玩家总数的一半（向上取整）。",
    options: [o("A", "指挥", "成功得 7 分，失败得 0 分"), o("B", "队员", "成功得 4 分，失败得 1 分"), o("C", "观察员", "固定获得 2 分")],
    aiChoices: ai("C", "A", "B", "A"),
    rule: { type: "role-coalition", leader: "A", supporter: "B", observer: "C", supporterRatio: 0.5, leaderSuccess: 7, leaderFail: 0, supporterSuccess: 4, supporterFail: 1, observerScore: 2 },
  },
  {
    id: "bank-run", kicker: "挤兑博弈", title: "危机传闻出现时，你选择持有存款还是立即取出？",
    description: "取款人数不超过玩家总数的 30%（向下取整）时银行稳定；人数较少时允许取款人数可能为 0。",
    options: [o("A", "持有", "银行稳定得 6 分，否则 0 分"), o("B", "取出", "固定获得 2 分")],
    aiChoices: ai("B", "A", "A", "B"), rule: { type: "bank-run", withdraw: "B", hold: "A", safeRatio: 0.3, allowZeroLimit: true, withdrawSafe: 2, withdrawRun: 2, holdSafe: 6, holdRun: 0 },
  },
  {
    id: "deadline-hybrid", kicker: "期限博弈", title: "你选择提前交付、按期协作，还是最后冲刺？",
    description: "三种策略分别对应固定收益、群体阈值和唯一冒险。",
    options: [o("A", "提前交付", "固定获得 2 分"), o("B", "按期协作", "至少一半玩家选择时得 5 分，否则 1 分"), o("C", "最后冲刺", "只有 1 人选择时得 7 分，否则 0 分")],
    aiChoices: ai("A", "C", "B", "C"),
    rule: { type: "hybrid", fixed: "A", threshold: "B", unique: "C", fixedScore: 2, thresholdRatio: 0.5, thresholdSuccess: 5, thresholdFail: 1, uniqueSuccess: 7, uniqueFail: 0 },
  },
];

module.exports = { questionBank };
