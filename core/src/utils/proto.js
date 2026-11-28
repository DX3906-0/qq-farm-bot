/**
 * Proto 加载与消息类型管理
 */

const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const { log } = require('./utils');

// Proto 根对象与所有消息类型
let root = null;
const types = {};
let protoReadyResolve = null;
let protoReadyPromise = null;

function getProtoReadyPromise() {
    if (!protoReadyPromise) {
        protoReadyPromise = new Promise((resolve) => {
            protoReadyResolve = resolve;
        });
    }
    return protoReadyPromise;
}

async function loadProto() {
    log('系统', '正在加载 Protobuf 定义...');
    root = new protobuf.Root();
    await root.load([
        getResourcePath('proto', 'game.proto'),
        getResourcePath('proto', 'userpb.proto'),
        // 2026-11-02 同步上游：登录协议独立成文件（含 version_info 版本校准字段）
        getResourcePath('proto', 'player-login.proto'),
        // 牧场按固定1.17.0.3子集加载；读写权限由精确路由、场景租约和终态核验控制。
        // 只读GET不调用写方法，所有开放写动作仍走报价确认与持久账本。
        getResourcePath('proto', 'globalscenepb.proto'),
        getResourcePath('proto', 'animalpb.proto'),
        getResourcePath('proto', 'homesteadpb.proto'),
        // 牧场场景2背包/出售/使用独立命名空间（物品为 is_locked + show.sells 结构）。
        getResourcePath('proto', 'ranchpb.proto'),
        getResourcePath('proto', 'plantpb.proto'),
        getResourcePath('proto', 'corepb.proto'),
        getResourcePath('proto', 'shoppb.proto'),
        getResourcePath('proto', 'friendpb.proto'),
        getResourcePath('proto', 'visitpb.proto'),
        getResourcePath('proto', 'weatherpb.proto'),
        getResourcePath('proto', 'notifypb.proto'),
        getResourcePath('proto', 'taskpb.proto'),
        getResourcePath('proto', 'itempb.proto'),
        getResourcePath('proto', 'emailpb.proto'),
        getResourcePath('proto', 'mallpb.proto'),
        getResourcePath('proto', 'paypb.proto'),
        getResourcePath('proto', 'redpacketpb.proto'),
        getResourcePath('proto', 'qqvippb.proto'),
        getResourcePath('proto', 'sharepb.proto'),
        getResourcePath('proto', 'illustratedpb.proto'),
        getResourcePath('proto', 'interactpb.proto'),
        getResourcePath('proto', 'dogpb.proto'),
        getResourcePath('proto', 'activitypb.proto'),
        // 牧歌初启的 ActivityService 专属 Muge* 消息与普通活动目录 payload 不同。
        getResourcePath('proto', 'muge.proto'),
        // 2026-11-02 同步上游：activitypb 被拆成多个同命名空间(gamepb.activitypb)的文件，
        // ActivityData 的 oneof 引用了这里的 ActivityBodyWishSign 等类型，
        // 不加载会报「no such Type or Enum 'ActivityBodyWishSign'」。
        getResourcePath('proto', 'autumn-activities.proto'),
        getResourcePath('proto', 'milk-tea.proto'),
        getResourcePath('proto', 'pet-diary.proto'),
        getResourcePath('proto', 'mysteryshoppb.proto'),
        getResourcePath('proto', 'acepb.proto'),
        getResourcePath('proto', 'careerpb.proto'),
        getResourcePath('proto', 'skinpb.proto'),
        getResourcePath('proto', 'avatarframepb.proto'),
        getResourcePath('proto', 'solartermspb.proto'),
        // 2026-11-03：公告/跑马灯 proto 一直存在却没被加载，导致 services/bulletin.js
        // 只能手写 varint 解码（注释里写"bot 未内置 bulletinboardpb.proto"）。
        // 游戏公告是判断新版本内容的第一手资料，必须结构化解析。
        getResourcePath('proto', 'bulletinboardpb.proto'),
        getResourcePath('proto', 'marqueepb.proto'),
        // 2026-11-03：藏品系统（公告 26110102：11-02 上线的「果冻花园」藏品，125 级解锁）。
        // proto 早已存在且注释标注"Verified against official 2026-11-01 encoders"，
        // 但一直没被加载，导致藏品功能整体缺失。
        getResourcePath('proto', 'collectionpb.proto'),
    ], { keepCase: true });

    // 网关

    // ⭐ 容错 lookup（2026-11-02）：上游会周期性删除/重命名 message，而本文件对每个
    // 用到的类型都做了显式注册。任一类型缺失都会让整个 loadProto() 抛错，
    // 导致账号完全无法登录 —— 代价与"少一个可选功能"完全不成比例。
    // 改为：缺失时告警并跳过（注册为 null）；调用方本就有 `if (!types.X)` 判空。
    const _missingTypes = [];
    const _lookup = (name) => {
        try {
            return root.lookupType(name);
        } catch (_e) {
            _missingTypes.push(name);
            return null;
        }
    };
    types.GateMessage = _lookup('gatepb.Message');
    types.GateMeta = _lookup('gatepb.Meta');
    types.EventMessage = _lookup('gatepb.EventMessage');

    // 用户
    types.LoginRequest = _lookup('gamepb.userpb.LoginRequest');
    types.LoginReply = _lookup('gamepb.userpb.LoginReply');
    // Register the official global-login schema without changing live login mode.
    types.PlayerLoginRequest = _lookup('gamepb.userpb.PlayerLoginRequest');
    types.PlayerLoginReply = _lookup('gamepb.userpb.PlayerLoginReply');
    types.HeartbeatRequest = _lookup('gamepb.userpb.HeartbeatRequest');
    types.HeartbeatReply = _lookup('gamepb.userpb.HeartbeatReply');
    types.ReportArkClickRequest = _lookup('gamepb.userpb.ReportArkClickRequest');
    types.ReportArkClickReply = _lookup('gamepb.userpb.ReportArkClickReply');
    types.AntiDataRequest = _lookup('gamepb.acepb.AntiDataRequest');
    types.AntiDataReply = _lookup('gamepb.acepb.AntiDataReply');
    types.CareerInfoGetRequest = _lookup('gamepb.careerpb.CareerInfoGetRequest');
    types.CareerInfoGetReply = _lookup('gamepb.careerpb.CareerInfoGetReply');

    // 牧场一期只读：PlayerSceneLogin 是场景会话事务；AllCells/GetRanchDetail 才是安全读。
    types.GetPlayerSceneInfoRequest = _lookup('gamepb.globalscenepb.GetPlayerSceneInfoRequest');
    types.GetPlayerSceneInfoReply = _lookup('gamepb.globalscenepb.GetPlayerSceneInfoReply');
    types.PlayerSceneLoginRequest = _lookup('gamepb.globalscenepb.PlayerSceneLoginRequest');
    types.PlayerSceneLoginReply = _lookup('gamepb.globalscenepb.PlayerSceneLoginReply');
    types.RanchAllCellsRequest = _lookup('gamepb.homesteadpb.AllCellsRequest');
    types.RanchAllCellsReply = _lookup('gamepb.homesteadpb.AllCellsReply');
    types.RanchGetRanchDetailRequest = _lookup('gamepb.animalpb.GetRanchDetailRequest');
    types.RanchGetRanchDetailReply = _lookup('gamepb.animalpb.GetRanchDetailReply');

    // 牧场二期自家写操作（手动确认后才允许调用；服务层不含好友向消息）。
    types.RanchPlaceAnimalRequest = _lookup('gamepb.animalpb.PlaceAnimalRequest');
    types.RanchPlaceAnimalReply = _lookup('gamepb.animalpb.PlaceAnimalReply');
    types.RanchTriggerProduceRequest = _lookup('gamepb.animalpb.TriggerProduceRequest');
    types.RanchTriggerProduceReply = _lookup('gamepb.animalpb.TriggerProduceReply');
    types.RanchFeedAnimalRequest = _lookup('gamepb.animalpb.FeedAnimalRequest');
    types.RanchFeedAnimalReply = _lookup('gamepb.animalpb.FeedAnimalReply');
    types.RanchHarvestRanchRequest = _lookup('gamepb.animalpb.HarvestRanchRequest');
    types.RanchHarvestRanchReply = _lookup('gamepb.animalpb.HarvestRanchReply');
    types.RanchDonateAnimalRequest = _lookup('gamepb.animalpb.DonateAnimalRequest');
    types.RanchDonateAnimalReply = _lookup('gamepb.animalpb.DonateAnimalReply');
    types.RanchCleanAllRanchRequest = _lookup('gamepb.animalpb.CleanAllRanchRequest');
    types.RanchCleanAllRanchReply = _lookup('gamepb.animalpb.CleanAllRanchReply');
    types.RanchUpgradeBuildingRequest = _lookup('gamepb.homesteadpb.UpgradeBuildingRequest');
    types.RanchUpgradeBuildingReply = _lookup('gamepb.homesteadpb.UpgradeBuildingReply');
    types.RanchCompleteBuildingUpgradeRequest = _lookup('gamepb.homesteadpb.CompleteBuildingUpgradeRequest');
    types.RanchCompleteBuildingUpgradeReply = _lookup('gamepb.homesteadpb.CompleteBuildingUpgradeReply');
    types.RanchAddFeedRequest = _lookup('gamepb.homesteadpb.AddFeedRequest');
    types.RanchAddFeedReply = _lookup('gamepb.homesteadpb.AddFeedReply');
    types.RanchGetFacilityDetailRequest = _lookup('gamepb.homesteadpb.GetFacilityDetailRequest');
    types.RanchGetFacilityDetailReply = _lookup('gamepb.homesteadpb.GetFacilityDetailReply');

    // 牧场三期3B好友互动：独立EnterHomestead/LeaveHomestead会话，不复用农场Visit Enter/Leave。
    types.RanchEnterHomesteadRequest = _lookup('gamepb.ranchpb.EnterHomesteadRequest');
    types.RanchEnterHomesteadReply = _lookup('gamepb.ranchpb.EnterHomesteadReply');
    types.RanchLeaveHomesteadRequest = _lookup('gamepb.ranchpb.LeaveHomesteadRequest');
    types.RanchLeaveHomesteadReply = _lookup('gamepb.ranchpb.LeaveHomesteadReply');
    types.RanchStealProduceRequest = _lookup('gamepb.animalpb.StealProduceRequest');
    types.RanchStealProduceReply = _lookup('gamepb.ranchpb.StealProduceReply');
    types.RanchPutHazardRequest = _lookup('gamepb.animalpb.PutHazardRequest');
    types.RanchPutHazardReply = _lookup('gamepb.animalpb.PutHazardReply');
    types.RanchGetRanchOpTimesRequest = _lookup('gamepb.animalpb.GetRanchOpTimesRequest');
    types.RanchGetRanchOpTimesReply = _lookup('gamepb.animalpb.GetRanchOpTimesReply');
    types.RanchStrokeAnimalRequest = _lookup('gamepb.animalpb.StrokeAnimalRequest');
    types.RanchStrokeAnimalReply = _lookup('gamepb.animalpb.StrokeAnimalReply');

    // 牧场场景2背包/出售/使用（ranchpb 命名空间，service 仍为 itempb.ItemService）。
    types.RanchGetBagRequest = _lookup('gamepb.ranchpb.GetBagRequest');
    types.RanchGetBagReply = _lookup('gamepb.ranchpb.GetBagReply');
    types.RanchIllustratedChangeNotifyV2 = _lookup('gamepb.illustratedpb.IllustratedChangeNotifyV2');
    types.RanchIllustratedRewardRedDotNotifyV2 = _lookup('gamepb.illustratedpb.IllustratedRewardRedDotNotifyV2');
    // 4B keeps ranch book/share wire shapes separate from farm aliases.
    for (const name of [
        'GetIllustratedListV2Request', 'GetIllustratedListV2Reply',
        'GetRanchWeightScoreV2Request', 'GetRanchWeightScoreV2Reply',
        'ClaimRanchWeightScoreRewardV2Request', 'ClaimRanchWeightScoreRewardV2Reply',
        'ClaimAllRewardsV2Request', 'ClaimAllRewardsV2Reply',
        'BatchGetBasicInfoRequest', 'BatchGetBasicInfoReply',
        'ReportShareRequest', 'ReportShareReply', 'ClaimShareRewardRequest', 'ClaimShareRewardReply',
        'RotationShopInfoRequest', 'RotationShopInfoReply', 'RotationBuyGoodsRequest', 'RotationBuyGoodsReply',
        'ActivityListRequest', 'ActivityListReply', 'GetActivityGroupRequest', 'GetActivityGroupReply', 'ActiviesChangeNotify',
    ]) types[`Ranch${name}`] = _lookup(`gamepb.ranchpb.${name}`);
    for (const name of ['TaskInfoRequest', 'TaskInfoReply', 'BatchClaimTaskRewardRequest', 'BatchClaimTaskRewardReply']) {
        types[`Ranch${name}`] = _lookup(`gamepb.taskpb.${name}`);
    }
    for (const name of ['GetIllustratedLevelListV2Request', 'GetIllustratedLevelListV2Reply']) {
        types[`Ranch${name}`] = _lookup(`gamepb.illustratedpb.${name}`);
    }
    types.RanchUseRequest = _lookup('gamepb.ranchpb.UseRequest');
    types.RanchUseReply = _lookup('gamepb.ranchpb.UseReply');
    types.GetRechargeInfoRequest = _lookup('gamepb.paypb.GetRechargeInfoRequest');
    types.GetRechargeInfoReply = _lookup('gamepb.paypb.GetRechargeInfoReply');
    types.RanchSellRequest = _lookup('gamepb.ranchpb.SellRequest');
    types.RanchSellReply = _lookup('gamepb.ranchpb.SellReply');

    // 农场
    types.AllLandsRequest = _lookup('gamepb.plantpb.AllLandsRequest');
    types.AllLandsReply = _lookup('gamepb.plantpb.AllLandsReply');
    types.HarvestRequest = _lookup('gamepb.plantpb.HarvestRequest');
    types.HarvestReply = _lookup('gamepb.plantpb.HarvestReply');
    types.WaterLandRequest = _lookup('gamepb.plantpb.WaterLandRequest');
    types.WaterLandReply = _lookup('gamepb.plantpb.WaterLandReply');
    types.FarmingRequest = _lookup('gamepb.plantpb.FarmingRequest');
    types.FarmingReply = _lookup('gamepb.plantpb.FarmingReply');
    types.WeedOutRequest = _lookup('gamepb.plantpb.WeedOutRequest');
    types.WeedOutReply = _lookup('gamepb.plantpb.WeedOutReply');
    types.InsecticideRequest = _lookup('gamepb.plantpb.InsecticideRequest');
    types.InsecticideReply = _lookup('gamepb.plantpb.InsecticideReply');
    types.RemovePlantRequest = _lookup('gamepb.plantpb.RemovePlantRequest');
    types.RemovePlantReply = _lookup('gamepb.plantpb.RemovePlantReply');
    types.PutInsectsRequest = _lookup('gamepb.plantpb.PutInsectsRequest');
    types.PutInsectsReply = _lookup('gamepb.plantpb.PutInsectsReply');
    types.PutWeedsRequest = _lookup('gamepb.plantpb.PutWeedsRequest');
    types.PutWeedsReply = _lookup('gamepb.plantpb.PutWeedsReply');
    types.PutSocialItemRequest = _lookup('gamepb.plantpb.PutSocialItemRequest');
    types.PutSocialItemReply = _lookup('gamepb.plantpb.PutSocialItemReply');
    types.UpgradeLandRequest = _lookup('gamepb.plantpb.UpgradeLandRequest');
    types.UpgradeLandReply = _lookup('gamepb.plantpb.UpgradeLandReply');
    types.UnlockLandRequest = _lookup('gamepb.plantpb.UnlockLandRequest');
    types.UnlockLandReply = _lookup('gamepb.plantpb.UnlockLandReply');
    types.CheckCanOperateRequest = _lookup('gamepb.plantpb.CheckCanOperateRequest');
    types.CheckCanOperateReply = _lookup('gamepb.plantpb.CheckCanOperateReply');
    types.FertilizeRequest = _lookup('gamepb.plantpb.FertilizeRequest');
    types.FertilizeReply = _lookup('gamepb.plantpb.FertilizeReply');

    // 背包/仓库
    types.BagRequest = _lookup('gamepb.itempb.BagRequest');
    types.BagReply = _lookup('gamepb.itempb.BagReply');
    types.SellRequest = _lookup('gamepb.itempb.SellRequest');
    types.SellReply = _lookup('gamepb.itempb.SellReply');
    types.UseRequest = _lookup('gamepb.itempb.UseRequest');
    types.UseReply = _lookup('gamepb.itempb.UseReply');
    types.LockItemsRequest = _lookup('gamepb.itempb.LockItemsRequest');
    types.LockItemsReply = _lookup('gamepb.itempb.LockItemsReply');
    types.UnlockItemsRequest = _lookup('gamepb.itempb.UnlockItemsRequest');
    types.UnlockItemsReply = _lookup('gamepb.itempb.UnlockItemsReply');
    types.BatchUseRequest = _lookup('gamepb.itempb.BatchUseRequest');
    types.BatchUseReply = _lookup('gamepb.itempb.BatchUseReply');
    types.PlantRequest = _lookup('gamepb.plantpb.PlantRequest');
    types.PlantReply = _lookup('gamepb.plantpb.PlantReply');
    types.PlantItem = _lookup('gamepb.plantpb.PlantItem');

    // 商店
    types.ShopProfilesRequest = _lookup('gamepb.shoppb.ShopProfilesRequest');
    types.ShopProfilesReply = _lookup('gamepb.shoppb.ShopProfilesReply');
    types.ShopInfoRequest = _lookup('gamepb.shoppb.ShopInfoRequest');
    types.ShopInfoReply = _lookup('gamepb.shoppb.ShopInfoReply');
    types.BuyGoodsRequest = _lookup('gamepb.shoppb.BuyGoodsRequest');
    types.BuyGoodsReply = _lookup('gamepb.shoppb.BuyGoodsReply');
    types.GetMonthCardInfosRequest = _lookup('gamepb.mallpb.GetMonthCardInfosRequest');
    types.GetMonthCardInfosReply = _lookup('gamepb.mallpb.GetMonthCardInfosReply');
    types.ClaimMonthCardRewardRequest = _lookup('gamepb.mallpb.ClaimMonthCardRewardRequest');
    types.ClaimMonthCardRewardReply = _lookup('gamepb.mallpb.ClaimMonthCardRewardReply');
    types.GetTodayClaimStatusRequest = _lookup('gamepb.redpacketpb.GetTodayClaimStatusRequest');
    types.GetTodayClaimStatusReply = _lookup('gamepb.redpacketpb.GetTodayClaimStatusReply');
    types.ClaimRedPacketRequest = _lookup('gamepb.redpacketpb.ClaimRedPacketRequest');
    types.ClaimRedPacketReply = _lookup('gamepb.redpacketpb.ClaimRedPacketReply');
    types.GetMallListBySlotTypeRequest = _lookup('gamepb.mallpb.GetMallListBySlotTypeRequest');
    // 装扮/皮肤（skinpb）
    types.SkinsOwnedRequest = _lookup('gamepb.skinpb.SkinsOwnedRequest');
    types.SkinsOwnedReply = _lookup('gamepb.skinpb.SkinsOwnedReply');
    types.SkinsEquippedRequest = _lookup('gamepb.skinpb.SkinsEquippedRequest');
    types.SkinsEquippedReply = _lookup('gamepb.skinpb.SkinsEquippedReply');
    types.Skin = _lookup('gamepb.skinpb.Skin');
    types.SkinPart = _lookup('gamepb.skinpb.SkinPart');
    types.SkinSetEffectInfo = _lookup('gamepb.skinpb.SkinSetEffectInfo');
    types.SkinSetEffectTypeParams = _lookup('gamepb.skinpb.SkinSetEffectTypeParams');
    types.SkinChangeNotify = _lookup('gamepb.skinpb.SkinChangeNotify');
    types.GetSkinEffectTypeParamsRequest = _lookup('gamepb.skinpb.GetSkinEffectTypeParamsRequest');
    types.GetSkinEffectTypeParamsReply = _lookup('gamepb.skinpb.GetSkinEffectTypeParamsReply');
    types.EquipSkinRequest = _lookup('gamepb.skinpb.EquipRequest');
    types.EquipSkinReply = _lookup('gamepb.skinpb.EquipReply');
    types.EquipSkinPartRequest = _lookup('gamepb.skinpb.EquipSkinPartRequest');
    types.EquipSkinPartReply = _lookup('gamepb.skinpb.EquipSkinPartReply');
    types.MarkSkinAsViewedRequest = _lookup('gamepb.skinpb.MarkAsViewedRequest');
    types.MarkSkinAsViewedReply = _lookup('gamepb.skinpb.MarkAsViewedReply');
    for (const name of ['AvatarFramesOwnedRequest', 'AvatarFramesOwnedReply', 'AvatarFramesEquipedRequest', 'AvatarFramesEquipedReply']) {
        types[name] = _lookup(`gamepb.avatarframepb.${name}`);
    }
    for (const method of ['Equip', 'Unequip', 'UpdateEquip']) {
        for (const suffix of ['Request', 'Reply']) {
            types[`AvatarFrame${method}${suffix}`] = _lookup(`gamepb.avatarframepb.${method}${suffix}`);
        }
    }
    for (const method of ['ClaimSolarTerms', 'GetSolarTermsV2', 'ClaimSolarTermsV2', 'AnswerSolarTerms', 'ClaimSolarSeason']) {
        for (const suffix of ['Request', 'Reply']) types[method + suffix] = _lookup(`gamepb.solartermspb.${method}${suffix}`);
    }

    types.GetMallListBySlotTypeResponse = _lookup('gamepb.mallpb.GetMallListBySlotTypeResponse');
    types.MallGoods = _lookup('gamepb.mallpb.MallGoods');
    types.PurchaseRequest = _lookup('gamepb.mallpb.PurchaseRequest');
    types.PurchaseResponse = _lookup('gamepb.mallpb.PurchaseResponse');
    types.GetActiveMysteryNPCRequest = _lookup('gamepb.mysteryshoppb.GetActiveNPCRequest');
    types.GetActiveMysteryNPCReply = _lookup('gamepb.mysteryshoppb.GetActiveNPCReply');
    types.BuyMysteryShopRequest = _lookup('gamepb.mysteryshoppb.BuyRequest');
    types.BuyMysteryShopReply = _lookup('gamepb.mysteryshoppb.BuyReply');
    types.AbandonMysteryShopRequest = _lookup('gamepb.mysteryshoppb.AbandonRequest');
    types.AbandonMysteryShopReply = _lookup('gamepb.mysteryshoppb.AbandonReply');
    types.RefreshVipInfoRequest = _lookup('gamepb.qqvippb.RefreshVipInfoRequest');
    types.RefreshVipInfoReply = _lookup('gamepb.qqvippb.RefreshVipInfoReply');
    types.GetQQVipRewardsStatusRequest = _lookup('gamepb.qqvippb.GetQQVipRewardsStatusRequest');
    types.GetQQVipRewardsStatusReply = _lookup('gamepb.qqvippb.GetQQVipRewardsStatusReply');
    types.ClaimQQVipRewardsRequest = _lookup('gamepb.qqvippb.ClaimQQVipRewardsRequest');
    types.ClaimQQVipRewardsReply = _lookup('gamepb.qqvippb.ClaimQQVipRewardsReply');
    types.CheckCanShareRequest = _lookup('gamepb.sharepb.CheckCanShareRequest');
    types.CheckCanShareReply = _lookup('gamepb.sharepb.CheckCanShareReply');
    types.ReportShareRequest = _lookup('gamepb.sharepb.ReportShareRequest');
    types.ReportShareReply = _lookup('gamepb.sharepb.ReportShareReply');
    types.ClaimShareRewardRequest = _lookup('gamepb.sharepb.ClaimShareRewardRequest');
    types.ClaimShareRewardReply = _lookup('gamepb.sharepb.ClaimShareRewardReply');
    types.GetIllustratedListV2Request = _lookup('gamepb.illustratedpb.GetIllustratedListV2Request');
    types.GetIllustratedListV2Reply = _lookup('gamepb.illustratedpb.GetIllustratedListV2Reply');
    types.ClaimAllRewardsV2Request = _lookup('gamepb.illustratedpb.ClaimAllRewardsV2Request');
    types.ClaimAllRewardsV2Reply = _lookup('gamepb.illustratedpb.ClaimAllRewardsV2Reply');
    types.CoreItem = _lookup('corepb.Item');

    // 公告 / 跑马灯（2026-11-03 纳入结构化解析，替代手写 varint）
    types.BulletinItem = _lookup('gamepb.bulletinboardpb.BulletinItem');
    types.BulletinListReply = _lookup('gamepb.bulletinboardpb.GetBulletinListReply');
    types.BulletinDetailReply = _lookup('gamepb.bulletinboardpb.GetBulletinDetailReply');
    types.BulletinDetail = _lookup('gamepb.bulletinboardpb.BulletinDetail');
    types.MarqueeReply = _lookup('gamepb.marqueepb.GetMarqueeReply');

    // 藏品（collectionpb，2026-11-03）
    types.GetCollectionsRequest = _lookup('gamepb.collectionpb.GetCollectionsRequest');
    types.GetCollectionsReply = _lookup('gamepb.collectionpb.GetCollectionsReply');
    types.CollectionInfo = _lookup('gamepb.collectionpb.CollectionInfo');
    types.CategoryDetail = _lookup('gamepb.collectionpb.CategoryDetail');
    types.UpgradeCollectionRequest = _lookup('gamepb.collectionpb.UpgradeCollectionRequest');
    types.UpgradeCollectionReply = _lookup('gamepb.collectionpb.UpgradeCollectionReply');
    types.ClaimCollectionRewardRequest = _lookup('gamepb.collectionpb.ClaimCollectionRewardRequest');
    types.ClaimCollectionRewardReply = _lookup('gamepb.collectionpb.ClaimCollectionRewardReply');
    types.SwitchSceneDisplayRequest = _lookup('gamepb.collectionpb.SwitchSceneDisplayRequest');
    types.SwitchSceneDisplayReply = _lookup('gamepb.collectionpb.SwitchSceneDisplayReply');

    // 活动
    types.ActivityGetGroupRequest = _lookup('gamepb.activitypb.GetGroupRequest');
    types.ActivityGetGroupReply = _lookup('gamepb.activitypb.GetGroupReply');
    types.ActivityOperateRequest = _lookup('gamepb.activitypb.OperateRequest');
    types.ActivityOperateReply = _lookup('gamepb.activitypb.OperateReply');
    types.ActivityRandomShopInfo = _lookup('gamepb.activitypb.RandomShopInfo');
    types.ActivityExchangeShopInfo = _lookup('gamepb.activitypb.ExchangeShopInfo');
    types.ActivityExchangeShopOperateParams = _lookup('gamepb.activitypb.ExchangeShopOperateParams');
    types.ActivityDrawInfo = _lookup('gamepb.activitypb.DrawInfo');
    types.ActivityDrawResult = _lookup('gamepb.activitypb.DrawResult');
    types.ActivityQingmeiClaimParams = _lookup('gamepb.activitypb.QingmeiClaimParams');
    types.ActivityQingmeiWineStartParams = _lookup('gamepb.activitypb.QingmeiWineStartParams');
    types.ActivityQingmeiWineBrewParams = _lookup('gamepb.activitypb.QingmeiWineBrewParams');
    types.ActivityQingmeiWineSellParams = _lookup('gamepb.activitypb.QingmeiWineSellParams');
    types.ActivityQingmeiPreviewResult = _lookup('gamepb.activitypb.QingmeiPreviewResult');
    types.ActivityQingmeiBrewResult = _lookup('gamepb.activitypb.QingmeiBrewResult');
    types.ActivityQingmeiSellResult = _lookup('gamepb.activitypb.QingmeiSellResult');
    types.ActivityQingmeiClaimResult = _lookup('gamepb.activitypb.QingmeiClaimResult');
    types.ActivityActivityInfo = _lookup('gamepb.activitypb.ActivityInfo');
    types.ActivityListRequest = _lookup('gamepb.activitypb.ListRequest');
    types.ActivityListReply = _lookup('gamepb.activitypb.ListReply');
    for (const name of ['MugeListReply', 'MugeOperateRequest', 'MugeOperateReply']) {
        types[name] = _lookup(`gamepb.activitypb.${name}`);
    }
    types.ActivityStarRecordInfo = _lookup('gamepb.activitypb.StarRecordInfo');
    types.ActivityStarRecordClaimResult = _lookup('gamepb.activitypb.StarRecordClaimResult');
    types.ActivityQixiGiftParams = _lookup('gamepb.activitypb.QixiGiftParams');
    types.ActivityQixiBridgeInfo = _lookup('gamepb.activitypb.QixiBridgeInfo');
    types.ActivityQixiBridgeStage = _lookup('gamepb.activitypb.QixiBridgeStage');
    types.ActivityQixiGiftRule = _lookup('gamepb.activitypb.QixiGiftRule');
    types.ActivityQixiGiftInfo = _lookup('gamepb.activitypb.QixiGiftInfo');

    // 奶茶热销中（S4，2026-10-15 上线），来自上游 milk-tea.proto
    for (const name of [
        'ActivityBodyShop', 'ActivityBodyMilkTea', 'ActivityBodyGrowthFund',
        'MilkTeaActivitySummary', 'MilkTeaShopView', 'MilkTeaSlotView', 'MilkTeaRecipeView',
        'MilkTeaMyShift', 'MilkTeaWageSlip', 'MilkTeaHireFriend',
        'MilkTeaOperateRequest', 'MilkTeaOperateReply',
        'MilkTeaGetShopRsp', 'MilkTeaGetWorkshopRsp', 'MilkTeaGetHireListRsp',
        'MilkTeaGetWorkPageRsp', 'MilkTeaGetRankRsp', 'MilkTeaGetSalesLogRsp',
        'MilkTeaHireRsp', 'MilkTeaClaimCashierRsp', 'MilkTeaBoostRsp',
        'MilkTeaUpgradeRsp', 'MilkTeaCraftRsp', 'MilkTeaClaimWagesRsp',
        'MilkTeaInteractRsp', 'MilkTeaCreateShopRsp', 'MilkTeaSetHireDisableRsp',
        // 独立解码 schema：绕开 ActivityNode.head(ActivityInfo 无 settle_start_time)
        // 与 exchange_shop=102 的形状冲突，见 activitypb.proto 末尾注释。
        'MilkTeaActivityHead', 'MilkTeaNode', 'MilkTeaGroup', 'MilkTeaGetGroupReply',
    ]) {
        types[name] = _lookup(`gamepb.activitypb.${name}`);
    }

    // 萌宠日记（S3）操作协议，来自官方小程序 1.14.0.1 编码器
    for (const name of ['PetDiaryOperateRequest', 'PetDiaryOperateReply', 'PetDiaryGetGroupReply']) {
        types[name] = _lookup(`gamepb.activitypb.${name}`);
    }
    types.ActivityBodyPetDiary = _lookup('gamepb.activitypb.ActivityBodyPetDiary');
    types.ActivityPetDiaryPhotoWall = _lookup('gamepb.activitypb.PetDiaryPhotoWall');
    types.ActivityPetDiaryPhotoEntry = _lookup('gamepb.activitypb.PetDiaryPhotoEntry');

    // 天气
    types.GetWeatherStatusRequest = _lookup('gamepb.weatherpb.GetWeatherStatusRequest');
    types.GetWeatherStatusReply = _lookup('gamepb.weatherpb.GetWeatherStatusReply');

    // 好友
    types.GetAllFriendsRequest = _lookup('gamepb.friendpb.GetAllRequest');
    types.GetAllFriendsReply = _lookup('gamepb.friendpb.GetAllReply');
    types.GetApplicationsRequest = _lookup('gamepb.friendpb.GetApplicationsRequest');
    types.GetApplicationsReply = _lookup('gamepb.friendpb.GetApplicationsReply');
    types.AcceptFriendsRequest = _lookup('gamepb.friendpb.AcceptFriendsRequest');
    types.AcceptFriendsReply = _lookup('gamepb.friendpb.AcceptFriendsReply');
    types.SyncAllFriendsRequest = _lookup('gamepb.friendpb.SyncAllRequest');
    types.SyncAllFriendsReply = _lookup('gamepb.friendpb.SyncAllReply');
    types.GetGameFriendsRequest = _lookup('gamepb.friendpb.GetGameFriendsRequest');
    types.DelFriendRequest = _lookup('gamepb.friendpb.DelFriendRequest');
    types.DelFriendReply = _lookup('gamepb.friendpb.DelFriendReply');

    // 访问
    types.VisitEnterRequest = _lookup('gamepb.visitpb.EnterRequest');
    types.VisitEnterReply = _lookup('gamepb.visitpb.EnterReply');
    types.VisitLeaveRequest = _lookup('gamepb.visitpb.LeaveRequest');
    types.VisitLeaveReply = _lookup('gamepb.visitpb.LeaveReply');
    types.BriefDogInfo = _lookup('gamepb.visitpb.BriefDogInfo');

    // 护主犬 / 比熊技能赠礼（dogpb）
    types.GetDogInfoRequest = _lookup('gamepb.dogpb.GetDogInfoRequest');
    types.GetDogInfoReply = _lookup('gamepb.dogpb.GetDogInfoReply');
    types.ClaimSkillGiftsRequest = _lookup('gamepb.dogpb.ClaimSkillGiftsRequest');
    types.ClaimSkillGiftsReply = _lookup('gamepb.dogpb.ClaimSkillGiftsReply');
    types.PendingGiftCountNotify = _lookup('gamepb.dogpb.PendingGiftCountNotify');
    types.DeployDogRequest = _lookup('gamepb.dogpb.DeployDogRequest');
    types.DeployDogReply = _lookup('gamepb.dogpb.DeployDogReply');
    types.WithdrawDogRequest = _lookup('gamepb.dogpb.WithdrawDogRequest');
    types.WithdrawDogReply = _lookup('gamepb.dogpb.WithdrawDogReply');
    types.AddFoodRequest = _lookup('gamepb.dogpb.AddFoodRequest');
    types.AddFoodReply = _lookup('gamepb.dogpb.AddFoodReply');
    types.ActivateDogRequest = _lookup('gamepb.dogpb.ActivateDogRequest');
    types.ActivateDogReply = _lookup('gamepb.dogpb.ActivateDogReply');
    types.GetProtectLogsRequest = _lookup('gamepb.dogpb.GetProtectLogsRequest');
    types.GetProtectLogsReply = _lookup('gamepb.dogpb.GetProtectLogsReply');


    // 任务
    types.TaskInfoRequest = _lookup('gamepb.taskpb.TaskInfoRequest');
    types.TaskInfoReply = _lookup('gamepb.taskpb.TaskInfoReply');
    types.ClaimTaskRewardRequest = _lookup('gamepb.taskpb.ClaimTaskRewardRequest');
    types.ClaimTaskRewardReply = _lookup('gamepb.taskpb.ClaimTaskRewardReply');
    types.BatchClaimTaskRewardRequest = _lookup('gamepb.taskpb.BatchClaimTaskRewardRequest');
    types.BatchClaimTaskRewardReply = _lookup('gamepb.taskpb.BatchClaimTaskRewardReply');
    types.ClaimDailyRewardRequest = _lookup('gamepb.taskpb.ClaimDailyRewardRequest');
    types.ClaimDailyRewardReply = _lookup('gamepb.taskpb.ClaimDailyRewardReply');

    // 邮箱
    types.GetEmailListRequest = _lookup('gamepb.emailpb.GetEmailListRequest');
    types.GetEmailListReply = _lookup('gamepb.emailpb.GetEmailListReply');
    types.ClaimEmailRequest = _lookup('gamepb.emailpb.ClaimEmailRequest');
    types.ClaimEmailReply = _lookup('gamepb.emailpb.ClaimEmailReply');
    types.BatchClaimEmailRequest = _lookup('gamepb.emailpb.BatchClaimEmailRequest');
    types.BatchClaimEmailReply = _lookup('gamepb.emailpb.BatchClaimEmailReply');

    // 服务器推送通知
    types.LandsNotify = _lookup('gamepb.plantpb.LandsNotify');
    types.BasicNotify = _lookup('gamepb.userpb.BasicNotify');
    types.KickoutNotify = _lookup('gatepb.KickoutNotify');
    types.FriendApplicationReceivedNotify = _lookup('gamepb.friendpb.FriendApplicationReceivedNotify');
    types.FriendAddedNotify = _lookup('gamepb.friendpb.FriendAddedNotify');
    types.InteractRecordsRequest = _lookup('gamepb.interactpb.InteractRecordsRequest');
    types.InteractRecordsReply = _lookup('gamepb.interactpb.InteractRecordsReply');
    types.ItemNotify = _lookup('gamepb.itempb.ItemNotify');
    types.GoodsUnlockNotify = _lookup('gamepb.shoppb.GoodsUnlockNotify');
    types.TaskInfoNotify = _lookup('gamepb.taskpb.TaskInfoNotify');

    // Proto 加载完成
    log('系统', 'Protobuf 定义加载完成');
    if (protoReadyResolve) protoReadyResolve(true);
}

function getRoot() {
    return root;
}

async function waitForProtoReady() {
    if (root) return true;
    await getProtoReadyPromise();
    return true;
}

module.exports = { loadProto, types, getRoot, waitForProtoReady };
