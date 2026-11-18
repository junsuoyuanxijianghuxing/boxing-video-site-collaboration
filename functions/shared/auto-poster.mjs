import { deriveUuid } from './util.mjs';
export const POSTER_FRAME_COUNT = 6;
export const POSTER_FRAME_MAX_BYTES = 512 * 1024;
export async function posterFramePath(videoId, index) {
  if (!Number.isInteger(index) || index < 0 || index >= POSTER_FRAME_COUNT) throw Error('poster_frame_invalid');
  return `poster/${await deriveUuid('boxvault-poster-frame-v1', videoId + ':' + index)}.jpg`;
}
export async function posterFramePaths(videoId) {
  return Promise.all(Array.from({ length: POSTER_FRAME_COUNT }, (_, i) => posterFramePath(videoId, i)));
}
export function isGeneratedJpeg(bytes) {
  return bytes.length > 4 && bytes.length <= POSTER_FRAME_MAX_BYTES
    && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}
