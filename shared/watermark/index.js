/**
 * 水印识别与去除 · 共享层
 * ---------------------
 * 这张出口表就是「同一份算法跑在浏览器与 Node」的契约：
 * mask / metrics / unblend / color 是纯 JS，detect 需要传入已初始化的 OpenCV 模块。
 */
export * from './color.js';
export * from './mask.js';
export * from './metrics.js';
export * from './unblend.js';
export * from './cv-utils.js';
export * from './detect.js';
