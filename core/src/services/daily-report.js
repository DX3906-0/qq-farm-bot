const { getYesterdayStats } = require('./stats');
const { pushAlertMessage } = require('./friend-alert');
const {
  getRainPoemActivity,
  getQixiEndedState,
  getHeluActivity,
  getStarActivity,
  getWishSignActivity,
  getShareRewardActivity,
  getMilkTeaActivity,
} = require('./activity');

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('zh-CN');
}

function buildContent(yesterday, connected) {
  if (!yesterday || !yesterday.operations) {
    return '昨日暂无统计数据（账号可能未运行或刚启用日报）。';
  }
  const ops = yesterday.operations || {};
  const init = yesterday.initialState || {};
  const fin = yesterday.finalState || {};
  const num = (v) => Number(v) || 0;
  const lines = [];

  lines.push(`🌾 收割 ${num(ops.harvest)} · 种植 ${num(ops.plant)} · 偷菜 ${num(ops.steal)}`);
  lines.push(`💧 浇水 ${num(ops.water)} · 除草 ${num(ops.weed)} · 抓虫 ${num(ops.bug)}`);
  lines.push(`🤝 帮浇 ${num(ops.helpWater)} · 帮草 ${num(ops.helpWeed)} · 帮虫 ${num(ops.helpBug)} · 任务 ${num(ops.taskClaim)}`);
  lines.push(`🐛 放虫 ${num(ops.putBug)} · 放草 ${num(ops.putWeed)} · 售出 ${num(ops.sell)} · 神秘商人 ${num(yesterday.mysteryMerchantCount || ops.mysteryMerchant || 0)}`);

  const goldGain = (fin.gold != null && init.gold != null) ? (Number(fin.gold) - Number(init.gold)) : null;
  const expGain = (fin.exp != null && init.exp != null) ? (Number(fin.exp) - Number(init.exp)) : null;
  const couponGain = (fin.coupon != null && init.coupon != null) ? (Number(fin.coupon) - Number(init.coupon)) : null;
  const parts = [];
  if (goldGain != null) parts.push(`金币 ${goldGain >= 0 ? '+' : ''}${fmtNum(goldGain)}`);
  if (expGain != null) parts.push(`经验 ${expGain >= 0 ? '+' : ''}${fmtNum(expGain)}`);
  if (couponGain != null) parts.push(`点券 ${couponGain >= 0 ? '+' : ''}${fmtNum(couponGain)}`);
  lines.push(`📈 ${parts.length ? parts.join(' · ') : '收益数据不足'}`);

  lines.push(`🔌 当前状态：${connected ? '在线' : '离线'}`);
  return lines.join('\n');
}

/**
 * 活动完成度：**逐个活动真实探测**，只渲染当前仍在有效期内的活动。
 *
 * 设计要点（避免历史上「天天推已过期活动」的根因）：
 * - 不再依赖 `ActivityService.List`（发现列表）。实测该接口对多数活动返回空数组，
 *   用「列表里有没有」来判断在期会导致把真正的在期活动全部误杀（漏报）。
 * - 改为对每个已知活动调用其自身的详情接口，以接口返回的 `active` / `warning` /
 *   服务端下发节点（如 helu 的 `draw.dailyMax`、wish 的 `wish_sign` 节点）作为**唯一真值**：
 *   拿不到数据 → 视为不在期，直接不渲染（过期活动自然消失）；
 *   拿到数据 → 渲染进度（在期活动不丢）。
 */
async function getActivityLines() {
  const lines = [];
  const debug = [];

  // ── 1) 荷风十里蝉初鸣（服务端未下发该活动时 getHeluActivity 不会返回 draw 明细）──
  // ⚠️ 判活必须用 draw.hasServerData，**不能**用 dailyMax>0：
  // 活动没下发时 normalizeDrawInfo({}) 会兜底造出 dailyMax=8/dailyRemaining=8，
  // 用 dailyMax 判会让已下架的活动天天出现在日报里（2026-10-22 用户实测）。
  try {
    const helu = await getHeluActivity();
    const draw = helu && helu.draw;
    const heluAlive = !!(draw && draw.hasServerData);
    if (heluAlive) {
      const parts = [`🪷 ${helu.title || '荷风十里蝉初鸣'}`];
      if (draw.dailyRemaining != null) parts.push(`抽奖 剩余${draw.dailyRemaining}/${draw.dailyMax}`);
      if (helu.passport && helu.passport.currentLevel != null) parts.push(`游记 Lv${helu.passport.currentLevel}`);
      if (helu.solarTerms && helu.solarTerms.claimableCount) parts.push(`节气可领 ${helu.solarTerms.claimableCount}`);
      if (helu.heluBalance != null) parts.push(`荷露 ${helu.heluBalance}`);
      lines.push(parts.join(' · '));
    }
    debug.push(`helu=${heluAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`helu=err(${e.message})`); }

  // ── 2) 心许千灯星垂野（活动下架时服务端返回 warning）──
  try {
    const star = await getStarActivity();
    const starAlive = !!star && !star.warning;
    if (starAlive) {
      const rec = star.starRecord || {};
      const parts = [`🏮 ${star.title || '心许千灯星垂野'}`];
      if (rec.openedDays != null) parts.push(`点亮 ${rec.openedDays} 天`);
      if (rec.claimableCount) parts.push(`可领 ${rec.claimableCount}`);
      if (star.starSandBalance != null) parts.push(`星砂 ${star.starSandBalance}`);
      lines.push(parts.join(' · '));
    }
    debug.push(`star=${starAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`star=err(${e.message})`); }

  // ── 3) 雨落成诗（active 由服务端 start/end + visible 计算）──
  try {
    const rain = await getRainPoemActivity();
    const rainAlive = !!(rain && rain.active);
    if (rainAlive) {
      const lh = rain.lightningHarvest || {};
      const parts = [`🌧️ 雨落成诗`];
      if (lh.target > 0) parts.push(`雷电变异 ${lh.progress}/${lh.target}${lh.complete ? ' ✓' : ''}`);
      if (rain.summon) parts.push(`召唤 ${rain.summon.usedToday || 0}/${rain.summon.dailyUseLimit || 50}`);
      if (rain.collection) parts.push(`采集瓶 ${rain.collection.remainingUseCount}/${rain.collection.dailyUseLimit}`);
      if (rain.items && rain.items.badges != null) parts.push(`徽章 ${rain.items.badges}`);
      lines.push(parts.join(' · '));
      if (rain.research && Array.isArray(rain.research.stages) && rain.research.stages.length) {
        const stages = rain.research.stages;
        const completed = stages.filter(s => s.completed);
        const avail = stages.filter(s => s.available);
        const curStage = rain.research.currentStage || completed.length;
        const rewardName = (r) => (r && r.itemName) ? `${r.itemName}${r.count ? '×' + r.count : ''}` : '';
        const completedRewards = completed.map(s => {
          const rw = rewardName(s.reward);
          return rw ? `阶段${s.id}:${rw}` : `阶段${s.id}`;
        });
        let researchLine = `   🔬 研究 阶段${curStage}/${stages.length}`;
        if (completedRewards.length) researchLine += ` · 已解锁:${completedRewards.join('、')}`;
        if (avail.length) {
          const nx = avail[0];
          researchLine += ` · 可解锁阶段${nx.id}:${rewardName(nx.reward) || '?'}${nx.repeatable ? '(可重复)' : ''}`;
        }
        lines.push(researchLine);
      }
      if (rain.weather && rain.weather.rainstorm) lines.push('   ⛈️ 雷雨进行中');
    }
    debug.push(`rain=${rainAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`rain=err(${e.message})`); }

  // ── 4) 鹊桥寄情（结束态按天缓存，ended 为真则隐藏）──
  try {
    const qixiState = await getQixiEndedState();
    const qixi = qixiState && qixiState.activity;
    const qixiAlive = !!(qixi && qixi.bridge && !qixiState.ended);
    if (qixiAlive) {
      const built = qixi.bridge.completedCount || 0;
      const total = Array.isArray(qixi.bridge.stages) ? qixi.bridge.stages.length : 0;
      lines.push(`🌉 鹊桥构建 ${built}/${total}${(qixi.bridge.lastBuiltStageId) ? ` (阶段${qixi.bridge.lastBuiltStageId})` : ''}`);
    }
    debug.push(`qixi=${qixiAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`qixi=err(${e.message})`); }

  // ── 5) 秋祈良愿（active 由配置时间窗计算，且需服务端下发 wish_sign 节点）──
  try {
    const wish = await getWishSignActivity();
    const wishAlive = !!(wish && wish.active);
    if (wishAlive) {
      const parts = [`🌕 秋祈良愿`];
      if (wish.activityDay != null) parts.push(`第 ${wish.activityDay} 天`);
      if (wish.remainingCount != null) parts.push(`剩余 ${wish.remainingCount} 次`);
      if (wish.pending) parts.push('有可领取');
      lines.push(parts.join(' · '));
    }
    debug.push(`wish=${wishAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`wish=err(${e.message})`); }

  // ── 6) 快乐不独享（服务端未下发 share_reward 时抛错，按不在期处理）──
  try {
    const share = await getShareRewardActivity();
    const shareAlive = !!(share && share.active);
    if (shareAlive) {
      const d = share.daily || {};
      const parts = [`🎁 快乐不独享`];
      if (d.claimedCount != null) parts.push(`今日 ${d.claimedCount}/${d.claimLimit || 0}`);
      if (share.currentScore != null) parts.push(`积分 ${share.currentScore}`);
      const claimable = (share.milestones || []).filter(m => m.state === 1).length;
      if (claimable) parts.push(`里程碑可领 ${claimable}`);
      lines.push(parts.join(' · '));
    }
    debug.push(`share=${shareAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`share=out(${e.message})`); }

  // ── 7) 奶茶热销中（S4 店铺经营）：active 由服务端 begin/end 计算，未上线返回 phase='ended' ──
  try {
    const tea = await getMilkTeaActivity();
    // phase: upcoming/business/settling/ended；只有真在期（business/settling）才渲染
    const teaAlive = !!tea && (tea.phase === 'business' || tea.phase === 'settling');
    if (teaAlive) {
      const s = tea.summary || {};
      const phaseLabel = tea.phase === 'settling' ? '结算期' : '经营期';
      const parts = [`🧋 ${tea.title || '奶茶热销中'} · ${phaseLabel}`];
      if (s.level > 0) parts.push(`店铺 Lv${s.level}`);
      if (s.totalRevenue > 0) parts.push(`累计营收 ${fmtNum(s.totalRevenue)}`);
      lines.push(parts.join(' · '));

      // 第二行：待处理事项 + 持有货币，让日报能直接看出"还有什么没做"
      const todos = [];
      if (s.canUpgrade) todos.push('可升级');
      if (s.hasUnclaimedWage) todos.push('工资待领');
      if (s.cashierFull) todos.push('收银台已满');
      const bal = tea.balances || {};
      const info = [];
      if (bal.milkTeaToken != null) info.push(`奶茶券 ${fmtNum(bal.milkTeaToken)}`);
      if (tea.fund && Array.isArray(tea.fund.tiers)) {
        const claimable = tea.fund.tiers.filter(t => t.state === 2).length;
        if (claimable > 0) info.push(`基金可领 ${claimable} 档`);
      }
      if (tea.share && tea.share.currentScore != null) {
        info.push(`分享积分 ${fmtNum(tea.share.currentScore)}`);
      }
      if (todos.length || info.length) {
        const segs = [];
        if (todos.length) segs.push(`待处理:${todos.join('/')}`);
        if (info.length) segs.push(info.join(' · '));
        lines.push(`   ${segs.join(' | ')}`);
      }
    }
    debug.push(`milkTea=${teaAlive ? 'in' : 'out'}`);
  } catch (e) { debug.push(`milkTea=err(${e.message})`); }

  // 全部不在期：明确告知，避免用户以为日报漏了活动
  if (lines.length === 0) {
    lines.push('当前无进行中的活动');
  }

  return lines;
}

/**
 * 生成并推送昨日日报
 * @param {{accountId:string, accountName:string, connected:boolean}} param0
 */
async function sendDailyReport({ accountId, accountName, connected }) {
  const yesterday = getYesterdayStats(accountId);
  const dateLabel = yesterday ? yesterday.date : '';
  const title = `📊 农场日报 · ${accountName || '账号'}${dateLabel ? ' · ' + dateLabel : ''}`;
  const lines = [buildContent(yesterday, connected)];
  try {
    const activityLines = await getActivityLines();
    if (activityLines.length) lines.push('', '🎪 活动进度', ...activityLines);
  } catch (e) { /* 忽略 */ }
  return pushAlertMessage(title, lines.join('\n'));
}

module.exports = { sendDailyReport, buildContent, getActivityLines };
