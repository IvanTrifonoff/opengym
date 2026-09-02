// api/demo-scope.js — изоляция демо-клонов (DEMO_MODE=1, demo.gym.trfnv.ru).
//
// Демо-админ (admin.demo_session) видит ТОЛЬКО объекты своей сессии: своих
// сотрудников, свой филиал, свои правила/награды и своих атлетов — чтобы
// два параллельных посетителя демо не видели клоны друг друга. На проде
// (DEMO_MODE выключен) все функции возвращают данные без изменений.
//
// Демо-владелец — обычный owner в своей сессии, поэтому фильтрация нужна
// именно на уровне списков/записей (owner-скоуп «всё» здесь неприменим).
export const demoModeOn = () => process.env.DEMO_MODE === '1';
export const demoBranchOf = sid => 'demo-' + sid;
export const demoOwnerOf = sid => 'demo-owner-' + sid;
export const isDemoAdmin = admin => demoModeOn() && !!(admin && admin.demo_session);

// Сотрудники (admin_users: owner + тренеры сессии).
export const scopeAdmins = (admin, rows) =>
  isDemoAdmin(admin) ? rows.filter(r => r.demo_session === admin.demo_session) : rows;
// Филиалы: демо-владелец видит только филиал своего клона.
export const scopeBranches = (admin, rows) =>
  isDemoAdmin(admin) ? rows.filter(r => r.id === demoBranchOf(admin.demo_session)) : rows;
// Правила/награды: созданы демо-владельцем сессии (created_by).
export const scopeOwnerRows = (admin, rows) =>
  isDemoAdmin(admin) ? rows.filter(r => r.created_by === demoOwnerOf(admin.demo_session)) : rows;
// Атлеты (db.users): только своей сессии.
export const scopeUsers = (admin, users) =>
  isDemoAdmin(admin) ? users.filter(u => u.demo_session === admin.demo_session) : users;
