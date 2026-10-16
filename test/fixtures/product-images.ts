/** Complete one-pixel images; JPEG/WebP encoded by libvips. No runtime decoder needed. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
export const JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCgAUU1/9k=',
  'base64',
);
export const WEBP = Buffer.from(
  'UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoBAAEAAUAmJaACdLoB+AAF9AAA/ccf+Uq8FjdHn/2Vj6Vj6Vj9egAA',
  'base64',
);

export function imageFile(buffer = PNG): Express.Multer.File {
  return {
    buffer,
    size: buffer.length,
    originalname: '../../untrusted.svg',
    mimetype: 'image/svg+xml',
    fieldname: 'images',
  } as Express.Multer.File;
}
