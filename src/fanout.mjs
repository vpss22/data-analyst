// ---------------------------------------------------------------------------
// Copy-trading fan-out (hosted multi-user model).
// One signal -> the SAME contract bought for up to 100 end-user accounts in a
// single REST call: POST /trading/v1/options/contracts/bulk-purchase/{type}
//
// Each user supplies their OWN Personal Access Token (trade scope) and their
// account_id. You never pool funds; every purchase happens in the user's own
// account, and every contract carries YOUR app_id markup.
//
// users.json format: [{ "token": "<user PAT>", "account_id": "CR..." , "alias": "alice", "max_stake": 5 }]
//
// DRY RUN by default. Pass --execute to actually buy (real money if type=real).
// ---------------------------------------------------------------------------
import fs from 'fs';
import { api } from './client.mjs';

export async function fanoutCommand(cfg, opts = {}) {
  const usersFile = opts.users ?? 'users.json';
  if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, JSON.stringify([
      { alias: 'alice', token: 'USER_PAT_WITH_TRADE_SCOPE', account_id: 'CR0000001', max_stake: 5 },
      { alias: 'bob', token: 'USER_PAT_WITH_TRADE_SCOPE', account_id: 'CR0000002', max_stake: 10 },
    ], null, 2));
    console.log(`Created template ${usersFile}. Fill in real user tokens/account IDs (users generate these in Deriv > Settings > API tokens).`);
    return;
  }
  const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const type = opts.type ?? 'demo';                    // 'demo' | 'real'
  const direction = opts.direction ?? 'CALL';
  const perUserStake = (u) => Math.min(u.max_stake ?? cfg.risk.stake, cfg.risk.max_stake);

  // Per-user stake differs -> group users by stake so each bulk call is uniform.
  const groups = new Map();
  for (const u of users) {
    const s = perUserStake(u);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(u);
  }

  console.log(`\nFan-out: ${direction} ${cfg.contract.duration}${cfg.contract.duration_unit} on ${cfg.symbol} for ${users.length} users (${type})`);
  for (const [stake, group] of groups) {
    const contract_parameters = {
      contract_type: direction, underlying_symbol: cfg.symbol,
      amount: stake, basis: 'stake', currency: cfg.currency,
      duration: cfg.contract.duration, duration_unit: cfg.contract.duration_unit,
    };
    const accounts = group.map((u) => ({ token: u.token, account_id: u.account_id }));
    console.log(`\n  stake $${stake} x ${group.length} accounts: ${group.map((u) => u.alias ?? u.account_id).join(', ')}`);
    if (!opts.execute) { console.log('  DRY RUN (pass --execute to send). Payload:', JSON.stringify({ contract_parameters, accounts: accounts.map((a) => ({ ...a, token: '***' })) })); continue; }
    try {
      const r = await api.bulkPurchase(cfg.app_id, type, contract_parameters, accounts);
      const tx = r.data.transactions;
      tx.forEach((t, i) => console.log(`   ${group[i]?.alias ?? accounts[i].account_id}: ${t.error ? 'ERROR ' + JSON.stringify(t.error) : 'OK ' + JSON.stringify(t).slice(0, 160)}`));
    } catch (e) { console.log('  bulk purchase failed:', e.message); }
  }
  console.log('\nEvery filled contract accrues your app markup automatically (app_id header).');
  console.log('Monitor with: node main.mjs commission\n');
}
