// Original synthetic two-pixel grayscale JPEG: DC=0, AC=EOB, unit quantization.
// Both frames decode to uniform gray; no EXIF, accounts, user images or external files.
const segment = (marker, data) => {
  const header = Buffer.from([0xff, marker, 0, 0]); header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, Buffer.from(data)]);
};
function jpeg({ progressive = false, width = 2, height = 2 } = {}) {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3);
  const table = kind => [kind, 1, ...Array(15).fill(0), 0];
  const scans = progressive
    ? [segment(0xda, [1, 1, 0, 0, 0, 0]), Buffer.from([0x7f]), segment(0xda, [1, 1, 0, 1, 63, 0]), Buffer.from([0x7f])]
    : [segment(0xda, [1, 1, 0, 0, 63, 0]), Buffer.from([0x3f])];
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xdb, [0, ...Array(64).fill(1)]),
    segment(progressive ? 0xc2 : 0xc0, frame), segment(0xc4, [...table(0), ...table(0x10)]), ...scans, Buffer.from([0xff, 0xd9])]);
}
module.exports = { jpeg };
