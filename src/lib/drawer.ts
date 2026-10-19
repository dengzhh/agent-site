// 两个抽屉（Configure 生成器 / Chat）共用的开合约定：同时只开一个。
// 独立成模块是为了能脱离浏览器做单测（页面脚本无法在 vitest node 环境里跑）。
type DrawerEl = {
  classList: { toggle(c: string, force?: boolean): unknown };
  setAttribute(name: string, value: string): void;
};

export function openDrawer<T extends DrawerEl>(drawers: readonly T[], target: T): void {
  for (const d of drawers) {
    const open = d === target;
    d.classList.toggle('is-open', open);
    d.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
}

export function closeDrawers<T extends DrawerEl>(drawers: readonly T[]): void {
  for (const d of drawers) {
    d.classList.toggle('is-open', false);
    d.setAttribute('aria-hidden', 'true');
  }
}

// 全局 scroll-behavior: smooth 会让锚点跳转平滑滚动好几秒。打开抽屉时页面
// 本不该动——直接跳到当前位置，取消在途的平滑滚动。
export function stopScroll(win: { scrollY: number; scrollTo(opt: { top: number; left: number; behavior: 'instant' }): void }): void {
  win.scrollTo({ top: win.scrollY, left: 0, behavior: 'instant' });
}
