'use strict';

const fs = require('node:fs');
const { getDataFile } = require('../config/runtime-paths');

const HOLD_FILE = 'account-maintenance-hold.json';

// Deployment control only: do not modify account credentials or operation ledgers.
// A malformed/unreadable hold fails closed; absence is the ordinary runtime mode.
function isAccountMaintenanceHeld(accountId) {
    const file = getDataFile(HOLD_FILE);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
        if (error.code === 'ENOENT') return false;
        return true;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return true;
    try {
        const hold = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (hold.schemaVersion !== 1 || hold.held !== true || !Array.isArray(hold.accountIds)
            || !hold.accountIds.length || hold.accountIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) return true;
        return hold.accountIds.includes(String(accountId));
    } catch { return true; }
}

module.exports = { HOLD_FILE, isAccountMaintenanceHeld };
