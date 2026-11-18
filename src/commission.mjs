// ---------------------------------------------------------------------------
// Commission console — reads what YOUR app + partner account actually earn.
// Requires a token with the `application_read` scope (partner/app owner).
//
//   node main.mjs commission [--from YYYY-MM-DD --to YYYY-MM-DD]
//
// Revenue channels reported:
//   1. App markup (up to 3% of potential payout on every contract traded
//      through your app_id)  -> /applications/v1/markup-statistics
//   2. Partner revenue share (40% of Deriv's revenue from tagged clients'
//      options activity, + tier boost) -> /partners/analytics/v1/overview
// ---------------------------------------------------------------------------
import { api } from './client.mjs';

export async function commissionCommand(cfg, opts = {}) {
  const token = process.env.DERIV_PARTNER_TOKEN || cfg.token;
  const appId = cfg.app_id;
  if (!token) throw new Error('set DERIV_PARTNER_TOKEN (application_read scope) or token in config');
  const to = opts.to ?? new Date().toISOString().slice(0, 10);
  const from = opts.from ?? new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);

  console.log(`\n================ COMMISSION REPORT ${from} -> ${to} ================`);
  try {
    const mk = await api.markupStatistics(token, appId, from, to);
    const d = mk.data;
    console.log('\n[1] APP MARKUP (per-contract commission on trades via your app)');
    console.log(`  markup earned : $${d.total_app_markup_usd.toFixed(2)}`);
    console.log(`  client volume : $${d.total_volume_usd.toFixed(2)} (buy prices)`);
    console.log(`  total payouts : $${d.total_payout_usd.toFixed(2)} (potential)`);
    console.log(`  contracts     : ${d.total_contract_count}   distinct clients: ${d.total_client_count}`);
    for (const app of d.breakdown ?? []) {
      console.log(`   - app ${app.app_id}: $${app.app_markup_usd.toFixed(2)} markup | ${app.contract_count} contracts | ${app.client_count} clients`);
    }
    if (d.total_payout_usd > 0)
      console.log(`  effective markup rate: ${(100 * d.total_app_markup_usd / d.total_payout_usd).toFixed(2)}% of potential payout`);
  } catch (e) { console.log('  markup statistics unavailable:', e.message); }

  try {
    const ov = await api.partnerOverview(token, appId, from, to);
    console.log('\n[2] PARTNER PROGRAM (revenue share on tagged clients)');
    console.log(JSON.stringify(ov.data ?? ov, null, 2).slice(0, 2500));
  } catch (e) { console.log('  partner overview unavailable:', e.message, '(404 = account is not enrolled as a partner yet)'); }

  console.log('\nTip: verify a user is tagged to you with:');
  console.log('  POST /partners/client-tags/check  { "client_ids": ["CR123456"] }');
  console.log('Users must sign up through YOUR partner link to be tagged.\n');
}
