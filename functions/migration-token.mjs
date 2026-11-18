// 灌数口子的一次性口令。主站这一份永远是 null —— 也就是主站上 migration-import-rows
// 一律回 migration_disabled，导出不会被反向使用。
// 只有 `node dev/build-backup-site.mjs --with-import` 会把这一行换成随机口令写进备用站那一棵树，
// 灌完数再发一版顾客版构建，这个动作随构建一起消失。口令不进版本库，只出现在那次构建的输出里。
export const MIGRATION_TOKEN = null;
