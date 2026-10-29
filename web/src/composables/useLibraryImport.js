/**
 * 各模块统一的「导入即入库」入口
 * --------------------------------
 * 以前图片工作区的导入只进内存素材列表；现在统一先写入资源库，
 * 再把其中的图片载入当前工作区的素材列表，所有模块共用同一份素材。
 */
import { openUploadPicker } from './useUploadPicker.js';
import { useAppMode } from './useAppMode.js';
import { useLibrary } from './useLibrary.js';

/** 上传文件到资源库；图片会自动加入当前图片工作区的素材列表。 */
export async function importFilesToLibrary(files, options = {}) {
  const list = [...(files ?? [])].filter(Boolean);
  if (!list.length) return [];

  const { state: appMode } = useAppMode();
  const { actions: libraryActions } = useLibrary();
  const uploaded = await libraryActions.uploadFiles(list, { dir: options.dir ?? '' });

  if (options.loadImages !== false) {
    const images = (uploaded ?? []).filter((entry) => entry.kind === 'image');
    if (images.length) await libraryActions.openInEditor(images, { mode: options.mode ?? appMode.mode });
  }
  return uploaded ?? [];
}

/**
 * 打开「导入图片」上传弹窗：目标固定为资源库，上传完成后自动载入当前工作区。
 * AssetPanel / 各画布的空态按钮共用，保证所有模块导入行为一致。
 */
export function pickLibraryImages(options = {}) {
  openUploadPicker({
    title: options.title ?? '导入图片',
    description: options.description ?? '图片会保存到资源库，并自动加入当前素材列表',
    accept: 'image/*',
    dest: 'library',
    dir: options.dir ?? '',
    actionLabel: options.actionLabel ?? '导入',
    onUploaded: (entries) => {
      const images = (entries ?? []).filter((entry) => entry.kind === 'image');
      // 上传弹窗已经完成入库，这里只负责把图片载入素材列表，不重复上传
      if (images.length) {
        const { state: appMode } = useAppMode();
        void useLibrary().actions.openInEditor(images, { mode: options.mode ?? appMode.mode });
      }
      options.onUploaded?.(entries);
    },
  });
}
