/**
 * 上传文件选择器（全局单例）
 * --------------------------
 * 原生 `<input type=file>` 的对话框无法定制，和应用的深色面板风格割裂。
 * 这里改成应用内弹窗：拖拽 / 浏览选择 → 文件清单预览 → 选择目标目录 → 上传进度。
 *
 * 用法：
 *   openUploadPicker({ title, accept, dest: 'library' | 'workspace', dir, onUploaded })
 * 弹窗由 App.vue 全局挂载一次，各入口只负责传参数。
 */
import { reactive, readonly } from 'vue';

import { useAudio } from './useAudio.js';
import { useVideo } from './useVideo.js';
import { useLibrary } from './useLibrary.js';

const DEFAULTS = {
  title: '上传文件',
  description: '',
  accept: '*/*',
  multiple: true,
  /** library：上传到资源库；workspace：图片加入当前素材列表 */
  dest: 'library',
  /** null 表示资源库当前目录；'' 表示根目录 */
  dir: null,
  actionLabel: '上传',
  onUploaded: null,
};

const state = reactive({ open: false, config: { ...DEFAULTS } });

export function openUploadPicker(options = {}) {
  state.config = { ...DEFAULTS, ...options };
  state.open = true;
}

export function closeUploadPicker() {
  state.open = false;
}

/**
 * 按当前工作区打开对应的导入弹窗：
 *  - 资源库：图片 / 视频 / 音频都写到资源库；
 *  - 视频：写到资源库根目录，完成后自动选中新视频；
 *  - 音频：写到 `音频/`，完成后自动载入音频工作区；
 *  - 图片工作区：只加入左侧素材列表。
 */
export function openImportPicker(mode) {
  const { actions: videoActions } = useVideo();
  const { actions: audioActions } = useAudio();

  if (mode === 'library') {
    openUploadPicker({
      title: '上传到资源库',
      accept: 'image/*,video/*,audio/*',
      dest: 'library',
      actionLabel: '上传',
    });
    return;
  }

  if (mode === 'video') {
    openUploadPicker({
      title: '导入视频',
      description: '视频会保存到资源库根目录，上传后自动在视频工作区打开',
      accept: 'video/*',
      dest: 'library',
      dir: '',
      actionLabel: '上传',
      onUploaded: (entries) => {
        const video = entries.find((entry) => entry.kind === 'video');
        if (video) void videoActions.selectVideo(video);
      },
    });
    return;
  }

  if (mode === 'audio') {
    openUploadPicker({
      title: '导入音频',
      description: '音频会保存到资源库「音频」目录，上传后自动载入音频工作区',
      accept: 'audio/*',
      dest: 'library',
      dir: '音频',
      actionLabel: '上传',
      onUploaded: (entries) => {
        const audio = entries.find((entry) => entry.kind === 'audio');
        if (audio) void audioActions.selectAudio(audio);
      },
    });
    return;
  }

  // 图片工作区：统一先写入资源库，再自动加入左侧素材列表
  openUploadPicker({
    title: '导入图片',
    description: '图片会保存到资源库，并自动加入左侧素材列表',
    accept: 'image/*',
    dest: 'library',
    dir: '',
    actionLabel: '导入',
    onUploaded: (entries) => {
      const images = (entries ?? []).filter((entry) => entry.kind === 'image');
      if (images.length) {
        // 弹窗已完成入库，这里只负责载入素材列表，保持当前工作区不变
        void useLibrary().actions.openInEditor(images, { mode });
      }
    },
  });
}

export function useUploadPicker() {
  return {
    state: readonly(state),
    actions: { open: openUploadPicker, close: closeUploadPicker },
  };
}
