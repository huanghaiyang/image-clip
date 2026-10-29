/**
 * 音频工具库
 * ----------
 * 全部基于 Web Audio API，不依赖服务端：
 *  - 峰值 / 波形：用于时间轴下方的波形绘制；
 *  - 频谱：解码后离线计算一张「时间 × 频段」的频谱图（FFT），供舞台直接铺在时间轴上；
 *  - 裁剪：按时间区间切出新的 AudioBuffer；
 *  - WAV 编码：PCM16 单文件写入，保存到资源库。
 *
 * 这里只放纯计算与编码，播放状态（AudioContext / 播放头）由 useAudio 管理。
 */

/** 秒 → mm:ss.mmm（音频面板需要毫秒级精度）。 */
export function formatAudioTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const total = Math.floor(value);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const ms = Math.floor((value - total) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** 秒 → 01:23（刻度标签，不需要毫秒）。 */
export function formatAudioClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 多声道取平均，得到分析用的单声道数据。 */
export function downmix(audioBuffer) {
  const length = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

/**
 * 峰值降采样：把样本分成 buckets 段，每段记录最小/最大值，
 * 绘制波形时按像素宽度取样即可（比逐样本画快得多）。
 */
export function computeWaveform(audioBuffer, buckets = 1600) {
  const mono = downmix(audioBuffer);
  const count = Math.max(1, Math.min(buckets, mono.length));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const step = mono.length / count;
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * step);
    const to = Math.min(mono.length, Math.floor((i + 1) * step));
    let lo = 0;
    let hi = 0;
    for (let j = from; j < to; j += 1) {
      const v = mono[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max };
}

/**
 * 原地 radix-2 FFT（长度必须是 2 的幂）。
 * 只用于离线频谱计算，不追求极致性能。
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const aRe = re[i + j];
        const aIm = im[i + j];
        const bRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const bIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = aRe + bRe;
        im[i + j] = aIm + bIm;
        re[i + j + len / 2] = aRe - bRe;
        im[i + j + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

const FREQ_MIN_HZ = 45;

/**
 * 离线频谱图：在时间轴上均匀取 columns 个窗口做 FFT，聚合成 bands 个频段。
 * 返回的 data 是 Uint8Array(columns * bands)，band 0 为最低频段，数值 0~255。
 *
 * 频段按对数分布（低频更细、高频更粗），符合人耳感知，也避免整张图都挤在底部。
 */
export function computeSpectrogram(audioBuffer, { columns = 360, fftSize = 1024, bands = 96 } = {}) {
  const mono = downmix(audioBuffer);
  const sampleRate = audioBuffer.sampleRate;
  const length = mono.length;
  if (!length) return null;

  const cols = Math.max(1, Math.min(columns, Math.ceil(length / 16)));
  const binCount = fftSize / 2;
  const nyquist = sampleRate / 2;
  const hann = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const data = new Uint8Array(cols * bands);
  const step = length / cols;

  // 频段边界（Hz → bin），预先算好避免每列重复开方
  const edges = new Int32Array(bands + 1);
  for (let b = 0; b <= bands; b += 1) {
    const hz = FREQ_MIN_HZ * Math.pow(nyquist / FREQ_MIN_HZ, b / bands);
    edges[b] = Math.min(binCount - 1, Math.max(0, Math.round((hz / nyquist) * binCount)));
  }

  for (let col = 0; col < cols; col += 1) {
    const center = Math.floor(col * step + step / 2);
    const start = Math.max(0, Math.min(length - fftSize, center - fftSize / 2));
    for (let i = 0; i < fftSize; i += 1) {
      const sample = start + i < length ? mono[start + i] : 0;
      re[i] = sample * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b += 1) {
      const from = edges[b];
      const to = Math.max(from + 1, edges[b + 1]);
      let peak = 0;
      for (let bin = from; bin <= to && bin < binCount; bin += 1) {
        const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
        if (mag > peak) peak = mag;
      }
      // -70dB ~ -5dB 映射到 0~255；窗口归一化后再取对数，避免响度差异过大
      const db = 20 * Math.log10(peak / fftSize + 1e-8);
      const normalized = Math.max(0, Math.min(1, (db + 70) / 65));
      data[col * bands + b] = Math.round(normalized * 255);
    }
  }

  return { columns: cols, bands, data };
}

/**
 * 按时间区间裁剪 AudioBuffer（保留多声道与原采样率）。
 * AudioBuffer 构造函数在 Chrome / Edge / Safari 15+ 均可用。
 */
export function sliceBuffer(audioBuffer, start = 0, end = audioBuffer.duration) {
  const sampleRate = audioBuffer.sampleRate;
  const from = Math.max(0, Math.floor(Number(start) * sampleRate));
  const to = Math.min(audioBuffer.length, Math.ceil(Number(end) * sampleRate));
  const frames = Math.max(0, to - from);
  const out = new AudioBuffer({ length: frames, numberOfChannels: audioBuffer.numberOfChannels, sampleRate });
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch += 1) {
    out.getChannelData(ch).set(audioBuffer.getChannelData(ch).subarray(from, to));
  }
  return out;
}

/** 把 AudioBuffer 编码成 PCM16 WAV。 */
export function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let ch = 0; ch < channels; ch += 1) channelData.push(audioBuffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** 触发浏览器下载（不落资源库时使用）。 */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 稍后释放，避免点击尚未开始下载就被回收
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
