/** 与 backend/api-helper.js 中默认提示词保持同步；角色编辑页展示/重置用 */

export const DEFAULT_SELFIE_STYLE_REAL = [
  'photorealistic real phone photo of a real human',
  'natural skin pores, no plastic CGI skin',
  'ordinary camera-roll snapshot, natural light',
  'not 3D render, not Unreal/Blender, not doll, not anime illustration',
  'no beauty filter, no lens distortion or stretched face',
].join(', ');

export const DEFAULT_SELFIE_STYLE_ANIME = [
  'anime 2D illustration, clean lineart, soft cel shading',
  'casual phone-photo framing, expressive eyes',
  'soft gentle smile if smiling, no exaggerated wide grin',
].join(', ');

export const DEFAULT_VIDEO_MOTION_PROMPT = [
  'short handheld phone video that starts from this still as the first frame',
  'subtle natural motion only: breathing, soft hair or cloth, tiny camera drift',
  'keep the still-image mood and expression',
  'no cinematic grading, no beauty filter, no face warp',
  'no speech or singing; soft ambient sound only',
].join('. ');

export function getDefaultSelfieStylePrompt(imageStyle) {
  return imageStyle === 'real' ? DEFAULT_SELFIE_STYLE_REAL : DEFAULT_SELFIE_STYLE_ANIME;
}
