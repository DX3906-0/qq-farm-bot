const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, logWarn, toNum } = require('../utils/utils');
const { getBag, getBagItems } = require('./warehouse');
const { getDogInfo, decodeDogReply } = require('./dog-skill-gifts');

const PET_IDS = [90001, 90002, 90003, 90011, 90021, 90031];
const BICHON_DOG_ID = 90031;
const FOOD_DURATIONS = new Map([[90004, 86400], [90005, 259200], [90006, 432000]]);
const MAX_PROTECT_SECONDS = 30 * 86400;
const { AsyncLocalStorage } = require('node:async_hooks');
const commandContext = new AsyncLocalStorage();
const leases = new WeakMap();
const MAX_PET_COMMANDS = 32;
const PET_COMMAND_TIMEOUT_MS = 30000;
const commandQueue = [];
let activeCommand = null;

function annotateCommandError(entry, error) {
  const sent = typeof error.sent === 'boolean' ? error.sent : entry.writes > 0;
  const resultState = error.resultState || (sent ? entry.resultState || 'unknown' : 'not_sent');
  return Object.assign(error, {
    errorCode: error.errorCode ?? error.code ?? 'PET_COMMAND_FAILED',
    sent, resultState, outcomeUnknown: resultState === 'unknown',
    code: error.code ?? error.errorCode ?? 'PET_COMMAND_FAILED',
    source: entry.source, writeSent: sent, outcome: resultState,
    retryable: false, method: error.method || entry.method || null,
  });
}

function commandError(entry, code, message) {
  return annotateCommandError(entry, Object.assign(new Error(message), { code }));
}

function assertLease(lease) {
  const entry = lease && leases.get(lease);
  if (!entry || entry !== activeCommand || entry.finished || entry.operationFinished) throw new Error('无效或已释放的宠物事务 lease');
  if (entry.expired || Date.now() >= entry.deadline) throw commandError(entry, 'PET_COMMAND_TIMEOUT', '宠物命令已超时，不能继续写入');
  if (entry.validate && entry.validate() !== true) throw commandError(entry, 'PET_COMMAND_CANCELLED', '宠物命令所有权已失效');
  return entry;
}

function finishCommand(entry) {
  if (entry.finished || entry.pendingWrites > 0 || entry.pendingReads > 0 || (entry.started && !entry.operationFinished)) return;
  entry.finished = true;
  clearTimeout(entry.timer);
  if (activeCommand === entry) activeCommand = null;
  pumpCommands();
}

function pumpCommands() {
  if (activeCommand) return;
  const entry = commandQueue.shift();
  if (!entry) return;
  activeCommand = entry;
  entry.started = true;
  commandContext.run(entry.lease, async () => {
    try {
      assertLease(entry.lease);
      const result = await entry.operation(entry.lease);
      if (!entry.expired) entry.resolve(result);
    } catch (error) {
      const failure = annotateCommandError(entry, error);
      if (entry.expired && entry.writes > 0 && failure.outcomeUnknown) logWarn('宠物', '超时宠物写入结算未确认', {
        module: 'pet', event: '宠物命令结算', result: 'error', source: entry.source, method: failure.method,
        errorCode: failure.errorCode, sent: failure.sent, resultState: failure.resultState, outcomeUnknown: failure.outcomeUnknown,
      });
      entry.reject(failure);
    } finally { entry.operationFinished = true; finishCommand(entry); }
  });
}

function withPetCommand(operation, options = {}) {
  const inherited = options.lease || commandContext.getStore();
  if (inherited) {
    try { assertLease(inherited); return Promise.resolve(operation(inherited)); }
    catch (error) { return Promise.reject(error); }
  }
  const source = options.source || 'manual';
  // 手动抢占在任何 await/入队之前使旧资本模式 generation 失效。
  if (source === 'manual') require('./capital-mode').releaseForManualCommand();
  const entry = { operation, source, validate: options.validate, writes: 0, pendingWrites: 0, pendingReads: 0, expired: false, finished: false };
  if (commandQueue.length + (activeCommand ? 1 : 0) >= MAX_PET_COMMANDS) {
    return Promise.reject(commandError(entry, 'PET_COMMAND_QUEUE_FULL', '宠物命令队列已满'));
  }
  const timeoutMs = Math.max(1, Math.min(PET_COMMAND_TIMEOUT_MS, Number(options.timeoutMs) || PET_COMMAND_TIMEOUT_MS));
  entry.deadline = Date.now() + timeoutMs;
  const lease = Object.freeze({
    assertCurrent() { assertLease(lease); },
    async read(operation) {
      assertLease(lease);
      entry.pendingReads += 1;
      try {
        const result = await operation();
        assertLease(lease);
        return result;
      } finally {
        entry.pendingReads -= 1;
        if (entry.operationFinished) finishCommand(entry);
      }
    },
    async write(service, method, payload, settle) {
      assertLease(lease);
      entry.writes += 1;
      entry.pendingWrites += 1;
      entry.method = method;
      entry.resultState = 'unknown';
      try {
        const reply = await sendMsgAsync(service, method, payload);
        // 已发送 RPC 的晚回包仍须解码/确认；deadline 只阻止下一步读写和所有权恢复。
        return settle ? await settle(reply) : reply;
      } finally {
        entry.pendingWrites -= 1;
        // operation 的读与回包后处理也属于事务，不能在这里提前释放锁。
        if (entry.operationFinished) finishCommand(entry);
      }
    },
    confirm(resultState = 'completed') {
      if (leases.get(lease) !== activeCommand || entry.finished) throw new Error('无效或已释放的宠物事务 lease');
      entry.resultState = resultState;
      return {
        source: entry.source, method: entry.method, sent: true, resultState, outcomeUnknown: false,
        late: entry.expired || Date.now() >= entry.deadline,
        ownershipValid: !entry.expired && Date.now() < entry.deadline && (!entry.validate || entry.validate() === true),
      };
    },
  });
  entry.lease = lease;
  leases.set(lease, entry);
  return new Promise((resolve, reject) => {
    Object.assign(entry, { resolve, reject });
    entry.timer = setTimeout(() => {
      entry.expired = true;
      const index = commandQueue.indexOf(entry);
      if (index >= 0) commandQueue.splice(index, 1);
      reject(commandError(entry, 'PET_COMMAND_TIMEOUT', '宠物命令超时；已发送写入的结果未知，禁止重试'));
      finishCommand(entry);
    }, timeoutMs);
    commandQueue.push(entry);
    pumpCommands();
  });
}

function num(value) { return Math.max(0, toNum(value)); }
function validNumber(value) {
  if (value == null || typeof value === 'boolean') return false;
  const number = typeof value?.toNumber === 'function' ? value.toNumber()
    : typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0;
}
function metadata(id) {
  const item = getItemById(id) || {};
  return { id, name: String(item.name || `宠物#${id}`), desc: String(item.desc || ''), rarity: num(item.rarity), image: getItemImageById(id) };
}

function flag(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string'
    && !(typeof value === 'object' && (typeof value.toNumber === 'function' || ('low' in value && 'high' in value)))) return null;
  if (typeof value === 'string' && !/^[01]$/.test(value.trim())) return null;
  const number = typeof value === 'string' ? Number(value) : toNum(value);
  return number === 1 ? true : number === 0 ? false : null;
}

function field(reply, snake, camel = snake) {
  if (Object.prototype.hasOwnProperty.call(reply || {}, snake)) return reply[snake];
  if (Object.prototype.hasOwnProperty.call(reply || {}, camel)) return reply[camel];
  // protobufjs 的实例继承原型 $type 与缺省 0/false；普通对象不能借此补状态。
  const type = reply?.$type;
  if (type && typeof type.ctor === 'function' && reply instanceof type.ctor) {
    if (type.fields[snake]) return reply[snake];
    if (type.fields[camel]) return reply[camel];
  }
  return undefined;
}

function getDogActivationState(dogInfo, dogIdInput) {
  const dogId = num(dogIdInput);
  const dog = (dogInfo?.dog_list ?? dogInfo?.dogList ?? []).find(item => num(item.id) === dogId);
  const cardOwned = flag(field(dog, 'owned'));
  const activated = flag(field(dog, 'activated'));
  // 官方 Ready 依据 activated；owned 是待激活卡。已激活后卡标记可为 false。
  const owned = cardOwned === true || activated === true ? true
    : cardOwned === false && activated === false ? false : null;
  return { dog, owned, cardOwned, activated, activatable: cardOwned === true && activated === false };
}

function buildPetSnapshot(reply, bagReply = {}) {
  if (!reply || reply.error || reply.ok === false) throw new Error(reply?.error || '宠物响应异常');
  const rawDogs = reply.dog_list ?? reply.dogList;
  if (!Array.isArray(rawDogs) || rawDogs.some(dog => !dog || num(dog.id) <= 0)) {
    throw new Error('宠物响应缺少有效 dog_list，无法确认拥有状态');
  }
  if (!rawDogs.length) throw new Error('宠物响应返回空 dog_list，拥有状态尚未确认');
  const currentId = field(reply, 'current_deployed_dog_id', 'currentDeployedDogId');
  const currentDogId = validNumber(currentId) ? num(currentId) : null;
  if (currentDogId && !rawDogs.some(dog => num(dog.id) === currentDogId)) throw new Error('派出宠物不在响应列表中，状态不一致');
  const byId = new Map(rawDogs.map(dog => [num(dog.id), dog]));
  const ids = [...PET_IDS, ...rawDogs.map(dog => num(dog.id)).filter(id => !PET_IDS.includes(id))];
  const usages = reply.skill_use_infos ?? reply.skillUseInfos ?? [];
  if (!Array.isArray(usages)) throw new Error('宠物技能响应格式异常');
  const dogs = [...new Set(ids)].map((id) => {
    const raw = byId.get(id) || {};
    const { owned, cardOwned, activated, activatable } = getDogActivationState(reply, id);
    if (id === currentDogId && activated !== true) {
      throw new Error('宠物拥有、激活与派出状态不一致');
    }
    const skillUsage = usages.filter(item => num(item.dog_id ?? item.dogId) === id).map(item => ({
      skillId: num(item.skill_id ?? item.skillId), usedCount: num(item.daily_trigger_count ?? item.dailyTriggerCount), dailyLimit: num(item.max_trigger_daily ?? item.maxTriggerDaily)
    }));
    return { ...metadata(id), price: num(raw.price), owned, cardOwned, activated, activatable, deployed: currentDogId === null ? null : id === currentDogId, skillUsage };
  });
  if (dogs.every(dog => dog.owned === null)) throw new Error('宠物响应缺少拥有状态，无法确认是否拥有');
  const foodCounts = new Map();
  for (const item of getBagItems(bagReply)) {
    const id = num(item && item.id);
    if (FOOD_DURATIONS.has(id) && item.locked !== true && item.locked !== 1) foodCounts.set(id, (foodCounts.get(id) || 0) + num(item.count));
  }
  const foods = [...FOOD_DURATIONS].map(([id, duration]) => ({ ...metadata(id), duration, days: duration / 86400, count: foodCounts.get(id) || 0 }));
  const foodSeconds = field(reply, 'food_last_sec', 'foodLastSec');
  const maxFoodSeconds = field(reply, 'max_food_last_sec', 'maxFoodLastSec');
  if (currentDogId === null || !validNumber(foodSeconds) || !validNumber(maxFoodSeconds) || num(maxFoodSeconds) <= 0) {
    throw new Error('宠物响应缺少派出或守护时长字段，请刷新重试');
  }
  const warnings = dogs.some(dog => dog.owned === null || dog.activated === null)
    ? ['部分宠物状态未返回，未知状态不代表尚未拥有或可激活'] : [];
  return { dogs, foods, deployedId: currentDogId, foodSeconds: num(foodSeconds), protectSeconds: Math.min(MAX_PROTECT_SECONDS, num(maxFoodSeconds)), pendingGiftCount: num(reply.pending_gift_count ?? reply.pendingGiftCount), warnings };
}

async function getPetOverview(options = {}) {
  const lease = options.lease || commandContext.getStore();
  if (lease) assertLease(lease);
  try {
    const [reply, bag] = await Promise.all(lease ? [lease.read(getDogInfo), lease.read(getBag)] : [getDogInfo(), getBag()]);
    if (lease) assertLease(lease);
    const snapshot = buildPetSnapshot(reply, bag);
    if (snapshot.warnings.length) logWarn('宠物', snapshot.warnings.join('；'), { module: 'pet', event: '宠物状态', result: 'warn' });
    return snapshot;
  } catch (error) {
    logWarn('宠物', `获取宠物概览失败: ${error.message}`, { module: 'pet', event: '宠物状态', result: 'error' });
    throw error;
  }
}

async function activateDog(dogIdInput, options = {}) {
  const dogId = num(dogIdInput);
  if (!dogId) throw new Error('请选择要激活的宠物');
  return withPetCommand(async (lease) => {
    const [dogInfo, bagReply] = await Promise.all([lease.read(getDogInfo), lease.read(getBag)]);
    const before = getDogActivationState(dogInfo, dogId);
    if (before.activated === true) return { ok: true, activated: false, reason: 'already_activated', dogId };
    if (before.owned === null || before.activated === null) throw new Error('宠物拥有或激活状态未知，不能执行激活');
    const hasUnlockedCard = getBagItems(bagReply).some(item => num(item?.id) === dogId
      && item?.locked !== true && item?.locked !== 1 && num(item?.count) > 0);
    if (!before.activatable && !hasUnlockedCard) throw new Error('背包中没有可用的宠物卡');

    const payload = types.ActivateDogRequest.encode(types.ActivateDogRequest.create({ dog_id: dogId })).finish();
    return lease.write('gamepb.dogpb.DogService', 'ActivateDog', payload, response => {
      const reply = decodeDogReply(types.ActivateDogReply, response);
      if (num(reply?.dog?.id) !== dogId || flag(field(reply.dog, 'activated')) !== true) {
        throw new Error('宠物激活响应未确认激活状态');
      }
      const completion = lease.confirm();
      log('宠物', `已激活${metadata(dogId).name}`, { module: 'pet', event: '激活宠物', result: 'ok', dogId, ...completion });
      return { ok: true, activated: true, dogId };
    });
  }, options);
}

async function activateBichonIfEligible(activityPet) {
  if (activityPet?.nurture?.adult !== true || activityPet?.nurture?.dogGranted !== true) {
    return { ok: true, activated: false, reason: 'activity_reward_not_ready', dogId: BICHON_DOG_ID };
  }
  return activateDog(BICHON_DOG_ID);
}

async function deployDog(dogIdInput, options = {}) {
  const dogId = num(dogIdInput);
  if (!dogId) throw new Error('请选择要派出的宠物');
  return withPetCommand(async (lease) => {
    const info = await lease.read(getDogInfo);
    const state = getDogActivationState(info, dogId);
    if (state.owned === null || state.activated === null) throw new Error('宠物拥有或激活状态未知，不能派出');
    if (state.owned !== true) throw new Error('尚未拥有该宠物');
    if (state.activated !== true) throw new Error('该宠物尚未激活');
    const currentId = field(info, 'current_deployed_dog_id', 'currentDeployedDogId');
    if (!validNumber(currentId)) throw new Error('派出状态未知，不能派出');
    if (num(currentId) === dogId) return { ok: true, deployed: false, reason: 'already_deployed', dogId };
    if (options.onlyIfUndeployed === true && num(currentId) !== 0) return { skipped: true, reason: 'already_deployed' };
    const payload = types.DeployDogRequest.encode(types.DeployDogRequest.create({ dog_id: dogId })).finish();
    return lease.write('gamepb.dogpb.DogService', 'DeployDog', payload, response => {
      const reply = decodeDogReply(types.DeployDogReply, response);
      if (num(field(reply, 'dog_id', 'dogId')) !== dogId) throw new Error('派出响应未确认目标宠物');
      const completion = lease.confirm();
      log('宠物', `已派出${metadata(dogId).name}`, { module: 'pet', event: '派出宠物', result: 'ok', dogId, ...completion });
      return { ok: true, deployed: true, dogId };
    });
  }, options);
}

async function withdrawDog(options = {}) {
  return withPetCommand(async (lease) => {
    const info = await lease.read(getDogInfo);
    const currentId = field(info, 'current_deployed_dog_id', 'currentDeployedDogId');
    if (!validNumber(currentId)) throw new Error('派出状态未知，不能召回');
    const dogId = num(currentId);
    if (!dogId) return { ok: true, withdrawn: false, reason: 'not_deployed' };
    if (options.expectedDogId && dogId !== Number(options.expectedDogId)) return { skipped: true, reason: 'deployment_changed' };
    if (getDogActivationState(info, dogId).activated !== true) throw new Error('派出宠物状态未知，不能召回');
    const payload = types.WithdrawDogRequest.encode(types.WithdrawDogRequest.create({})).finish();
    return lease.write('gamepb.dogpb.DogService', 'WithdrawDog', payload, response => {
      const reply = decodeDogReply(types.WithdrawDogReply, response);
      const confirmedId = field(reply, 'dog_id', 'dogId');
      if (!validNumber(confirmedId) || (num(confirmedId) !== 0 && num(confirmedId) !== dogId)) throw new Error('召回响应未确认宠物');
      const completion = lease.confirm();
      log('宠物', '已召回宠物', { module: 'pet', event: '召回宠物', result: 'ok', dogId, ...completion });
      return { ok: true, withdrawn: true, dogId };
    });
  }, options);
}

async function feedDog(foodIdInput, countInput = 1, options = {}) {
  const foodId = num(foodIdInput);
  const count = Math.max(1, Math.min(99, Math.trunc(num(countInput) || 1)));
  const duration = FOOD_DURATIONS.get(foodId);
  if (!duration) throw new Error('无效的狗粮');
  return withPetCommand(async (lease) => {
    const [info, bag] = await Promise.all([lease.read(getDogInfo), lease.read(getBag)]);
    const available = getBagItems(bag).filter(item => num(item.id) === foodId && item.locked !== true && item.locked !== 1).reduce((sum, item) => sum + num(item.count), 0);
    if (available < count) return { skipped: true, reason: 'insufficient_food', available };
    const snapshot = buildPetSnapshot(info, bag);
    if (!snapshot.dogs.some(dog => dog.owned === true)) throw new Error('未确认拥有宠物，不能喂食');
    if (snapshot.foodSeconds + duration * count > snapshot.protectSeconds) throw new Error('喂食后将超过30天上限');
    if (options.validate && options.validate() !== true) return { skipped: true, reason: 'disabled' };
    const payload = types.AddFoodRequest.encode(types.AddFoodRequest.create({ item_id: foodId, count })).finish();
    return lease.write('gamepb.dogpb.DogService', 'AddFood', payload, response => {
      const reply = decodeDogReply(types.AddFoodReply, response);
      const remaining = field(reply, 'food_last_sec', 'foodLastSec');
      if (!validNumber(remaining)) throw new Error('喂食响应缺少有效守护时长');
      const completion = lease.confirm();
      log('宠物', `喂食${metadata(foodId).name} x${count}`, { module: 'pet', event: '喂食宠物', result: 'ok', foodId, count, ...completion });
      return { ok: true, foodSeconds: num(remaining) };
    });
  }, options);
}

async function getProtectLogs() {
  const payload = types.GetProtectLogsRequest.encode(types.GetProtectLogsRequest.create({ field_1: 0, count: 100, field_3: 0 })).finish();
  const reply = decodeDogReply(types.GetProtectLogsReply, await sendMsgAsync('gamepb.dogpb.DogService', 'GetProtectLogs', payload));
  const logs = (reply.logs || []).map((item, index) => ({ id: `${num(item.friend_gid)}-${num(item.timestamp)}-${index}`, friendGid: num(item.friend_gid), friendName: String(item.friend_name || ''), friendAvatar: String(item.friend_avatar || ''), timestamp: num(item.timestamp), stolenCount: num(item.stolen_count), protectedGold: num(item.protected_gold), dogId: num(item.dog_id), dogName: String(item.dog_name || '') }));
  return { logs, total: Math.max(logs.length, num(reply.total)) };
}

module.exports = { withPetCommand, MAX_PET_COMMANDS, PET_COMMAND_TIMEOUT_MS, PET_IDS, FOOD_DURATIONS, MAX_PROTECT_SECONDS, buildPetSnapshot, getDogActivationState, getPetOverview, activateDog, activateBichonIfEligible, deployDog, withdrawDog, feedDog, getProtectLogs };
