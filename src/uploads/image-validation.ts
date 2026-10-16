import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES = 8;
/** Shared by all image-reference mutations and filesystem cleanup. */
export const IMAGE_WRITE_LOCK = 731628451;

const LOCAL_KEY =
  /^products\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function isLocalImageKey(value: string): boolean {
  return LOCAL_KEY.test(value);
}

export type ImageExtension = 'jpg' | 'png' | 'webp';

function validPng(data: Buffer): boolean {
  if (
    data.length < 57 ||
    !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    return false;
  }
  let offset = 8;
  let header = false;
  let pixels = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > data.length) return false;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    // Check the chunk CRC as well as its bounds, so truncated/corrupted uploads
    // cannot pass merely by starting with the PNG magic bytes.
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index++) {
      crc ^= data[index];
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    if ((crc ^ 0xffffffff) >>> 0 !== data.readUInt32BE(end - 4)) {
      return false;
    }
    if (!header) {
      if (type !== 'IHDR' || length !== 13) return false;
      const depth = data[offset + 16];
      const color = data[offset + 17];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        data.readUInt32BE(offset + 8) === 0 ||
        data.readUInt32BE(offset + 12) === 0 ||
        !depths[color]?.includes(depth) ||
        data[offset + 18] !== 0 ||
        data[offset + 19] !== 0 ||
        data[offset + 20] > 1
      ) {
        return false;
      }
      header = true;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT' && length > 0) pixels = true;
    if (type === 'IEND') return length === 0 && pixels && end === data.length;
    offset = end;
  }
  return false;
}

function validJpeg(data: Buffer): boolean {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return false;
  let offset = 2;
  let frame = false;
  let scan = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) return frame && scan && offset === data.length;
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      marker === 1 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      offset + 2 > data.length
    ) {
      return false;
    }
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return false;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (
        length < 11 ||
        ![8, 12, 16].includes(data[offset + 2]) ||
        data.readUInt16BE(offset + 3) === 0 ||
        data.readUInt16BE(offset + 5) === 0 ||
        data[offset + 7] === 0 ||
        length !== 8 + 3 * data[offset + 7]
      ) {
        return false;
      }
      frame = true;
    }
    if (marker === 0xda) {
      if (
        !frame ||
        length < 8 ||
        data[offset + 2] === 0 ||
        length !== 6 + 2 * data[offset + 2]
      ) {
        return false;
      }
      scan = true;
      offset += length;
      const start = offset;
      while (offset < data.length) {
        if (data[offset] !== 0xff) {
          offset++;
          continue;
        }
        const next = data[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
        } else if (next === 0xff) {
          offset++;
        } else {
          break;
        }
      }
      if (offset === start) return false;
    } else {
      offset += length;
    }
  }
  return false;
}

function validWebpPixels(type: string, data: Buffer): boolean {
  if (type === 'VP8L') return data.length >= 5 && data[0] === 0x2f;
  return (
    type === 'VP8 ' &&
    data.length >= 10 &&
    (data[0] & 1) === 0 &&
    data.subarray(3, 6).equals(Buffer.from('9d012a', 'hex')) &&
    (data.readUInt16LE(6) & 0x3fff) > 0 &&
    (data.readUInt16LE(8) & 0x3fff) > 0
  );
}

function validWebp(data: Buffer): boolean {
  if (
    data.length < 26 ||
    data.toString('ascii', 0, 4) !== 'RIFF' ||
    data.toString('ascii', 8, 12) !== 'WEBP' ||
    data.readUInt32LE(4) + 8 !== data.length
  ) {
    return false;
  }
  let offset = 12;
  let pixels = false;
  while (offset + 8 <= data.length) {
    const type = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end + (length % 2) > data.length) return false;
    const payload = data.subarray(offset + 8, end);
    if (type === 'VP8 ' || type === 'VP8L') {
      if (!validWebpPixels(type, payload)) return false;
      pixels = true;
    } else if (type === 'VP8X' && length !== 10) {
      return false;
    } else if (type === 'ANMF') {
      // Animation frames contain a 16-byte frame header and ordinary chunks.
      let frameOffset = 16;
      let framePixels = false;
      while (frameOffset + 8 <= payload.length) {
        const frameType = payload.toString(
          'ascii',
          frameOffset,
          frameOffset + 4,
        );
        const frameLength = payload.readUInt32LE(frameOffset + 4);
        const frameEnd = frameOffset + 8 + frameLength;
        if (frameEnd + (frameLength % 2) > payload.length) return false;
        if (frameType === 'VP8 ' || frameType === 'VP8L') {
          if (
            !validWebpPixels(
              frameType,
              payload.subarray(frameOffset + 8, frameEnd),
            )
          ) {
            return false;
          }
          framePixels = true;
        }
        frameOffset = frameEnd + (frameLength % 2);
      }
      if (!framePixels || frameOffset !== payload.length) return false;
      pixels = true;
    }
    offset = end + (length % 2);
  }
  return pixels && offset === data.length;
}

/** Inspect bytes, never the original filename or the client-provided MIME type. */
export function validateImage(file: Express.Multer.File): ImageExtension {
  if (
    file.size > MAX_IMAGE_BYTES ||
    (Buffer.isBuffer(file.buffer) && file.buffer.length > MAX_IMAGE_BYTES)
  ) {
    throw new PayloadTooLargeException('Each image must be 5 MB or smaller');
  }
  if (Buffer.isBuffer(file.buffer) && file.buffer.length > 0) {
    if (validJpeg(file.buffer)) return 'jpg';
    if (validPng(file.buffer)) return 'png';
    if (validWebp(file.buffer)) return 'webp';
  }
  throw new BadRequestException(
    'Images must contain a valid JPEG, PNG, or WebP image',
  );
}

export function validateBatch(files: Express.Multer.File[]): void {
  if (!Array.isArray(files) || files.length === 0) {
    throw new BadRequestException('At least one image is required');
  }
  if (files.length > MAX_PRODUCT_IMAGES) {
    throw new BadRequestException('A product can have at most 8 images');
  }
  for (const file of files) validateImage(file);
}
