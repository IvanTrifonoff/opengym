// api/routes/loyalty.js — программа лояльности: кошелёк, награды, редемпшны, правила.
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
// Вынесено из монолита server.js — поведение идентично (импорт, не копия).
// Два контура:
//   - спортсмен: кошелёк/награды/погашение (readSession)
//   - админ: управление наградами/редемпшнами/правилами (requireAdminAccount)
// Демо-скоуп (DEMO_MODE=1): админ-списки правил/наград фильтруются по
// demo_session (созданы демо-владельцем сессии) — см. demo-scope.js.
import { scopeOwnerRows } from '../demo-scope.js';
export function createLoyaltyRoutes(deps) {
  const {
    json, readBody, readSession, requireAdminAccount,
    getWallet, listRewards, redeemReward,
    saveReward, deleteReward, listRedemptions, updateRedemption,
    listLoyaltyRules, saveLoyaltyRule, deleteLoyaltyRule
  } = deps;

  return [
    // Спортсмен: баланс баллов и активный стрик.
    {
      method: 'GET',
      path: '/api/loyalty/wallet',
      handler: async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        try { json(res, 200, await getWallet(user.id)); }
        catch (error) { console.error('wallet failed:', error.message); json(res, 503, { error: 'loyalty database unavailable' }); }
      }
    },

    // Спортсмен: список доступных наград (только активные, с остатком).
    // На проде скрываем demo-награды (созданы demo-owner-*), даже если они
    // случайно попали в прод-БД — их не должно быть видно спортсменам.
    {
      method: 'GET',
      path: '/api/loyalty/rewards',
      handler: async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        try {
          const all = await listRewards(true);
          const rewards = all.filter(r => !String(r.created_by || '').startsWith('demo-owner-'));
          json(res, 200, { rewards });
        }
        catch (error) { console.error('rewards failed:', error.message); json(res, 503, { error: 'loyalty database unavailable' }); }
      }
    },

    // Спортсмен: погасить награду — транзакция списывает баллы,
    // auto_code выдаёт код сразу, staff — заявка для выдачи тренером.
    {
      method: 'POST',
      path: '/api/loyalty/redeem',
      handler: async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        const body = await readBody(req);
        try { json(res, 200, { ok: true, redemption: await redeemReward({ userId: user.id, rewardId: String(body.reward_id || '') }) }); }
        catch (error) { json(res, 400, { error: error.message }); }
      }
    },

    // Админ: все награды (включая скрытые) для управления
    // (в демо — только награды своего клона).
    {
      method: 'GET',
      path: '/api/admin/loyalty/rewards',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res); if (!admin) return;
        json(res, 200, { rewards: scopeOwnerRows(admin, await listRewards(false)) });
      }
    },

    // Админ (owner/manager): создать/обновить награду.
    {
      method: 'POST',
      path: '/api/admin/loyalty/rewards/save',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
        const body = await readBody(req);
        try {
          const reward = await saveReward({ id: body.id, name: body.name, description: body.description, kind: body.kind,
            cost: body.cost, deliveryMode: body.delivery_mode, active: body.active, stock: body.stock, createdBy: admin.id });
          json(res, 200, { ok: true, reward });
        } catch (error) { json(res, 400, { error: error.message }); }
      }
    },

    // Админ (owner/manager): удалить награду.
    {
      method: 'POST',
      path: '/api/admin/loyalty/rewards/delete',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
        try { await deleteReward(String((await readBody(req)).id || '')); json(res, 200, { ok: true }); }
        catch (error) { json(res, 400, { error: error.message }); }
      }
    },

    // Админ: все заявки на погашение (для выдачи на ресепшене).
    {
      method: 'GET',
      path: '/api/admin/loyalty/redemptions',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res); if (!admin) return;
        try { json(res, 200, { redemptions: await listRedemptions() }); }
        catch (error) { json(res, 503, { error: 'loyalty database unavailable' }); }
      }
    },

    // Админ: сменить статус выдачи (в т.ч. fulfilled/refunded).
    {
      method: 'POST',
      path: '/api/admin/loyalty/redemptions/update',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res); if (!admin) return;
        const body = await readBody(req);
        try { json(res, 200, { ok: true, redemption: await updateRedemption({ id: body.id, status: body.status, adminId: admin.id, note: body.note }) }); }
        catch (error) { json(res, 400, { error: error.message }); }
      }
    },

    // Админ: правила начисления баллов (в демо — только правила своего клона).
    {
      method: 'GET',
      path: '/api/admin/loyalty/rules',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res); if (!admin) return;
        json(res, 200, { rules: scopeOwnerRows(admin, await listLoyaltyRules()) });
      }
    },

    // Админ (owner/manager): создать/обновить правило.
    {
      method: 'POST',
      path: '/api/admin/loyalty/rules/save',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
        const body = await readBody(req);
        try {
          const rule = await saveLoyaltyRule({ id: body.id, name: body.name, eventType: body.event_type, enabled: body.enabled, conditions: body.conditions, actions: body.actions, limits: body.limits, createdBy: admin.id });
          json(res, 200, { ok: true, rule });
        } catch (error) { json(res, 400, { error: error.message }); }
      }
    },

    // Админ (owner/manager): удалить правило.
    {
      method: 'POST',
      path: '/api/admin/loyalty/rules/delete',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
        const body = await readBody(req);
        try { await deleteLoyaltyRule(String(body.id || '')); json(res, 200, { ok: true }); }
        catch (error) { json(res, 400, { error: error.message }); }
      }
    }
  ];
}