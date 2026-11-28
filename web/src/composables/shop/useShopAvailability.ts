interface ShopAvailabilityContext {
  currentLevel: () => number
  currentGold: () => number
  currentCoupon: () => number
  userGoldBean: () => number
}

const L = {
  soldOutSeed: '\u8BE5\u79CD\u5B50\u5F53\u524D\u5DF2\u552E\u7F44\u3002',
  soldOutPet: '\u8BE5\u5BA0\u7269\u5F53\u524D\u5DF2\u552E\u7F44\u3002',
  soldOutMall: '\u8BE5\u9053\u5177\u5F53\u524D\u5DF2\u552E\u7F44\u3002',
  levelRequired: (level: number) => `\u8FBE\u5230 ${level} \u7EA7\u540E\u53EF\u8D2D\u4E70\u3002`,
  goldInsufficient: '\u5F53\u524D\u91D1\u5E01\u4E0D\u8DB3\u3002',
  goldBeanInsufficient: '\u5F53\u524D\u91D1\u8C46\u8C46\u4E0D\u8DB3\u3002',
  couponInsufficient: '\u5F53\u524D\u70B9\u5238\u4E0D\u8DB3\u3002',
  canBuyHint: '\u6761\u4EF6\u6EE1\u8DB3\uFF0C\u53EF\u76F4\u63A5\u8D2D\u4E70\u3002',
  unavailable: '\u5F53\u524D\u4E0D\u5F00\u653E\u8D2D\u4E70\u3002',
  decorationHint: '购买后可在个人装扮页查看，面板不会自动替换当前穿戴。',
  notListed: '尚未上架',
  notListedHint: '服务器当前未将牧草种子列入种子商店；上架后显示实际售价。',
  unverified: '信息待确认',
  unverifiedHint: '商品价格、内容或购买状态尚未确认，请刷新核对。',
  owned: '已拥有',
  ownedHint: '已拥有该商品，无需重复购买。',
  expired: '已下架',
  expiredHint: '商品售卖时间已结束。',
  unknown: '结果待核对',
  unknownHint: '上次购买结果未确认，请只刷新核对，不要重复提交。',
  freeHint: '\u53EF\u76F4\u63A5\u514D\u8D39\u9886\u53D6\u3002',
  locked: '\u672A\u89E3\u9501',
  soldOut: '\u5DF2\u552E\u7F44',
  levelLow: '\u7B49\u7EA7\u4E0D\u8DB3',
  goldLow: '\u91D1\u5E01\u4E0D\u8DB3',
  goldBeanLow: '\u91D1\u8C46\u8C46\u4E0D\u8DB3',
  couponLow: '\u70B9\u5238\u4E0D\u8DB3',
  canBuy: '\u53EF\u8D2D\u4E70',
  notOpen: '\u6682\u672A\u5F00\u653E',
  notBuyable: '\u6682\u4E0D\u53EF\u4E70',
  canClaimFree: '\u53EF\u514D\u8D39\u9886',
}

function priceOf(item: any) {
  return Number(item?.price || 0)
}

export function createShopAvailability(context: ShopAvailabilityContext) {
  function canAffordGoods(item: any) {
    if (item?.catalogOnly || item?.priceKnown === false || item?.currencyKnown === false || item?.resultUnknown || item?.price === null || item?.expired) return false
    if (item?.isGoldenBean)
      return context.userGoldBean() >= priceOf(item)
    return context.currentGold() >= priceOf(item)
  }

  function canAffordDecoration(item: any) {
    if (item?.priceKnown !== true || item?.currencyKnown !== true || item.price == null)
      return false
    const price = Number(item.price)
    if (!Number.isSafeInteger(price) || price < 0) return false
    if (Number(item.currencyId) === 1001) return context.currentGold() >= price
    if (Number(item.currencyId) === 1002) return context.currentCoupon() >= price
    if (Number(item.currencyId) === 1005) return context.userGoldBean() >= price
    return false
  }

  function canAffordMall(item: any) {
    if (item?.isFree)
      return true
    return context.currentCoupon() >= priceOf(item)
  }

  function getSeedHint(item: any) {
    if (item.resultUnknown) return '上次购买结果未确认，请核对背包，不要重复购买。'
    if (item.catalogOnly || item.availability === 'not_listed') return L.notListedHint
    if (item.expired) return L.expiredHint
    if (item.currencyKnown === false) return item.unavailableReason || '种子商品已列出，但扣费币种尚未确认，请暂勿购买。'
    if (item.priceKnown === false || item.contentKnown === false || item.availability === 'unverified') return L.unverifiedHint
    if (!item.unlocked) return L.unavailable
    if (item.isSoldOut)
      return L.soldOutSeed
    if (context.currentLevel() < item.requiredLevel)
      return L.levelRequired(item.requiredLevel)
    if (!canAffordGoods(item))
      return L.goldInsufficient
    return L.canBuyHint
  }

  function getPetHint(item: any) {
    if (item.isSoldOut)
      return L.soldOutPet
    if (context.currentLevel() < item.requiredLevel)
      return L.levelRequired(item.requiredLevel)
    if (!canAffordGoods(item))
      return item.isGoldenBean ? L.goldBeanInsufficient : L.goldInsufficient
    return L.canBuyHint
  }

  function getDecorationHint(item: any) {
    if (item.resultUnknown) return L.unknownHint
    if (item.owned) return L.ownedHint
    if (item.expired) return L.expiredHint
    if (item.isSoldOut) return L.soldOutMall
    if (item.priceKnown !== true || item.currencyKnown !== true || item.contentKnown === false || item.availability === 'unverified') return L.unverifiedHint
    if (!item.unlocked || !item.canBuy) return item.unavailableReason || L.unavailable
    if (context.currentLevel() < Number(item.requiredLevel || 0)) return L.levelRequired(item.requiredLevel)
    if (!canAffordDecoration(item))
      return Number(item.currencyId) === 1001 ? L.goldInsufficient : Number(item.currencyId) === 1002 ? L.couponInsufficient : L.goldBeanInsufficient
    return item.isFree ? L.freeHint : L.decorationHint
  }

  function getMallHint(item: any) {
    if (item.isSoldOut)
      return L.soldOutMall
    if (!item.canBuy)
      return L.unavailable
    if (!canAffordMall(item))
      return L.couponInsufficient
    return item.isFree ? L.freeHint : L.canBuyHint
  }

  function getSeedStatusLabel(item: any) {
    if (item.resultUnknown) return L.unknown
    if (item.catalogOnly || item.availability === 'not_listed') return L.notListed
    if (item.expired) return L.expired
    if (item.priceKnown === false || item.currencyKnown === false || item.contentKnown === false || item.availability === 'unverified') return L.unverified
    if (!item.unlocked)
      return L.locked
    if (item.isSoldOut)
      return L.soldOut
    if (context.currentLevel() < item.requiredLevel)
      return L.levelLow
    if (!canAffordGoods(item))
      return L.goldLow
    return L.canBuy
  }

  function getPetStatusLabel(item: any) {
    if (!item.unlocked)
      return L.locked
    if (item.isSoldOut)
      return L.soldOut
    if (context.currentLevel() < item.requiredLevel)
      return L.levelLow
    if (!canAffordGoods(item))
      return item.isGoldenBean ? L.goldBeanLow : L.goldLow
    return L.canBuy
  }

  function getDecorationStatusLabel(item: any) {
    if (item.resultUnknown) return L.unknown
    if (item.owned) return L.owned
    if (item.expired) return L.expired
    if (item.isSoldOut) return L.soldOut
    if (item.priceKnown !== true || item.currencyKnown !== true || item.contentKnown === false || item.availability === 'unverified') return L.unverified
    if (!item.unlocked) return L.locked
    if (!item.canBuy) return L.notOpen
    if (context.currentLevel() < Number(item.requiredLevel || 0)) return L.levelLow
    if (!canAffordDecoration(item))
      return Number(item.currencyId) === 1001 ? L.goldLow : Number(item.currencyId) === 1002 ? L.couponLow : L.goldBeanLow
    return item.isFree ? L.canClaimFree : L.canBuy
  }

  function getMallStatusLabel(item: any) {
    if (item.isSoldOut)
      return L.soldOut
    if (!item.canBuy)
      return L.notBuyable
    if (!canAffordMall(item))
      return L.couponLow
    return item.isFree ? L.canClaimFree : L.canBuy
  }

  return {
    canAffordGoods,
    canAffordDecoration,
    canAffordMall,
    getSeedHint,
    getPetHint,
    getDecorationHint,
    getMallHint,
    getSeedStatusLabel,
    getPetStatusLabel,
    getDecorationStatusLabel,
    getMallStatusLabel,
  }
}
