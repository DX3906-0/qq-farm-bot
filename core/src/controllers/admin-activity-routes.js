const {
  registerAdminHeluActivityRoutes,
} = require("./admin-helu-activity-routes");
const {
  registerAdminNanguaActivityRoutes,
} = require("./admin-nangua-activity-routes");
const { registerAdminActivityUpdateRoutes } = require('./admin-activity-update-routes');
const {
  registerAdminHonghuaActivityRoutes,
} = require("./admin-honghua-activity-routes");

function registerAdminActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
  requireAdminToken,
}) {
  const routeContext = {
    app,
    provider,
    getAccountIdFromRequest,
    canAccessAccount,
    sendProviderError,
  };

  registerAdminNanguaActivityRoutes(routeContext);
  registerAdminHeluActivityRoutes(routeContext);
  registerAdminHonghuaActivityRoutes(routeContext);
  registerAdminActivityUpdateRoutes({ app, provider, requireAdminToken });
}

module.exports = { registerAdminActivityRoutes };
