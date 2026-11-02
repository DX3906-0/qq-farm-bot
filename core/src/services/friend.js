const friendApi = require('./friend-api');
const { getOperationLimits } = require('./friend-operation-limits');
const {
  getFriendsList,
  getFriendLandsDetail,
  getFriendDogInfo,
  batchGetFriendDogInfo,
  fetchFriendsDogInfo,
} = require('./friend-land-analyzer');
const { doFriendOperation } = require('./friend-visit');
const { runGoldenBugPlacement } = require('./golden-bug-service');
const {
  checkFriends,
  runDueStealPlans,
  startFriendCheckLoop,
  stopFriendCheckLoop,
  refreshFriendCheckLoop,
  runBadOnceOnStartup,
  runBadHourly,
  isHelpExpLimitReached,
  clearFriendsListCache,
  syncFriendsFromGids,
} = require('./friend-orchestrator');

module.exports = {
  checkFriends,
  runDueStealPlans,
  startFriendCheckLoop,
  stopFriendCheckLoop,
  refreshFriendCheckLoop,
  runBadOnceOnStartup,
  runBadHourly,
  runGoldenBugPlacement,
  isHelpExpLimitReached,
  getOperationLimits,
  getFriendsList,
  getFriendLandsDetail,
  doFriendOperation,
  clearFriendsListCache,
  getFriendDogInfo,
  batchGetFriendDogInfo,
  syncFriendsFromGids,
  bootstrapQqFriendGids: friendApi.bootstrapQqFriendGids,
  fetchFriendsDogInfo,
  delFriend: friendApi.delFriend,
};
