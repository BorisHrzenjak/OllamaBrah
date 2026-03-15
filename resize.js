const Jimp = require('jimp');
const fs = require('fs');

async function processIcon() {
  const image = await Jimp.read('assets/icon128.png');
  const w = image.bitmap.width; // 821
  const h = image.bitmap.height; // 828
  
  const size = Math.max(w, h);
  
  new Jimp(size, size, 0x00000000, async (err, bg) => {
    const x = Math.floor((size - w) / 2);
    const y = Math.floor((size - h) / 2);
    bg.composite(image, x, y);
    bg.resize(256, 256);
    await bg.writeAsync('assets/icon.png');
    console.log('Icon successfully written to assets/icon.png');
  });
}

processIcon().catch(console.error);
