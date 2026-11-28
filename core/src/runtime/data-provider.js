const {
    findAccountByRef,
    normalizeAccountRef,
    resolveAccountId: resolveAccountIdByList
} = require('../services/account-resolver');
const { getSchedulerRegistrySnapshot } = require('../services/scheduler');

/**
 * 创建数据提供器 —— 封装对 Worker 的 API 调用，供 Admin Server 使用
 */
function createDataProvider(deps) {
    const {
        workers,
        globalLogs,
        accountLogs,
        store,
        getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        nextConfigRevision,
        broadcastConfigToWorkers,
        startWorker,
        stopWorker,
        restartWorker,
        scheduleAutoCodeRefresh,
        refreshAccountCode
    } = deps;

    /** 获取账号列表 */
    function getAllAccountList() {
        const data = getAccounts();
        return Array.isArray(data.accounts) ? data.accounts : [];
    }

    /** 解析账号引用（account-ref / accountId） */
    function resolveAccountId(ref) {
        const normalized = normalizeAccountRef(ref);
        if (!normalized) return '';
        const id = resolveAccountIdByList(getAllAccountList(), normalized);
        return id || normalized;
    }

    /** 根据引用查找账号 */
    function findAccount(ref) {
        return findAccountByRef(getAllAccountList(), ref);
    }

    // 超时配置
    const FRIEND_TIMEOUT = { _timeoutMs: 180000 };       // 3分钟
    // 好友土地要完成排队 + Enter + Leave；不能被默认10秒截断，也不能当普通安全读重放。
    const FRIEND_LANDS_TIMEOUT = { _timeoutMs: 90000 };
    const MYSTERY_SHOP_TIMEOUT = { _timeoutMs: 60000 };
    const SYNC_TIMEOUT = { _timeoutMs: 180000 };          // 3分钟
    const DOG_INFO_TIMEOUT = { _timeoutMs: 600000 };     // 10分钟

    return {
        /** 获取账号运行状态 */
        getStatus: (ref) => {
            const id = resolveAccountId(ref);
            if (!id) return buildDefaultStatus('');

            const worker = workers[id];
            if (!worker || !worker.status) return buildDefaultStatus(id);

            return {
                ...buildDefaultStatus(id),
                ...normalizeStatusForPanel(worker.status, id, worker.name),
                wsError: worker.wsError || null
            };
        },

        /** 获取日志 */
        getLogs: (ref, opts) => {
            const options = typeof opts === 'object' && opts ? opts : { limit: opts };
            const limit = Math.max(100, Number(options.limit) || 200);

            const normalized = normalizeAccountRef(ref);
            const id = resolveAccountId(ref);

            if (!normalized || normalized === 'all') {
                return filterLogs(globalLogs, options).slice(-limit);
            }

            if (!id) return [];

            const accountIdStr = String(id || '');
            return filterLogs(
                globalLogs.filter(e => String(e.accountId || '') === accountIdStr),
                options
            ).slice(-limit);
        },

        /** 获取账号操作日志 */
        getAccountLogs: (limit) => accountLogs.slice(-limit).reverse(),

        /** 清空日志 */
        clearLogs: (ref) => {
            const normalized = normalizeAccountRef(ref);
            const id = resolveAccountId(ref);

            if (!normalized || normalized === 'all') {
                const clearedRuntimeLogs = globalLogs.length;
                const clearedAccountLogs = accountLogs.length;
                globalLogs.length = 0;
                accountLogs.length = 0;
                return {
                    cleared: 'all',
                    clearedRuntimeLogs,
                    clearedAccountLogs
                };
            }

            const result = {
                cleared: 0,
                clearedRuntimeLogs: 0,
                clearedAccountLogs: 0
            };
            if (!id) return result;

            const idStr = String(id || '');
            const runtimeLogsBefore = globalLogs.length;
            for (let i = globalLogs.length - 1; i >= 0; i--) {
                if (String(globalLogs[i].accountId || '') === idStr) {
                    globalLogs.splice(i, 1);
                }
            }
            const accountLogsBefore = accountLogs.length;
            for (let i = accountLogs.length - 1; i >= 0; i--) {
                if (String(accountLogs[i].accountId || accountLogs[i].id || '') === idStr) {
                    accountLogs.splice(i, 1);
                }
            }

            result.clearedRuntimeLogs = runtimeLogsBefore - globalLogs.length;
            result.clearedAccountLogs = accountLogsBefore - accountLogs.length;
            result.cleared = result.clearedRuntimeLogs + result.clearedAccountLogs;
            return { ...result, accountId: id };
        },

        // ========== Farm API ==========
        getLands: (ref) => callWorkerApi(resolveAccountId(ref), 'getLands'),
        // 牧场一期只读包含保守场景切换/恢复，给完整场景事务留出结算时间。
        getRanchSceneAccessInfo: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchSceneAccessInfo', { _timeoutMs: 15000 }),
        upgradeRanchGlobalLogin: (ref, expected) => callWorkerApi(resolveAccountId(ref), 'upgradeRanchGlobalLogin', expected, { _timeoutMs: 90000 }),
        getRanchOverview: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchOverview', { _timeoutMs: 160000 }),
        getRanchFriends: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchFriends', { _timeoutMs: 160000 }),
        getRanchFriend: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getRanchFriend', gid, { _timeoutMs: 160000 }),
        // 牧场二期/三期手动写：报价与确认各含一次场景事务；pending 列表为本地文件读。
        getRanchPendingOperations: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchPendingOperations'),
        getRanchCatalog: (ref, shopId) => callWorkerApi(resolveAccountId(ref), 'getRanchCatalog', shopId, { _timeoutMs: 160000 }),
        getRanchBag: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchBag', { _timeoutMs: 160000 }),
        getRanchCanCatalog: (ref, slotType) => callWorkerApi(resolveAccountId(ref), 'getRanchCanCatalog', slotType, { _timeoutMs: 160000 }),
        getRanchTasks: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchTasks', { _timeoutMs: 160000 }),
        getRanchBook: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchBook', { _timeoutMs: 160000 }),
        getRanchShare: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchShare', { _timeoutMs: 160000 }),
        getRanchMarket: (ref) => callWorkerApi(resolveAccountId(ref), 'getRanchMarket', { _timeoutMs: 160000 }),
        getRanchActivities: (ref, groupId = '') => callWorkerApi(resolveAccountId(ref), 'getRanchActivities', groupId, { _timeoutMs: 160000 }),
        operateRanchMugeActivity: (ref, action, input = {}) => callWorkerApi(resolveAccountId(ref), 'operateRanchMugeActivity', action, input, { _timeoutMs: 180000 }),
        prepareRanchAction: (ref, action, input) => callWorkerApi(resolveAccountId(ref), 'prepareRanchAction', action, input, { _timeoutMs: 160000 }),
        operateRanch: (ref, action, input, expected) => callWorkerApi(resolveAccountId(ref), 'operateRanch', action, input, expected, { _timeoutMs: 160000 }),
        acknowledgeRanchOperation: (ref, id) => callWorkerApi(resolveAccountId(ref), 'acknowledgeRanchOperation', id),
        getSeeds: (ref) => callWorkerApi(resolveAccountId(ref), 'getSeeds'),
        getBag: (ref) => callWorkerApi(resolveAccountId(ref), 'getBag'),
        // 装扮/皮肤：读概览 + 手动换装
        getSkins: (ref) => callWorkerApi(resolveAccountId(ref), 'getSkins', { _timeoutMs: 65000 }),
        // 多阶段确认的游戏scope上限60s；IPC/HTTP留余量，不提前误判在途结果。
        equipSkin: (ref, skinId, slotType, expected) => callWorkerApi(resolveAccountId(ref), 'equipSkin', skinId, slotType, expected, { _timeoutMs: 65000 }),
        equipSkinPart: (ref, skinId, partId, expected) => callWorkerApi(resolveAccountId(ref), 'equipSkinPart', skinId, partId, expected, { _timeoutMs: 65000 }),
        getAvatarFrames: (ref) => callWorkerApi(resolveAccountId(ref), 'getAvatarFrames', { _timeoutMs: 65000 }),
        operateAvatarFrame: (ref, action, input) => callWorkerApi(resolveAccountId(ref), 'operateAvatarFrame', action, input, { _timeoutMs: 65000 }),
        getSolarTermsInfo: (ref) => callWorkerApi(resolveAccountId(ref), 'getSolarTermsInfo', { _timeoutMs: 65000 }),
        getSolarCalendar: (ref) => callWorkerApi(resolveAccountId(ref), 'getSolarCalendar', { _timeoutMs: 65000 }),
        getSolarQuestion: (ref, id) => callWorkerApi(resolveAccountId(ref), 'getSolarQuestion', id, { _timeoutMs: 65000 }),
        operateSolarCalendar: (ref, action, input) => callWorkerApi(resolveAccountId(ref), 'operateSolarCalendar', action, input, { _timeoutMs: 65000 }),
        setItemsLocked: (ref, itemUids, locked) => callWorkerApi(resolveAccountId(ref), 'setItemsLocked', itemUids, locked, { _timeoutMs: 65000 }),
        getOpenServerGifts: (ref) => callWorkerApi(resolveAccountId(ref), 'getOpenServerGifts', { _timeoutMs: 65000 }),
        claimOpenServerGift: (ref, id) => callWorkerApi(resolveAccountId(ref), 'claimOpenServerGift', id, { _timeoutMs: 65000 }),
        getBagSeeds: (ref) => callWorkerApi(resolveAccountId(ref), 'getBagSeeds'),
        getDogSkillGiftStatus: (ref) => callWorkerApi(resolveAccountId(ref), 'getDogSkillGiftStatus'),
        claimDogSkillGifts: (ref) => callWorkerApi(resolveAccountId(ref), 'claimDogSkillGifts'),
        getPetOverview: (ref) => callWorkerApi(resolveAccountId(ref), 'getPetOverview'),
        deployDog: (ref, dogId) => callWorkerApi(resolveAccountId(ref), 'deployDog', dogId),
        withdrawDog: (ref) => callWorkerApi(resolveAccountId(ref), 'withdrawDog'),
        feedDog: (ref, foodId, count) => callWorkerApi(resolveAccountId(ref), 'feedDog', foodId, count),
        activateDog: (ref, dogId) => callWorkerApi(resolveAccountId(ref), 'activateDog', dogId),
        getWishSignActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getWishSignActivity'),
        operateWishSign: (ref, action, chooseId) => callWorkerApi(resolveAccountId(ref), 'operateWishSign', action, chooseId),
        getShareRewardActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getShareRewardActivity'),
        operateShareReward: (ref, action) => callWorkerApi(resolveAccountId(ref), 'operateShareReward', action),
        getMilkTeaActivity: (ref, page, input) => callWorkerApi(resolveAccountId(ref), 'getMilkTeaActivity', page, input),
        operateMilkTeaActivity: (ref, action, input) => callWorkerApi(resolveAccountId(ref), 'operateMilkTeaActivity', action, input),
        getProtectLogs: (ref) => callWorkerApi(resolveAccountId(ref), 'getProtectLogs'),
        doFarmOp: (ref, op) => callWorkerApi(resolveAccountId(ref), 'doFarmOp', op, { _timeoutMs: 120000 }),
        setUnifiedHarvest: (ref, enabled) => callWorkerApi(resolveAccountId(ref), 'setUnifiedHarvest', enabled !== false),
        getUnifiedHarvest: (ref) => callWorkerApi(resolveAccountId(ref), 'getUnifiedHarvest'),
        buyFertilizer: (ref, type, count) => callWorkerApi(resolveAccountId(ref), 'buyFertilizer', type, count),
        checkAndBuyFertilizer: (ref, opts) => callWorkerApi(resolveAccountId(ref), 'checkAndBuyFertilizer', opts),
        getEmails: (ref, boxType) => callWorkerApi(resolveAccountId(ref), 'getEmails', boxType),
        claimEmail: (ref, boxType, emailId) => callWorkerApi(resolveAccountId(ref), 'claimEmail', boxType, emailId),
        fertilizeLand: (ref, landId) => callWorkerApi(resolveAccountId(ref), 'fertilizeLand', landId),
        removePlant: (ref, landId) => callWorkerApi(resolveAccountId(ref), 'removePlant', landId),
        removeAllPlants: (ref) => callWorkerApi(resolveAccountId(ref), 'removeAllPlants'),
        getShopInfo: (ref, shopId) => callWorkerApi(resolveAccountId(ref), 'getShopInfo', shopId),
        buyGoods: (ref, shopId, goodsId, count) => callWorkerApi(resolveAccountId(ref), 'buyGoods', shopId, goodsId, count),
        getDecorationShop: (ref) => callWorkerApi(resolveAccountId(ref), 'getDecorationShop', { _timeoutMs: 65000 }),
        buyDecorationGoods: (ref, goodsId, count, expectedOffer) => callWorkerApi(resolveAccountId(ref), 'buyDecorationGoods', goodsId, count, expectedOffer, { _timeoutMs: 65000 }),
        doAnalytics: (ref, days) => callWorkerApi(resolveAccountId(ref), 'getAnalytics', days),

        // ========== Friend API ==========
        getFriends: (ref, force = false) => callWorkerApi(resolveAccountId(ref), 'getFriends', force,
            force ? FRIEND_TIMEOUT : undefined),
        clearFriendsCache: (ref) => callWorkerApi(resolveAccountId(ref), 'clearFriendsCache'),
        getInteractRecords: (ref) => callWorkerApi(resolveAccountId(ref), 'getInteractRecords'),
        getFriendLands: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getFriendLands', gid, FRIEND_LANDS_TIMEOUT),
        recoverLegacyFriendVisit: (ref, options) => callWorkerApi(resolveAccountId(ref), 'recoverLegacyFriendVisit', options, FRIEND_LANDS_TIMEOUT),
        doFriendOp: (ref, gid, op) => callWorkerApi(resolveAccountId(ref), 'doFriendOp', gid, op),
        getFriendDogInfo: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getFriendDogInfo', gid),
        batchGetFriendDogInfo: (ref, gids) => callWorkerApi(resolveAccountId(ref), 'batchGetFriendDogInfo', gids),
        syncFriendsFromGids: (ref, gids) => callWorkerApi(resolveAccountId(ref), 'syncFriendsFromGids', gids, SYNC_TIMEOUT),
        fetchFriendsDogInfo: (ref) => callWorkerApi(resolveAccountId(ref), 'fetchFriendsDogInfo', DOG_INFO_TIMEOUT),
        delFriend: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'delFriend', gid),

        // ========== 仓库 ==========
        useItem: (ref, itemId, count, uid) => callWorkerApi(resolveAccountId(ref), 'useItem', itemId, count, uid, { _timeoutMs: 65000 }),
        sellItems: (ref, items) => callWorkerApi(resolveAccountId(ref), 'sellItems', items),

        // ========== 每日礼包 ==========
        getDailyGifts: (ref) => callWorkerApi(resolveAccountId(ref), 'getDailyGiftOverview'),

        // ========== Mall ==========
        getMallGoods: (ref, slotType) => callWorkerApi(resolveAccountId(ref), 'getMallGoods', slotType),
        buyMallGoods: (ref, goodsId, count) => callWorkerApi(resolveAccountId(ref), 'buyMallGoods', goodsId, count),
        getMysteryShop: (ref) => callWorkerApi(resolveAccountId(ref), 'getMysteryShop', MYSTERY_SHOP_TIMEOUT),
        buyMysteryShopGoods: (ref, npcId) => callWorkerApi(resolveAccountId(ref), 'buyMysteryShopGoods', npcId),
        abandonMysteryShop: (ref) => callWorkerApi(resolveAccountId(ref), 'abandonMysteryShop'),

        // ========== Activity ==========
        getActivityShop: (ref) => callWorkerApi(resolveAccountId(ref), 'getActivityShop'),
        getActivityDiscoveryList: (ref) => callWorkerApi(resolveAccountId(ref), 'getActivityDiscoveryList'),
        getBulletinList: (ref) => callWorkerApi(resolveAccountId(ref), 'getBulletinList'),
        getBulletinDetail: (ref, id) => callWorkerApi(resolveAccountId(ref), 'getBulletinDetail', id),
        getActivityGroupSnapshot: (ref, activityId, uid = '') => callWorkerApi(resolveAccountId(ref), 'getActivityGroupSnapshot', activityId, uid),
        buyActivityShopItem: (ref, itemId, count) => callWorkerApi(resolveAccountId(ref), 'buyActivityShopItem', itemId, count),
        refreshActivityShop: (ref) => callWorkerApi(resolveAccountId(ref), 'refreshActivityShop'),
        getHeluActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getHeluActivity'),
        getHonghuaActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getHonghuaActivity'),
        donateHonghuaLove: (ref) => callWorkerApi(resolveAccountId(ref), 'donateHonghuaLove'),
        donateHonghuaFund: (ref) => callWorkerApi(resolveAccountId(ref), 'donateHonghuaFund'),
        claimHonghuaShare: (ref) => callWorkerApi(resolveAccountId(ref), 'claimHonghuaShare'),
        claimHonghuaTiers: (ref) => callWorkerApi(resolveAccountId(ref), 'claimHonghuaTiers'),
        getStarActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getStarActivity'),
        claimStarRecordRewards: (ref) => callWorkerApi(resolveAccountId(ref), 'claimStarRecordRewards'),
        exchangeStarShopItem: (ref, slotId, count) => callWorkerApi(resolveAccountId(ref), 'exchangeStarShopItem', slotId, count),
        exchangeHeluShopItem: (ref, slotId, count) => callWorkerApi(resolveAccountId(ref), 'exchangeHeluShopItem', slotId, count),
        drawHeluGiftLotus: (ref, options) => callWorkerApi(resolveAccountId(ref), 'drawHeluGiftLotus', options || {}),
        claimSeasonPassportRewards: (ref) => callWorkerApi(resolveAccountId(ref), 'claimSeasonPassportRewards'),
        claimSolarTermsReward: (ref, termId) => callWorkerApi(resolveAccountId(ref), 'claimSolarTermsReward', termId),
        claimQingmeiSeeds: (ref) => callWorkerApi(resolveAccountId(ref), 'claimQingmeiSeeds'),
        brewAndSellQingmeiWine: (ref, options) => callWorkerApi(resolveAccountId(ref), 'brewAndSellQingmeiWine', options || {}),
        getQixiActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getQixiActivity'),
        buildQixiBridge: (ref, options) => callWorkerApi(resolveAccountId(ref), 'buildQixiBridge', options || {}),
        sendQixiSachet: (ref, friendGid, count) => callWorkerApi(resolveAccountId(ref), 'sendQixiSachet', friendGid, count),
        useQixiDew: (ref, options) => callWorkerApi(resolveAccountId(ref), 'useQixiDew', options || {}),
        getRainPoemActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getRainPoemActivity'),
        buyRainPoemCollectionBottle: (ref) => callWorkerApi(resolveAccountId(ref), 'buyRainPoemCollectionBottle'),
        collectRainPoemWeather: (ref) => callWorkerApi(resolveAccountId(ref), 'collectRainPoemWeather'),
        useRainPoemSummonBottle: (ref) => callWorkerApi(resolveAccountId(ref), 'useRainPoemSummonBottle'),
        unlockRainPoemResearch: (ref, nodeId) => callWorkerApi(resolveAccountId(ref), 'unlockRainPoemResearch', nodeId),
        putRainPoemPrankOnFriend: (ref, friendGid, itemId, landId) => callWorkerApi(resolveAccountId(ref), 'putRainPoemPrankOnFriend', friendGid, itemId, landId || 0),
        getPetDiaryActivity: (ref) => callWorkerApi(resolveAccountId(ref), 'getPetDiaryActivity'),
        getPetDiary: (ref) => callWorkerApi(resolveAccountId(ref), 'getPetDiary'),
        operatePetDiary: (ref, action, params) => callWorkerApi(resolveAccountId(ref), 'operatePetDiary', action, params || {}),
        getPetDiaryRecords: (ref, kind) => callWorkerApi(resolveAccountId(ref), 'getPetDiaryRecords', kind),
        getPetDiaryFriend: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getPetDiaryFriend', gid),
        getFriendDogInfo: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getFriendDogInfo', gid),

        // ========== Illustrated ==========
        // 2026-11-02：参数语义改为 (rarity, illustratedType)。
        // 注意：路由层历史签名是 (refresh, illustratedType)，refresh 已废弃
        // （官方 request 没有 refresh 字段，field 1 是 rarity），故首位当 rarity 用，
        // 布尔值会被 Number() 转成 0/1，0 恰好等于"全部"，行为安全。
        getIllustratedList: (ref, rarity, illustratedType) => callWorkerApi(resolveAccountId(ref), 'getIllustratedList', rarity, illustratedType),
        // 藏品（collectionpb，2026-11-03 新增；公告 26110102 的「果冻花园」）
        getCollections: (ref, categories) => callWorkerApi(resolveAccountId(ref), 'getCollections', categories),
        upgradeCollection: (ref, category, collectionId, expected) => callWorkerApi(resolveAccountId(ref), 'upgradeCollection', category, collectionId, expected, { _timeoutMs: 90000 }),
        claimCollectionReward: (ref, category) => callWorkerApi(resolveAccountId(ref), 'claimCollectionReward', category, { _timeoutMs: 65000 }),
        setCollectionDisplay: (ref, input) => callWorkerApi(resolveAccountId(ref), 'setCollectionDisplay', input, { _timeoutMs: 65000 }),
        claimIllustratedRewards: (ref, type) => callWorkerApi(resolveAccountId(ref), 'claimIllustratedRewards', type),

        // ========== Career ==========
        getCareerInfo: (ref, gid) => callWorkerApi(resolveAccountId(ref), 'getCareerInfo', gid),

        // ========== 配置 ==========
        resumeFriendBad: async (ref) => {
            const id = resolveAccountId(ref);
            if (!id || !store.isAutomationOn('friend_bad', id)) throw new Error('当前账号未开启自动放虫放草');
            const previousRetryDate = store.getFriendBadRetryDate(id);
            store.applyConfigSnapshot({ friendBadRetryDate: '' }, { accountId: id });
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(id);
            return { accountId: id, friendBadRetryDate: store.getFriendBadRetryDate(id), previousRetryDate,
                configRevision: rev, gameRpcSent: false, budgetReset: false };
        },
        setAutomation: async (ref, key, value) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            store.setAutomation(key, value, id);
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(id);
            return { automation: store.getAutomation(id), configRevision: rev };
        },
        setAutomationBatch: async (ref, values) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('自动化配置无效');
            // 单次normalize/落盘/广播，避免多字段保存期间worker看到半套新配置。
            store.applyConfigSnapshot({ automation: values }, { accountId: id });
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(id);
            return { automation: store.getAutomation(id), configRevision: rev };
        },

        saveSettings: async (ref, settings) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            const s = settings && typeof settings === 'object' ? settings : {};
            const patch = {
                plantingStrategy: s.plantingStrategy !== undefined ? s.plantingStrategy : s.strategy,
                preferredSeedId: s.preferredSeedId !== undefined ? s.preferredSeedId : s.seedId,
                prioritize2x2Crops: s.prioritize2x2Crops,
                intervals: s.intervals,
                friendQuietHours: s.friendQuietHours,
                autoCodeRefresh: s.autoCodeRefresh,
                stealDelaySeconds: s.stealDelaySeconds,
                plantOrderRandom: s.plantOrderRandom,
                plantDelaySeconds: s.plantDelaySeconds,
                fertilizerBuyOrganicCount: s.fertilizerBuyOrganicCount,
                fertilizerBuyOrganicThresholdHours: s.fertilizerBuyOrganicThresholdHours,
                fertilizerBuyNormalCount: s.fertilizerBuyNormalCount,
                fertilizerBuyNormalThresholdHours: s.fertilizerBuyNormalThresholdHours,
                fertilizerBuyCheckIntervalMinutes: s.fertilizerBuyCheckIntervalMinutes,
                goldenBugKeepCount: s.goldenBugKeepCount,
                goldenBugRoundLimit: s.goldenBugRoundLimit,
                friendBadTargets: s.friendBadTargets,
                autoAcceptFriendMinLevel: s.autoAcceptFriendMinLevel,
                bagSeedPriority: s.bagSeedPriority,
                bagSeedKnownIds: s.bagSeedKnownIds,
                bagSeedFallbackStrategy: s.bagSeedFallbackStrategy,
            };
            store.applyConfigSnapshot(patch, { accountId: id });
            const rev = nextConfigRevision();
            broadcastConfigToWorkers(id);
            if (s.autoCodeRefresh && typeof scheduleAutoCodeRefresh === 'function') {
                scheduleAutoCodeRefresh(id);
            }
            return {
                strategy: store.getPlantingStrategy(id),
                preferredSeed: store.getPreferredSeed(id),
                prioritize2x2Crops: store.getPrioritize2x2Crops(id),
                intervals: store.getIntervals(id),
                friendQuietHours: store.getFriendQuietHours(id),
                autoCodeRefresh: store.getAutoCodeRefresh(id),
                stealDelaySeconds: store.getStealDelaySeconds(id),
                plantOrderRandom: store.getPlantOrderRandom(id),
                plantDelaySeconds: store.getPlantDelaySeconds(id),
                fertilizerBuyOrganicCount: store.getFertilizerBuyOrganicCount(id),
                fertilizerBuyOrganicThresholdHours: store.getFertilizerBuyOrganicThresholdHours(id),
                fertilizerBuyNormalCount: store.getFertilizerBuyNormalCount(id),
                fertilizerBuyNormalThresholdHours: store.getFertilizerBuyNormalThresholdHours(id),
                fertilizerBuyCheckIntervalMinutes: store.getFertilizerBuyCheckIntervalMinutes(id),
                goldenBugKeepCount: store.getConfigSnapshot(id).goldenBugKeepCount,
                goldenBugRoundLimit: store.getConfigSnapshot(id).goldenBugRoundLimit,
                friendBadTargets: typeof store.getFriendBadTargets === 'function' ? store.getFriendBadTargets(id) : [],
                autoAcceptFriendMinLevel: store.getAutoAcceptFriendMinLevel(id),
                bagSeedPriority: store.getBagSeedPriority(id),
                bagSeedFallbackStrategy: store.getBagSeedFallbackStrategy(id),
                configRevision: rev
            };
        },

        saveAutoCodeRefresh: async (ref, config) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            const data = store.setAutoCodeRefresh(id, config || {});
            if (typeof scheduleAutoCodeRefresh === 'function') scheduleAutoCodeRefresh(id);
            return { autoCodeRefresh: data };
        },

        refreshAccountCode: async (ref) => {
            const id = resolveAccountId(ref);
            if (!id) throw new Error('Missing x-account-id');
            if (typeof refreshAccountCode !== 'function') throw new Error('自动刷新服务不可用');
            const ok = await refreshAccountCode(id, 'manual');
            return { ok };
        },

        setUITheme: async (theme) => {
            const result = store.setUITheme(theme);
            return { ui: result.ui || store.getUI() };
        },

        broadcastConfig: (accountId) => {
            broadcastConfigToWorkers(accountId);
        },

        setRuntimeAccountName: (ref, name) => {
            const id = resolveAccountId(ref);
            if (!id) return;
            const worker = workers[id];
            if (worker) {
                worker.name = String(name || worker.name || id);
            }
        },

        // ========== 账号管理 ==========
        getAccounts: () => {
            const data = getAccounts();
            data.accounts.forEach(acc => {
                const worker = workers[acc.id];
                acc.running = !!worker;
                if (worker && worker.status && worker.status.status && worker.status.status.name) {
                    acc.nick = worker.status.status.name;
                }
            });
            return data;
        },

        startAccount: (ref) => {
            const id = resolveAccountId(ref);
            const account = findAccount(id || ref);
            if (!account) return false;
            startWorker(account);
            return true;
        },

        stopAccount: (ref) => {
            const id = resolveAccountId(ref);
            const account = findAccount(id || ref);
            if (!account) return false;
            if (id) stopWorker(id);
            return true;
        },

        restartAccount: (ref) => {
            const id = resolveAccountId(ref);
            const account = findAccount(id || ref);
            if (!account) return false;
            restartWorker(account);
            return true;
        },

        isAccountRunning: (ref) => {
            const id = resolveAccountId(ref);
            return !!(id && workers[id]);
        },

        getRunningAccountCount: () => Object.keys(workers).length,

        getManagerDiagnostics: (ref) => typeof callWorkerApi.getDiagnostics === 'function'
            ? callWorkerApi.getDiagnostics(resolveAccountId(ref)) : null,

        // worker 负责脱敏传输诊断；manager 只附带本地有界计数与迟到状态，不保存业务回包。
        getTransportDiagnostics: async (ref) => {
            const id = resolveAccountId(ref);
            const worker = await callWorkerApi(id, 'getTransportDiagnostics');
            const manager = typeof callWorkerApi.getDiagnostics === 'function'
                ? callWorkerApi.getDiagnostics(id) : null;
            return { worker, manager };
        },

        // ========== 调度器状态 ==========
        getSchedulerStatus: async (ref) => {
            const id = resolveAccountId(ref);
            const runtimeSchedulers = getSchedulerRegistrySnapshot();
            let workerSchedulers = null;
            let workerError = '';

            if (!id) {
                return { accountId: '', runtime: runtimeSchedulers, worker: workerSchedulers, workerError: '' };
            }

            if (!workers[id]) {
                return { accountId: id, runtime: runtimeSchedulers, worker: workerSchedulers, workerError: '账号未运行' };
            }

            try {
                workerSchedulers = await callWorkerApi(id, 'getSchedulers');
            } catch (err) {
                workerError = err && err.message ? err.message : String(err || 'unknown');
            }

            return { accountId: id, runtime: runtimeSchedulers, worker: workerSchedulers, workerError };
        }
    };
}

module.exports = { createDataProvider };
