// api/demo-scope.js — изоляция клубов/филиалов и демо-клонов.
//
// Multi-tenant (v1.3.x, Шаг 3): на проде каждый скоуп-фильтр учитывает
// club_id/филиал вызывающего админа:
//   · superadmin (владелец платформы) — видит всё;
//   · owner (владелец клуба) — только свой клуб (club_id);
//   · manager — только свой филиал (branch_key), без него — свой клуб;
//   · trainer/operator — только свой клуб.
// Демо-админ (admin.demo_session) видит ТОЛЬКО объекты своей сессии —
// чтобы параллельные посетители demo.gym.trfnv.ru не видели клоны друг
// друга и реальные данные. Фильтрация по demo_session применяется первой.
//
// СТРОГО: роль owner/manager с пустым club_id НЕ получает «всю сеть» —
// такие аккаунты отсекаются в requireAdminAccount (403), а здесь — на
// всякий случай возвращается пустой список.
export const demoModeOn = () => process.env.DEMO_MODE === '1';
export const demoBranchOf = sid => 'demo-' + sid;
export const demoOwnerOf = sid => 'demo-owner-' + sid;
export const isDemoAdmin = admin => demoModeOn() && !!(admin && admin.demo_session);

// Сотрудники (admin_users): супер-админ видит всех (кроме демо-строк);
// остальные — только сотрудников СВОЕГО клуба (club_id). Это закрывает
// «новосозданный менеджер видит всех сотрудников» (v1.3.x).
export const scopeAdmins = (admin, rows) => {
  if (isDemoAdmin(admin)) return rows.filter(r => r.demo_session === admin.demo_session);
  const prod = rows.filter(r => !r.demo_session);
  if (admin.role === 'superadmin') return prod;
  if (!admin.club_id) return [];   // strict: нет клуба — пусто, не «всё»
  return prod.filter(r => r.club_id === admin.club_id);
};
// Филиалы: демо-владелец — филиал клона; супер-админ — все;
// owner/тренер/оператор — филиалы своего клуба; manager — только свой филиал.
export const scopeBranches = (admin, rows) => {
  if (isDemoAdmin(admin)) return rows.filter(r => r.id === demoBranchOf(admin.demo_session));
  const prod = rows.filter(r => !r.demo_session);
  if (admin.role === 'superadmin') return prod;
  if (!admin.club_id) return [];   // strict: нет клуба — пусто
  if (admin.role === 'manager' && admin.branch_key) return prod.filter(r => r.id === admin.branch_key);
  return prod.filter(r => r.club_id === admin.club_id);
};
// Правила/награды: демо-владелец — свои (created_by); супер-админ — все;
// owner/manager/тренер/оператор — только строки, созданные сотрудниками
// СВОЕГО клуба. Список сотрудников клуба передаётся staffIds (Set админ-id),
// чтобы не делать лишний запрос: вызывающий считает его через scopeAdmins.
export const scopeOwnerRows = (admin, rows, staffIds) => {
  if (isDemoAdmin(admin)) return rows.filter(r => r.created_by === demoOwnerOf(admin.demo_session));
  const prod = rows.filter(r => !String(r.created_by || '').startsWith('demo-owner-'));
  if (admin.role === 'superadmin') return prod;
  if (!admin.club_id) return [];   // strict: нет клуба — пусто
  if (staffIds) return prod.filter(r => staffIds.has(r.created_by));
  return prod;
};
// Атлеты (db.users): демо — своей сессии; супер-админ — все;
// owner/manager/тренер/оператор — только атлетов своего клуба (club_id),
// manager дополнительно сужает до своего филиала, если branch_key задан.
export const scopeUsers = (admin, users) => {
  if (isDemoAdmin(admin)) return users.filter(u => u.demo_session === admin.demo_session);
  const prod = users.filter(u => !u.demo_session);
  if (admin.role === 'superadmin') return prod;
  if (!admin.club_id) return [];   // strict: нет клуба — пусто
  const club = prod.filter(u => u.club_id === admin.club_id);
  if (admin.role === 'manager' && admin.branch_key) {
    // СТРОГО: менеджер видит только атлетов своего филиала. Атлеты без
    // branch_key (гости/приватный режим) ему не видны — пусть лучше пусто,
    // чем чужие данные.
    return club.filter(u => u.branch_key === admin.branch_key);
  }
  return club;
};
