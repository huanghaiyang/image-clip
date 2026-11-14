/**
 * 全局指针位置（屏幕坐标）
 * ----------------------
 * 有些交互需要知道「鼠标现在停在哪」而不是等下一次 pointermove：
 * 例如刚切到橡皮擦工具时，鼠标已经在画面上了，舞台应该立刻把笔刷圆圈画出来。
 *
 * 挂在模块级别，只加一个 passive 监听，不依赖任何组件生命周期；
 * 监听器在 import 时就注册（应用启动即有），所以切换工具后仍能拿到最近一次位置。
 */
const pointer = { x: 0, y: 0, known: false };

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (event) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.known = true;
    },
    { passive: true },
  );
}

/** 最近一次指针位置；用户还没动过鼠标时返回 null。 */
export function lastPointerPosition() {
  return pointer.known ? { x: pointer.x, y: pointer.y } : null;
}
