/**
 * 农场服务聚合模块（Barrel）
 * 统一导出所有子模块的公开 API
 */
const farmApi = require('./farm-api');
const { getCurrentPhase, buildLandMap, getDisplayLandContext, isOccupiedSlaveLand, getLandsDetail } = require('./farm-land-analyzer');
const { runFertilizerByConfig } = require('./farm-fertilizer');
const { getAvailableSeeds } = require('./planting-service');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, runFarmOperation, startUnifiedHarvest, cancelUnifiedHarvest, isUnifiedHarvestActive } = require('./farming-orchestrator');

module.exports = {
  // 巡田
  checkFarm,
  startFarmCheckLoop,
  stopFarmCheckLoop,
  refreshFarmCheckLoop,
  runFarmOperation,

  // 统一时间收获（一次性任务：等最后一块地成熟再统一一键收）
  startUnifiedHarvest,
  cancelUnifiedHarvest,
  isUnifiedHarvestActive,

  // 土地分析
  getCurrentPhase,
  getLandsDetail,
  buildLandMap,
  getDisplayLandContext,
  isOccupiedSlaveLand,

  // 种子/商店
  getAvailableSeeds,
  getShopInfo: farmApi.getShopInfo,
  buyGoods: farmApi.buyGoods,

  // 操作
  setOperationLimitsCallback: farmApi.setOperationLimitsCallback,
  runFertilizerByConfig,
  farming: farmApi.farming,
  NORMAL_FERTILIZER_ID: farmApi.NORMAL_FERTILIZER_ID,
  ORGANIC_FERTILIZER_ID: farmApi.ORGANIC_FERTILIZER_ID,
  fertilize: farmApi.fertilize,
  removePlant: farmApi.removePlant
};
