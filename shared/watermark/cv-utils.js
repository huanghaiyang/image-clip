/**
 * OpenCV.js 桥接（浏览器与 Node 通用）
 * ----------------------------------
 * 上游：opencv.js（OpenCV 5 wasm 构建，Apache-2.0），npm 包 `@techstark/opencv-js`。
 *
 * wasm 侧的 Mat 需要手工释放，否则内存会持续增长直到崩掉，所以这里提供
 * `createMatScope()`：作用域内创建的每个 Mat / MatVector 都自动登记，
 * 结束时统一 `delete()`，让调用方只用关心算法本身。
 */

/**
 * 某些构建里模块本身是 thenable（`await cv` 之后才拿到 Mat/inpaint/dft…），
 * 这里统一成「一定是初始化完成的模块」。
 */
export async function loadOpenCv(moduleOrNamespace) {
  const candidate = moduleOrNamespace?.default ?? moduleOrNamespace;
  if (!candidate) throw new Error('loadOpenCv: 传入的 opencv 模块为空');
  const cv = typeof candidate.then === 'function' ? await candidate : await candidate.ready ?? candidate;
  if (!cv?.Mat) throw new Error('loadOpenCv: opencv 模块尚未初始化（缺少 Mat）');
  return cv;
}

/** 在作用域里登记 Mat，退出时统一释放。 */
export function createMatScope(cv) {
  const owned = new Set();

  const track = (mat) => {
    if (mat) owned.add(mat);
    return mat;
  };

  return {
    cv,
    track,
    /** 新建一个空 Mat 并登记。 */
    mat(rows, cols, type) {
      return track(new cv.Mat(rows, cols, type));
    },
    /** 登记一个 MatVector（内部元素也要释放）。 */
    vector() {
      const v = new cv.MatVector();
      owned.add(v);
      return v;
    },
    /** 清空并释放全部资源。 */
    release() {
      for (const mat of owned) {
        try {
          mat.delete();
        } catch {
          /* 已经被释放过就忽略 */
        }
      }
      owned.clear();
    },
  };
}

/** RGBA 直通字节 → CV_8UC4 Mat（浏览器与 Node 都能用，不依赖 DOM）。 */
export function matFromRgba(scope, image) {
  const mat = scope.mat(image.height, image.width, scope.cv.CV_8UC4);
  mat.data.set(image.data);
  return mat;
}

/** CV_8UC4 / CV_8UC3 / CV_8UC1 Mat → 直通 RGBA 字节。 */
export function rgbaFromMat(scope, mat) {
  const { cv } = scope;
  const width = mat.cols;
  const height = mat.rows;
  let src = mat;
  let temp = null;
  if (mat.channels() === 1) {
    temp = scope.mat(height, width, cv.CV_8UC4);
    cv.cvtColor(mat, temp, cv.COLOR_GRAY2RGBA);
    src = temp;
  } else if (mat.channels() === 3) {
    temp = scope.mat(height, width, cv.CV_8UC4);
    cv.cvtColor(mat, temp, cv.COLOR_RGB2RGBA);
    src = temp;
  }
  return { width, height, data: new Uint8ClampedArray(src.data) };
}

/** 掩膜对象 → CV_8UC1 Mat（值 0/255）。 */
export function matFromMask(scope, mask) {
  const mat = scope.mat(mask.height, mask.width, scope.cv.CV_8UC1);
  mat.data.set(mask.data);
  return mat;
}

/** CV_8UC1 Mat → 掩膜对象。 */
export function maskFromMat(mat) {
  return { width: mat.cols, height: mat.rows, data: new Uint8Array(mat.data) };
}

/** 保证是奇数且不小于 min（结构元尺寸必须是奇数）。 */
export function oddSize(value, min = 3, max = 201) {
  let n = Math.round(Number(value) || 0);
  if (n < min) n = min;
  if (n > max) n = max;
  if (n % 2 === 0) n += 1;
  return n;
}

/**
 * 取颜色空间转换常量（如 'RGBA2RGB' → cv.COLOR_RGBA2RGB）。
 * 不同 OpenCV 构建的常量命名偶有差异，这里集中处理并给出明确报错。
 */
export function colorCode(cv, name) {
  const key = `COLOR_${name}`;
  const value = cv[key];
  if (value === undefined) throw new Error(`当前 OpenCV 构建缺少常量 ${key}`);
  return value;
}

