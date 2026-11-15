const { PlantPhase } = require('../config/config');
const { getCapitalMode } = require('../models/store');
const { getServerTimeSec, log, toNum, toTimeSec } = require('../utils/utils');
const { createScheduler } = require('./scheduler');
const { deployDog, getPetOverview, withdrawDog, withPetCommand } = require('./pets');

const scheduler = createScheduler('capital-mode');
const state = { phase: 'idle', autoDogId: 0, lastAttemptAt: 0, generation: 0 };

function findNearestMatureSeconds(lands, analysis) {
  if (analysis && Array.isArray(analysis.harvestable) && analysis.harvestable.length) return 0;
  const now = getServerTimeSec();
  let nearest = Infinity;
  for (const land of Array.isArray(lands) ? lands : []) {
    const phases = Array.isArray(land && land.plant && land.plant.phases) ? land.plant.phases : [];
    const mature = phases.find(phase => toNum(phase && phase.phase) === PlantPhase.MATURE);
    const at = toTimeSec(mature && mature.begin_time);
    if (at > now) nearest = Math.min(nearest, at - now);
  }
  return Number.isFinite(nearest) ? nearest : null;
}

function clearOwnership(generation = state.generation) {
  if (generation !== state.generation) return;
  scheduler.clear('withdraw_after_harvest');
  scheduler.clear('withdraw_safety');
  state.phase = 'idle';
  state.autoDogId = 0;
}

function releaseForManualCommand() {
  state.generation += 1;
  clearOwnership();
}

async function withdrawOwnedDog(generation, dogId) {
  if (generation !== state.generation || !dogId || state.autoDogId !== dogId || state.phase !== 'deployed') return false;
  state.phase = 'withdrawing';
  try {
    return await withPetCommand(async (lease) => {
      const overview = await getPetOverview({ lease });
      lease.assertCurrent();
      if (overview.deployedId !== dogId) return false;
      const result = await withdrawDog({ lease, source: 'capital', expectedDogId: dogId });
      lease.assertCurrent();
      if (result.withdrawn === true) log('宠物', '资本模式已召回宠物', { module: 'pet', event: '资本模式召回', result: 'ok', dogId });
      return result.withdrawn === true;
    }, { source: 'capital', validate: () => generation === state.generation && state.autoDogId === dogId });
  } catch (error) {
    if (error.code !== 'PET_COMMAND_CANCELLED') log('宠物', `资本模式召回失败: ${error.message}`, { module: 'pet', event: '资本模式召回', result: 'error', dogId, outcome: error.outcome, errorCode: error.errorCode, sent: error.sent, resultState: error.resultState, outcomeUnknown: error.outcomeUnknown });
    if (error.outcome === 'unknown' && error.code !== 'PET_COMMAND_CANCELLED') throw error;
    return false;
  } finally { clearOwnership(generation); }
}

async function prepareForFarmOperation({ lands, analysis, opType }) {
  if (opType !== 'all' && opType !== 'harvest') return false;
  const config = getCapitalMode();
  if (!config.enabled || !config.dogId || state.phase !== 'idle') return false;
  const matureIn = findNearestMatureSeconds(lands, analysis);
  if (matureIn === null || matureIn > config.leadSeconds || Date.now() - state.lastAttemptAt < 5000) return false;
  state.lastAttemptAt = Date.now();
  state.phase = 'deploying';
  const generation = state.generation;
  const dogId = Number(config.dogId);
  const validate = () => {
    const latest = getCapitalMode();
    return generation === state.generation && latest.enabled === true && Number(latest.dogId) === dogId;
  };
  try {
    const deployed = await withPetCommand(async (lease) => {
      const overview = await getPetOverview({ lease });
      lease.assertCurrent();
      if (overview.deployedId) return false;
      const dog = overview.dogs.find(item => item.id === dogId && item.owned === true && item.activated === true);
      if (!dog) return false;
      const result = await deployDog(dogId, { lease, source: 'capital', onlyIfUndeployed: true });
      lease.assertCurrent();
      if (result.deployed !== true) return false;
      state.autoDogId = dogId;
      state.phase = 'deployed';
      scheduler.setTimeoutTask('withdraw_safety', 120000, () => withdrawOwnedDog(generation, dogId));
      log('宠物', `资本模式已派出${dog.name}`, { module: 'pet', event: '资本模式派出', result: 'ok', matureIn });
      return true;
    }, { source: 'capital', validate });
    if (!deployed) clearOwnership(generation);
    return deployed;
  } catch (error) {
    clearOwnership(generation);
    if (error.code !== 'PET_COMMAND_CANCELLED') log('宠物', `资本模式派出失败: ${error.message}`, { module: 'pet', event: '资本模式派出', result: 'error', outcome: error.outcome, errorCode: error.errorCode, sent: error.sent, resultState: error.resultState, outcomeUnknown: error.outcomeUnknown });
    // 已发送派出即使晚到也不能恢复所有权或补发召回，手动命令可能已接管。
    if (error.outcome === 'unknown' && error.code !== 'PET_COMMAND_CANCELLED') throw error;
    return false;
  }
}

function handleFarmHarvested() {
  if (!state.autoDogId || state.phase !== 'deployed') return;
  const generation = state.generation;
  const dogId = state.autoDogId;
  scheduler.setTimeoutTask('withdraw_after_harvest', 5000, () => withdrawOwnedDog(generation, dogId));
}

async function reconcileConfigChange(previous, next) {
  if (next.enabled === true && Number(next.dogId) === Number(previous?.dogId) && previous?.enabled === true) return;
  const dogId = state.autoDogId;
  const owned = state.phase === 'deployed';
  releaseForManualCommand();
  if (!owned || !dogId) return;
  const generation = state.generation;
  state.autoDogId = dogId;
  state.phase = 'deployed';
  await withdrawOwnedDog(generation, dogId);
}

module.exports = { findNearestMatureSeconds, prepareForFarmOperation, handleFarmHarvested, reconcileConfigChange, releaseForManualCommand, _state: state };
