import { API_BASE } from './config';

export async function convertImages(opts) {
  const {
    files,
    to = 'webp',
    quality = null,
    lossless = false,
    progressive = false,
    keep_metadata = false,
    to_srgb = false,
    width = null,
    height = null,
    fit = true,
    rotate_deg = 0,
    crop = { x: null, y: null, w: null, h: null },
    bg = null,
  } = opts;

  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('to', to);
  if (quality !== null) fd.append('quality', String(quality));
  fd.append('lossless', String(lossless));
  fd.append('progressive', String(progressive));
  fd.append('keep_metadata', String(keep_metadata));
  fd.append('to_srgb', String(to_srgb));
  if (width !== null) fd.append('width', String(width));
  if (height !== null) fd.append('height', String(height));
  fd.append('fit', String(fit));
  fd.append('rotate_deg', String(rotate_deg));
  if (crop?.x !== null) fd.append('crop_x', String(crop.x));
  if (crop?.y !== null) fd.append('crop_y', String(crop.y));
  if (crop?.w !== null) fd.append('crop_w', String(crop.w));
  if (crop?.h !== null) fd.append('crop_h', String(crop.h));
  if (bg) fd.append('bg', bg);

  const res = await fetch(`${API_BASE}/convert`, { method: 'POST', body: fd });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const isZip = res.headers.get('content-type')?.includes('zip');
  const filename = filenameFromCD(res.headers.get('content-disposition')) || (isZip ? 'converted_images.zip' : `converted.${to}`);
  return { blob, filename };
}

function filenameFromCD(cd) {
  if (!cd) return null;
  const m = /filename=\"?([^\";]+)\"?/i.exec(cd);
  return m ? m[1] : null;
}
